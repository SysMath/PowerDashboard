import { backupDeletionBlocked } from "@gamedashboard/contracts";
import { backups, type Database, servers } from "@gamedashboard/db";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { DATABASE } from "../../common/database.provider";
import { S3Service } from "../storage/s3.service";
import { WingsClientService, WingsUnavailableError } from "../wings/wings-client.service";
import { WingsTokenService } from "../wings/wings-token.service";

/** Intervalle de relecture d'une sauvegarde attendue. */
const BACKUP_POLL_MS = 3000;

export interface ClientBackup {
  id: string;
  name: string;
  bytes: number;
  checksum: string | null;
  /** `null` tant que le daemon n'a pas rendu compte : la sauvegarde est en cours. */
  isSuccessful: boolean | null;
  isLocked: boolean;
  createdAt: string;
  completedAt: string | null;
}

/**
 * Sauvegardes d'un serveur.
 *
 * Le panel tient le registre, le daemon fait le travail. Les deux moitiés
 * doivent rester cohérentes, et c'est tout l'enjeu : une ligne en base sans
 * archive sur le disque est un mensonge qui ne se découvre qu'au moment d'une
 * restauration — c'est-à-dire au pire moment possible.
 */
@Injectable()
export class BackupsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(WingsClientService) private readonly wings: WingsClientService,
    @Inject(WingsTokenService) private readonly tokens: WingsTokenService,
    @Inject(S3Service) private readonly s3: S3Service,
  ) {}

  /**
   * Adresse de téléchargement d'une archive.
   *
   * **Le panel ne relaie jamais les octets.** Il rend une adresse que le
   * navigateur suit lui-même : signée par le compartiment pour une sauvegarde
   * distante, signée pour le daemon quand l'archive est restée sur son disque.
   * Faire transiter plusieurs gigaoctets par le panel en ferait un goulot
   * d'étranglement, pour un fichier qu'il n'a aucune raison de lire.
   *
   * Les deux adresses sont **brèves et à usage étroit**, parce qu'elles
   * donnent accès à l'archive sans authentification : un quart d'heure côté
   * compartiment, une minute et un seul usage côté daemon.
   *
   * Une sauvegarde en cours ou ratée est refusée : il n'y a rien de lisible au
   * bout, et servir un lien vers une archive tronquée ferait restaurer des
   * données incomplètes.
   */
  async downloadUrl(serverId: string, backupId: string, userId: string): Promise<string> {
    const backup = await this.mustFind(serverId, backupId);
    if (backup.isSuccessful !== true) {
      throw new ConflictException("Cette sauvegarde n'est pas terminée, ou a échoué.");
    }

    if (backup.disk === "s3") return this.remoteUrl(serverId, backupId);

    return this.tokens.backupDownloadGrant(serverId, backupId, userId);
  }

  async list(serverId: string): Promise<ClientBackup[]> {
    const rows = await this.db
      .select()
      .from(backups)
      .where(eq(backups.serverId, serverId))
      .orderBy(desc(backups.createdAt));

    return rows.map(project);
  }

  /** Quota, pour l'afficher sans avoir à recompter côté interface. */
  async quota(serverId: string): Promise<{ used: number; limit: number }> {
    const [[used], [server]] = await Promise.all([
      this.db.select({ n: count() }).from(backups).where(eq(backups.serverId, serverId)),
      this.db.select({ limit: servers.backupLimit }).from(servers).where(eq(servers.id, serverId)),
    ]);
    return { used: used?.n ?? 0, limit: server?.limit ?? 0 };
  }

  /**
   * Lance une sauvegarde.
   *
   * L'ordre est imposé par le contrat du daemon : la ligne est créée d'abord,
   * puisque c'est nous qui fournissons l'identifiant dont Wings se servira pour
   * rendre compte. Si le daemon refuse, la ligne est **retirée** — sans cela,
   * elle resterait indéfiniment « en cours », consommerait le quota, et ne
   * pourrait jamais être supprimée puisqu'aucune archive ne lui correspond.
   */
  async create(serverId: string, name: string, ignore: string[]): Promise<ClientBackup> {
    /*
     * Le lieu de l'archive se décide ici, une fois pour toutes : le
     * compartiment dès qu'il est réglé, le disque du node sinon. `disk` le
     * retient, parce que le téléchargement, la restauration et la suppression
     * en dépendent — un réglage changé plus tard ne doit pas faire chercher
     * l'archive là où elle n'est pas.
     *
     * Longtemps, l'adaptateur local partait même avec un compartiment réglé :
     * les sauvegardes mouraient avec la machine qu'elles protégeaient, alors
     * que l'écran des paramètres promettait le contraire.
     *
     * Lu avant la transaction : c'est un réglage, pas une donnée dont dépend
     * le quota, et le lire sous verrou retiendrait les autres demandes pour
     * rien.
     */
    const disk = (await this.s3.isConfigured()) ? "s3" : "local";

    const row = await this.db.transaction(async (tx) => {
      /*
       * Le quota est compté **sous verrou**, dans la transaction qui écrit.
       *
       * Compté puis écrit en deux temps, il laissait passer N demandes
       * simultanées à `limite - 1` : toutes lisaient le même compte avant
       * qu'aucune n'insère. La ligne du serveur est verrouillée le temps de
       * compter et d'insérer, comme pour les bases de données ; la suivante
       * attend, recompte, et se voit refuser.
       */
      const [server] = await tx
        .select({ limit: servers.backupLimit })
        .from(servers)
        .where(eq(servers.id, serverId))
        .for("update");
      const [compte] = await tx
        .select({ n: count() })
        .from(backups)
        .where(eq(backups.serverId, serverId));
      const used = compte?.n ?? 0;
      const limit = server?.limit ?? 0;
      if (used >= limit) {
        throw new ConflictException(
          limit === 0
            ? "Ce serveur n'a pas de quota de sauvegardes."
            : `Quota atteint (${used}/${limit}). Supprimez une sauvegarde avant d'en créer une autre.`,
        );
      }

      const [inserted] = await tx
        .insert(backups)
        .values({ serverId, name: name.trim(), ignoredFiles: ignore, disk })
        .returning();
      return inserted;
    });

    if (!row) throw new BadRequestException("Sauvegarde non enregistrée.");

    try {
      // `wings` : le nom que le daemon donne à son adaptateur local.
      await this.wings.createBackup(serverId, row.id, ignore, disk === "s3" ? "s3" : "wings");
    } catch (error) {
      await this.db.delete(backups).where(eq(backups.id, row.id));
      throw error;
    }

    return project(row);
  }

  /**
   * Attend qu'une sauvegarde soit close, et refuse si elle a échoué.
   *
   * Pour une sauvegarde **préalable** (avant un changement de moteur) : ce
   * qui suit écrase des fichiers, et le faire pendant que le daemon archive
   * donnerait une archive à moitié de l'ancien état, à moitié du nouveau. Le
   * compte rendu du daemon (`/api/remote/backups/:id`) remplit
   * `is_successful` ; on le relit jusqu'à ce qu'il le soit.
   *
   * `pause` est injectable pour les tests, qui n'attendent pas.
   */
  async awaitCompletion(
    serverId: string,
    backupId: string,
    timeoutMs: number,
    pause: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const [row] = await this.db
        .select({ isSuccessful: backups.isSuccessful })
        .from(backups)
        .where(and(eq(backups.id, backupId), eq(backups.serverId, serverId)))
        .limit(1);
      if (!row)
        throw new ConflictException("La sauvegarde préalable a disparu : rien n'a été modifié.");
      if (row.isSuccessful === true) return;
      if (row.isSuccessful === false) {
        throw new ConflictException("La sauvegarde préalable a échoué : rien n'a été modifié.");
      }
      if (Date.now() >= deadline) {
        throw new ConflictException(
          "La sauvegarde préalable n'est pas terminée dans le délai : rien n'a été modifié. Réessayez une fois la sauvegarde close.",
        );
      }
      await pause(BACKUP_POLL_MS);
    }
  }

  /**
   * Supprime une sauvegarde, archive comprise.
   *
   * L'archive part en premier : effacer la ligne d'abord ferait perdre la
   * seule référence à l'archive, qui occuperait le disque du node — ou le
   * compartiment, facturée — sans plus apparaître nulle part.
   *
   * Une sauvegarde verrouillée est refusée ici et non seulement dans
   * l'interface : le verrou n'a de valeur que s'il tient face à un appel direct.
   */
  async remove(serverId: string, backupId: string): Promise<void> {
    const backup = await this.mustFind(serverId, backupId);
    if (backup.isLocked) {
      throw new ConflictException("Cette sauvegarde est verrouillée. Déverrouillez-la d'abord.");
    }
    // Pendant une restauration, l'archive rendue ne doit pas disparaître : le
    // compte rendu de fin de Wings trouverait un 404 et le serveur resterait
    // bloqué (voir `backupDeletionBlocked`).
    const [server] = await this.db
      .select({ state: servers.state })
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);
    if (backupDeletionBlocked(server?.state)) {
      throw new ConflictException(
        "Une restauration est en cours sur ce serveur. Attendez qu'elle se termine pour supprimer une sauvegarde.",
      );
    }

    if (backup.disk === "s3") {
      // Une archive distante ne regarde pas le daemon : il ne supprime que ce
      // qu'il a sur son disque, et répondrait 404. Le panel l'efface lui-même.
      await this.s3.discard(await this.s3.keyFor(serverId, backupId), backup.uploadId);
    } else {
      try {
        await this.wings.deleteBackup(serverId, backupId);
      } catch (error) {
        /*
         * 404 : le node n'a pas cette archive. Sauvegarde ratée avant d'écrire,
         * machine réinstallée, ou serveur déplacé depuis — une archive locale
         * reste sur le node de départ. Refuser laissait une ligne impossible à
         * supprimer, qui occupait le quota pour toujours.
         */
        if (!(error instanceof WingsUnavailableError && error.isNotFound)) throw error;
      }
    }

    await this.db.delete(backups).where(eq(backups.id, backupId));
  }

  async setLocked(serverId: string, backupId: string, locked: boolean): Promise<ClientBackup> {
    await this.mustFind(serverId, backupId);
    const [row] = await this.db
      .update(backups)
      .set({ isLocked: locked })
      .where(eq(backups.id, backupId))
      .returning();

    if (!row) throw new NotFoundException("Sauvegarde introuvable.");
    return project(row);
  }

  /**
   * Restaure une sauvegarde sur le serveur.
   *
   * Une sauvegarde encore en cours ou ratée est refusée : restaurer une archive
   * incomplète écraserait des données valides par des données tronquées, et
   * c'est irréversible.
   *
   * Le serveur passe à l'état `restoring` pendant l'opération (NC-44) : le
   * panel refuse alors le démarrage, le gestionnaire de fichiers et le SFTP
   * (`SftpAuthService`), au lieu de s'en remettre au seul drapeau de Wings.
   * Trois issues le relâchent : le compte rendu de Wings
   * (`POST /backups/:uuid/restore`, envoyé en fin de restauration, réussie ou
   * non), un refus du daemon ici même, et le redémarrage du daemon
   * (`resetTransientStates`).
   */
  async restore(serverId: string, backupId: string, truncate: boolean): Promise<void> {
    const backup = await this.mustFind(serverId, backupId);
    if (backup.isSuccessful !== true) {
      throw new ConflictException(
        backup.isSuccessful === null
          ? "Cette sauvegarde est encore en cours."
          : "Cette sauvegarde a échoué et ne peut pas être restaurée.",
      );
    }

    // Une archive distante, Wings la télécharge lui-même par un lien signé :
    // il n'a pas les identifiants du compartiment.
    const downloadUrl = backup.disk === "s3" ? await this.remoteUrl(serverId, backupId) : undefined;

    // Pris seulement sur un serveur sans état : une installation, un transfert
    // ou une suspension arrivés depuis le contrôle de la route gardent la main.
    const [claimed] = await this.db
      .update(servers)
      .set({ state: "restoring", updatedAt: new Date().toISOString() })
      .where(and(eq(servers.id, serverId), isNull(servers.state)))
      .returning({ id: servers.id });
    if (!claimed) {
      throw new ConflictException(
        "Ce serveur est occupé par une autre opération. Réessayez quand elle sera terminée.",
      );
    }

    try {
      await this.wings.restoreBackup(serverId, backupId, truncate, downloadUrl);
    } catch (error) {
      // Refusée par le daemon, la restauration n'a pas commencé : aucun
      // compte rendu ne viendra relâcher l'état.
      await this.db
        .update(servers)
        .set({ state: null, updatedAt: new Date().toISOString() })
        .where(and(eq(servers.id, serverId), eq(servers.state, "restoring")));
      throw error;
    }
  }

  /**
   * Lien signé vers une archive distante.
   *
   * Le stockage distant a pu être retiré des réglages depuis le dépôt : dire
   * que l'archive est inaccessible vaut mieux qu'une adresse qui mènera à une
   * erreur du compartiment.
   */
  private async remoteUrl(serverId: string, backupId: string): Promise<string> {
    const url = await this.s3.presignDownload(await this.s3.keyFor(serverId, backupId));
    if (!url) throw new ConflictException("Le stockage distant n'est plus configuré.");
    return url;
  }

  /**
   * Retrouve une sauvegarde **de ce serveur**.
   *
   * L'identifiant du serveur fait partie de la condition, et n'est pas
   * seulement vérifié après coup : sans cela, quelqu'un ayant le droit de
   * supprimer des sauvegardes sur son propre serveur pourrait supprimer celles
   * d'un autre en changeant un identifiant dans l'URL.
   */
  private async mustFind(serverId: string, backupId: string) {
    const [row] = await this.db
      .select()
      .from(backups)
      .where(and(eq(backups.id, backupId), eq(backups.serverId, serverId)))
      .limit(1);

    if (!row) throw new NotFoundException("Sauvegarde introuvable.");
    return row;
  }
}

function project(row: typeof backups.$inferSelect): ClientBackup {
  return {
    id: row.id,
    name: row.name,
    bytes: row.bytes,
    checksum: row.checksum,
    isSuccessful: row.isSuccessful,
    isLocked: row.isLocked,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}
