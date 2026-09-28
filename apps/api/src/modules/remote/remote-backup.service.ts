import { backups, type Database, servers } from "@gamedashboard/db";
import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, eq, isNull, lt } from "drizzle-orm";
import { DATABASE } from "../../common/database.provider";
import { ActivityService } from "../activity/activity.service";
import { NotificationsService } from "../notifications/notifications.service";
import { S3Service } from "../storage/s3.service";

/** Compte rendu envoyé par Wings à la fin d'une sauvegarde. */
export interface BackupReport {
  checksum?: string;
  checksum_type?: string;
  size?: number;
  successful?: boolean;
  /**
   * Empreintes des parties déposées, pour un dépôt fractionné S3.
   *
   * Le daemon les rapporte parce qu'il ne peut pas clore le dépôt lui-même : il
   * n'a pas nos identifiants, seulement des adresses signées. Absent pour une
   * sauvegarde locale.
   */
  parts?: { etag?: string; part_number?: number }[];
}

/**
 * Au-delà, une restauration sans compte rendu est tenue pour perdue.
 *
 * Wings ne rejoue le compte rendu de fin qu'une trentaine de secondes, et
 * seulement sur une 5xx ou une erreur réseau : un panel en mise à jour ou une
 * coupure entre le node et le panel suffisent à le perdre, et le serveur
 * resterait en `restoring` jusqu'au prochain redémarrage du daemon. Six heures
 * laissent passer la restauration d'une grosse archive distante. Lever l'état
 * trop tôt n'expose pas les fichiers : Wings garde son propre drapeau de
 * restauration et refuse le démarrage comme le SFTP tant qu'il restaure.
 */
export const RESTORE_STALE_MS = 6 * 60 * 60 * 1000;

/**
 * Enregistrement des comptes rendus de sauvegarde.
 *
 * C'est le seul endroit où une sauvegarde cesse d'être « en cours ». Le panel
 * ne le décide jamais de lui-même : il ne sait pas si l'archive a été écrite,
 * seul le daemon le sait.
 */
@Injectable()
export class RemoteBackupService {
  private readonly logger = new Logger(RemoteBackupService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Inject(S3Service) private readonly s3: S3Service,
    @Inject(ActivityService) private readonly activity: ActivityService,
  ) {}

  /**
   * Ouvre un dépôt distant et rend les adresses signées au daemon.
   *
   * Appelée par Wings juste avant d'envoyer l'archive, avec la taille qu'il
   * vient de mesurer. Rend `null` quand le stockage distant n'est plus
   * configuré : la sauvegarde échoue alors (voir la route, dans
   * `RemoteController`).
   *
   * L'identifiant du dépôt est retenu en base, car lui seul permettra de
   * recoller les morceaux — ou de les jeter. Le daemon ne le connaît pas.
   *
   * **Seulement pour une sauvegarde en cours, et distante dès sa création.**
   * Sans ces deux conditions, un node compromis rouvrait le dépôt d'une
   * sauvegarde terminée et en écrasait l'archive — restaurée plus tard, en
   * confiance, sur un node sain — ou basculait sur le compartiment une
   * sauvegarde locale. Wings ne demande d'adresses que pour l'adaptateur
   * `s3`, que `BackupsService.create` choisit en même temps qu'il fixe
   * `disk` : rien de légitime ne passe hors de ces conditions. Le refus est
   * un 404, définitif pour le daemon, qui rend alors compte d'un échec.
   */
  async openUpload(
    nodeId: string,
    backupId: string,
    size: number,
  ): Promise<{ parts: string[]; part_size: number } | null> {
    const [row] = await this.db
      .select({ id: backups.id, serverId: backups.serverId, uploadId: backups.uploadId })
      .from(backups)
      .innerJoin(servers, eq(backups.serverId, servers.id))
      .where(
        and(
          eq(backups.id, backupId),
          eq(servers.nodeId, nodeId),
          isNull(backups.completedAt),
          eq(backups.disk, "s3"),
        ),
      )
      .limit(1);

    if (!row) throw new NotFoundException("Sauvegarde introuvable.");

    /*
     * Un dépôt déjà ouvert est abandonné avant d'en ouvrir un autre.
     *
     * Wings redemande des adresses quand il reprend une sauvegarde après un
     * redémarrage. Sans cet abandon, les morceaux du premier essai resteraient
     * dans le compartiment, facturés et invisibles dans la liste des objets.
     */
    const key = await this.s3.keyFor(row.serverId, row.id);
    if (row.uploadId) await this.s3.abortUpload(key, row.uploadId);

    const ticket = await this.s3.openUpload(key, size);
    if (!ticket) return null;

    // `disk` n'est plus écrit ici : il vaut déjà `s3`, et c'est la condition
    // pour arriver jusque-là.
    await this.db
      .update(backups)
      .set({ uploadId: ticket.uploadId, updatedAt: new Date().toISOString() })
      .where(and(eq(backups.id, backupId), isNull(backups.completedAt)));

    return { parts: ticket.parts, part_size: ticket.partSize };
  }

  /**
   * Fin d'une restauration, rapportée par Wings (NC-44).
   *
   * Relâche l'état `restoring` posé par `BackupsService.restore`, et lui seul :
   * une suspension décidée entre-temps n'est pas levée par le daemon. La
   * sauvegarde doit appartenir à un serveur **de ce node**, comme pour la
   * clôture : un autre node ne rend pas la main sur un serveur qu'il n'héberge
   * pas.
   */
  async restored(nodeId: string, backupId: string, successful: boolean): Promise<void> {
    const [row] = await this.db
      .select({ serverId: backups.serverId })
      .from(backups)
      .innerJoin(servers, eq(backups.serverId, servers.id))
      .where(and(eq(backups.id, backupId), eq(servers.nodeId, nodeId)))
      .limit(1);

    if (!row) throw new NotFoundException("Sauvegarde introuvable.");

    const released = await this.db
      .update(servers)
      .set({ state: null, updatedAt: new Date().toISOString() })
      .where(and(eq(servers.id, row.serverId), eq(servers.state, "restoring")))
      .returning({ id: servers.id });

    // L'issue au journal du serveur, comme la demande (`backup.restore`) :
    // sans elle, un échec ne laissait qu'une ligne dans le journal du panel.
    // Une fois seulement, quand l'état est effectivement relâché : un compte
    // rendu rejoué ou tardif n'ajoute rien.
    if (released.length === 0) return;
    if (!successful) {
      this.logger.warn(`Restauration de ${backupId} sur ${row.serverId} échouée, selon le daemon.`);
    }
    await this.activity.record({
      event: successful ? "backup.restore_completed" : "backup.restore_failed",
      serverId: row.serverId,
      actorId: null,
      actorType: "system",
      actorLabel: "Daemon",
      properties: { backupId },
    });
  }

  /**
   * Relâche les restaurations restées sans compte rendu (`RESTORE_STALE_MS`).
   *
   * L'horloge est `servers.updated_at`, posé par `BackupsService.restore` au
   * moment où il prend l'état. Rend le nombre de serveurs relâchés.
   */
  async expireStaleRestores(now: Date = new Date()): Promise<number> {
    const threshold = new Date(now.getTime() - RESTORE_STALE_MS).toISOString();
    const released = await this.db
      .update(servers)
      .set({ state: null, updatedAt: now.toISOString() })
      .where(and(eq(servers.state, "restoring"), lt(servers.updatedAt, threshold)))
      .returning({ id: servers.id });
    for (const { id } of released) {
      this.logger.warn(`Restauration sur ${id} sans compte rendu depuis six heures : état levé.`);
    }
    return released.length;
  }

  /**
   * Clôt une sauvegarde.
   *
   * La sauvegarde doit appartenir à un serveur **de ce node**. Sans cette
   * condition, un node compromis pourrait marquer réussie une sauvegarde
   * hébergée ailleurs — et la faire restaurer plus tard depuis une archive qui
   * n'existe pas, ou qu'il aurait lui-même fabriquée.
   *
   * **Une sauvegarde close ne se rouvre pas.** Le premier compte rendu fait
   * foi ; un second n'y change rien — ni l'issue, ni la taille, ni
   * l'empreinte. Sans cela, un node compromis faisait passer pour réussie une
   * sauvegarde ratée, ou l'inverse, à n'importe quel moment après coup.
   *
   * Ce second compte rendu reçoit pourtant un 204, et non un 404. Le cas
   * ordinaire est un accusé de réception perdu, que Wings rejoue ; or un
   * refus lui fait **effacer l'archive** (`server/backup.go`, après l'échec
   * de `notifyPanelOfBackup`), celle-là même que le panel vient de déclarer
   * réussie. Ignorer sans refuser ne donne rien au node compromis, et ne
   * coûte rien au node sain.
   */
  async complete(nodeId: string, backupId: string, report: BackupReport): Promise<void> {
    const [row] = await this.db
      .select({
        id: backups.id,
        serverId: backups.serverId,
        name: backups.name,
        uploadId: backups.uploadId,
        completedAt: backups.completedAt,
      })
      .from(backups)
      .innerJoin(servers, eq(backups.serverId, servers.id))
      .where(and(eq(backups.id, backupId), eq(servers.nodeId, nodeId)))
      .limit(1);

    if (!row) throw new NotFoundException("Sauvegarde introuvable.");
    if (row.completedAt !== null) {
      this.logger.warn(`Compte rendu ignoré : la sauvegarde ${row.id} est déjà close.`);
      return;
    }

    let successful = report.successful === true;

    /*
     * Un dépôt fractionné se clôt **ici**, et il se clôt toujours.
     *
     * Réussi, on recolle les morceaux ; raté, on les jette. Ne rien faire
     * laisserait un dépôt ouvert dont les parties restent facturées sans
     * apparaître dans la liste des objets — une fuite qu'on ne découvre qu'à
     * la facture.
     *
     * Et si le recollage échoue, la sauvegarde devient un **échec**, quoi
     * qu'ait dit le daemon : de son point de vue tout est parti, mais aucune
     * archive n'est lisible au bout. L'annoncer réussie promettrait une
     * restauration impossible, ce qui est la pire chose qu'un système de
     * sauvegarde puisse faire.
     */
    if (row.uploadId) {
      const key = await this.s3.keyFor(row.serverId, row.id);

      if (successful) {
        const parts = (report.parts ?? []).map((part) => ({
          etag: typeof part.etag === "string" ? part.etag : "",
          partNumber: typeof part.part_number === "number" ? part.part_number : 0,
        }));
        successful = await this.s3.completeUpload(key, row.uploadId, parts);
      } else {
        await this.s3.abortUpload(key, row.uploadId);
      }
    }

    const [closed] = await this.db
      .update(backups)
      .set({
        isSuccessful: successful,
        // Une taille et une empreinte ne sont retenues que d'une sauvegarde
        // réussie : celles d'un échec décriraient une archive tronquée, et
        // laisseraient croire qu'il y a quelque chose à restaurer.
        bytes: successful ? Math.max(0, Math.trunc(report.size ?? 0)) : 0,
        checksum: successful ? (report.checksum ?? null) : null,
        completedAt: new Date().toISOString(),
        // Le dépôt est clos, dans un sens ou dans l'autre : garder son
        // identifiant ferait tenter un second abandon au prochain passage.
        uploadId: null,
        updatedAt: new Date().toISOString(),
      })
      // Deux comptes rendus simultanés passent tous deux la lecture : seul le
      // premier écrit. Le second ne doit ni réécrire l'issue ni notifier — son
      // propre recollage a pu échouer, faute de dépôt encore ouvert.
      .where(and(eq(backups.id, backupId), isNull(backups.completedAt)))
      .returning({ id: backups.id });

    if (!closed) return;

    /**
     * Seul un échec vaut une cloche.
     *
     * Une sauvegarde réussie est ce que le client attend : le lui annoncer à
     * chaque nuit noierait la cloche, et la prochaine notification vraiment
     * importante passerait inaperçue. Un échec, lui, demande une action.
     */
    if (!successful) {
      await this.notifications.notifyServerOwner(row.serverId, {
        type: "backup.failed",
        level: "danger",
        title: "Sauvegarde échouée",
        // Le nom est repris tel quel : sans lui, quelqu'un qui en planifie
        // plusieurs ne sait pas laquelle a échoué. Il manquait.
        body: `La sauvegarde « ${row.name} » ne s'est pas terminée. Vérifiez l'espace disque du serveur, et le stockage distant s'il est configuré.`,
      });
    }
  }
}
