import {
  SFTP_INVALID_CREDENTIALS_STATUS,
  SftpAuthRequest,
  type SftpAuthResponse,
  WINGS_REMOTE_PREFIX,
  WingsBackupReport,
  type WingsInstallationScript,
  type WingsInstallStatus,
  type WingsServerListResponse,
} from "@gamedashboard/contracts";
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Logger,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import { ServerTransferService } from "../admin/server-transfer.service";
import type { NodeIdentity } from "./node.repository";
import { NodeRepository } from "./node.repository";
import { NodeTokenGuard } from "./node-token.guard";
import { RemoteActivityService, type WingsActivity } from "./remote-activity.service";
import { type BackupReport, RemoteBackupService } from "./remote-backup.service";
import { RemoteServerService } from "./remote-server.service";
import { SftpAuthService } from "./sftp-auth.service";
import { WingsErrorFilter } from "./wings-error.filter";

/**
 * Identifiant de serveur ou de sauvegarde, contrôlé avant d'atteindre la base.
 *
 * Sans lui, `servers/pas-un-uuid` arrivait jusqu'à PostgreSQL, qui refusait la
 * conversion : une 500, que Wings prend pour une panne passagère et rejoue
 * avec temporisation. Un identifiant illisible ne le deviendra jamais — 400,
 * définitif pour le daemon, et au format de `WingsErrorFilter` comme toute
 * erreur de ce contrôleur : le filtre attrape aussi ce que lèvent les pipes.
 */
const REMOTE_UUID = new ParseUUIDPipe({
  exceptionFactory: () => new BadRequestException("Identifiant mal formé : un UUID est attendu."),
});

/** Taille de page maximale de l'inventaire, quelle que soit la demande du daemon. */
const MAX_SERVERS_PER_PAGE = 500;

interface RemoteRequest {
  /** Posé par `NodeTokenGuard` : le node authentifié, jamais un identifiant du corps. */
  node: NodeIdentity;
}

/**
 * Routes servies au daemon Wings (§7.5 du plan).
 *
 * Le préfixe n'a pas de numéro de version, contrairement à `/api/v1` ailleurs :
 * Wings construit son URL de base en concaténant l'adresse du panel et
 * `/api/remote`, ce que nous ne pouvons pas changer.
 *
 * Aucune route ne lit d'identifiant de node dans son corps ou son URL : le node
 * vient du jeton vérifié. Sans cela, un node compromis pourrait piloter les
 * serveurs d'un autre en changeant un champ.
 */
@Controller(WINGS_REMOTE_PREFIX.replace(/^\//, ""))
@UseGuards(NodeTokenGuard)
@UseFilters(WingsErrorFilter)
export class RemoteController {
  /**
   * Les dépendances sont déclarées par `@Inject` explicite, et non déduites des
   * métadonnées de type émises à la compilation.
   *
   * C'est volontaire : `emitDecoratorMetadata` est un mécanisme fragile — il
   * cesse de fonctionner dès qu'un import devient `import type`, ne sait rien
   * faire d'une interface, et se casse sur les références circulaires, chaque
   * fois en produisant une erreur d'injection qui ne nomme pas la cause. Le
   * rendre explicite supprime cette classe de pannes, et permet d'exécuter le
   * service avec n'importe quel transpileur gérant les décorateurs.
   */
  private readonly logger = new Logger(RemoteController.name);

  constructor(
    @Inject(RemoteServerService) private readonly servers: RemoteServerService,
    @Inject(NodeRepository) private readonly nodes: NodeRepository,
    @Inject(RemoteBackupService) private readonly backups: RemoteBackupService,
    @Inject(RemoteActivityService) private readonly activity: RemoteActivityService,
    @Inject(ServerTransferService) private readonly transfers: ServerTransferService,
    @Inject(SftpAuthService) private readonly sftp: SftpAuthService,
  ) {}

  /**
   * Inventaire paginé des serveurs du node.
   *
   * C'est le premier appel du daemon au démarrage ; on en profite pour
   * horodater le contact. La version se lit dans l'agent utilisateur, que Wings
   * renseigne sous la forme `Pterodactyl Wings/v1.11.13 (id:...)`.
   */
  @Get("servers")
  async listServers(
    @Req() request: RemoteRequest,
    @Headers("user-agent") userAgent: string | undefined,
    @Query("page") page?: string,
    @Query("per_page") perPage?: string,
  ): Promise<WingsServerListResponse> {
    await this.nodes.recordHeartbeat(request.node.id, parseWingsVersion(userAgent));
    return this.servers.list(request.node.id, {
      page: toPositiveInt(page, 1),
      // Plafonnée : chaque ligne coûte une configuration complète, et
      // `per_page=1000000` les construisait toutes en une requête. Wings
      // demande 50 par défaut et pagine jusqu'à `meta.last_page`, calculé avec
      // la taille retenue : au-delà du plafond, il voit tout le parc, en plus
      // de pages.
      perPage: Math.min(toPositiveInt(perPage, 50), MAX_SERVERS_PER_PAGE),
    });
  }

  /**
   * Remise à zéro des états au démarrage du daemon.
   *
   * Wings signale ainsi qu'il repart de zéro : tout serveur que le panel
   * croyait en cours d'installation ou de restauration sur ce node ne l'est
   * plus, puisque le processus qui s'en chargeait a disparu. Sans cela, un
   * serveur resterait bloqué en « Installation » jusqu'à une action manuelle.
   */
  @Post("servers/reset")
  @HttpCode(204)
  async resetServers(@Req() request: RemoteRequest): Promise<void> {
    await this.servers.resetTransientStates(request.node.id);
  }

  /**
   * Configuration d'un serveur, lue par le daemon qui l'héberge.
   *
   * Une exception, et une seule : pendant un transfert, le node **d'arrivée**
   * doit pouvoir la lire alors que la base désigne encore celui de départ. Il
   * reçoit les fichiers et doit créer le serveur chez lui ; sans cela il
   * obtiendrait un 404 et le transfert échouerait à la dernière étape, sans
   * qu'aucun journal ne dise pourquoi.
   *
   * L'exception est étroite — ce node, ce serveur, et seulement tant que le
   * transfert court — et ne change pas ce que la base affirme : le serveur
   * appartient toujours au node de départ jusqu'à l'accusé de réception.
   */
  @Get("servers/:uuid")
  async serverConfiguration(
    @Req() request: RemoteRequest,
    @Param("uuid", REMOTE_UUID) uuid: string,
  ) {
    const configuration = (await this.transfers.isTransferTarget(uuid, request.node.id))
      ? await this.servers.configurationForTransfer(uuid)
      : await this.servers.configuration(request.node.id, uuid);
    // 404 et non 500 : la condition est définitive, et Wings ne réessaie pas
    // sur un 4xx. Une 500 installerait une boucle de tentatives pour un
    // serveur qui n'existera jamais.
    if (!configuration) throw new NotFoundException("Serveur inconnu sur ce node.");
    return configuration;
  }

  @Get("servers/:uuid/install")
  async installationScript(
    @Req() request: RemoteRequest,
    @Param("uuid", REMOTE_UUID) uuid: string,
  ): Promise<WingsInstallationScript> {
    const script = await this.servers.installationScript(request.node.id, uuid);
    if (!script) throw new NotFoundException("Serveur inconnu sur ce node.");
    return script;
  }

  @Post("servers/:uuid/install")
  @HttpCode(204)
  async installCompleted(
    @Req() request: RemoteRequest,
    @Param("uuid", REMOTE_UUID) uuid: string,
    @Body() body: unknown,
  ): Promise<void> {
    const status = parseInstallStatus(body);
    await this.servers.markInstalled(request.node.id, uuid, status);
  }

  /**
   * Authentification SFTP.
   *
   * Wings délègue entièrement cette décision au panel : un défaut ici devient
   * un accès aux fichiers des serveurs d'autrui. Ce chemin est donc traité
   * comme du code d'isolation (§5.5), pas comme une route ordinaire.
   */
  @Post("sftp/auth")
  async sftpAuth(@Req() request: RemoteRequest, @Body() body: unknown): Promise<SftpAuthResponse> {
    const parsed = SftpAuthRequest.safeParse(body);
    if (!parsed.success) throw new InvalidSftpCredentials();

    const granted = await this.sftp.authenticate(request.node.id, parsed.data);
    // Identifiants faux et serveur inexistant donnent la même réponse : toute
    // distinction transformerait le SFTP en outil d'énumération des serveurs.
    if (!granted) throw new InvalidSftpCredentials();
    return granted;
  }

  /**
   * Fin d'archivage, rapportée par le node de départ.
   *
   * Le panel n'en fait rien d'autre que le noter : l'archive est une étape
   * interne au transfert, et c'est l'arrivée qui décide de son issue. Répondre
   * 204 plutôt que 501 évite que le daemon rejoue indéfiniment un compte rendu
   * dont nous n'avons pas l'usage.
   */
  @Post("servers/:uuid/archive")
  @HttpCode(204)
  archiveCompleted(@Param("uuid", REMOTE_UUID) uuid: string): void {
    this.logger.log(`Archive prête pour le transfert de ${uuid}.`);
  }

  /**
   * Issue d'un transfert, rapportée par le node d'arrivée.
   *
   * Wings n'envoie que deux valeurs — `success` ou `failure` — et rien d'autre :
   * pas de corps, pas de motif. Tout ce que le panel peut dire de l'échec, il
   * doit donc l'écrire lui-même.
   *
   * L'identité du node vient du jeton vérifié, jamais de l'URL : sans cela,
   * n'importe quel node pourrait déclarer réussi le transfert d'un serveur qui
   * ne le concerne pas, et s'attribuer ainsi le serveur d'un autre.
   */
  @Post("servers/:uuid/transfer/:state")
  @HttpCode(204)
  async transferState(
    @Req() request: RemoteRequest,
    @Param("uuid", REMOTE_UUID) uuid: string,
    @Param("state") state: string,
  ): Promise<void> {
    if (state === "success") {
      // Seul le node qui reçoit peut annoncer la réussite : c'est lui qui tient
      // désormais les fichiers.
      if (!(await this.transfers.isTransferTarget(uuid, request.node.id))) {
        throw new NotFoundException("Aucun transfert vers ce node pour ce serveur.");
      }
      await this.transfers.complete(uuid);
      return;
    }

    if (state === "failure") {
      // L'échec, lui, peut venir des deux bouts : le départ n'a pas pu envoyer,
      // ou l'arrivée n'a pas pu recevoir. Les deux comptes rendus disent la
      // même chose — le serveur reste où il est.
      await this.transfers.fail(
        uuid,
        `Le daemon « ${request.node.name} » a signalé un échec.`,
        request.node.id,
      );
      return;
    }

    throw new BadRequestException(`État de transfert inconnu : « ${state} ».`);
  }

  /**
   * Adresses signées pour déposer une sauvegarde sur le stockage distant.
   *
   * Wings appelle cette route **juste avant** d'envoyer l'archive qu'il vient
   * de peser, pour une sauvegarde demandée avec l'adaptateur `s3` — ce que
   * fait `BackupsService.create` dès qu'un compartiment est réglé. Le panel
   * ouvre le dépôt fractionné — lui seul a les identifiants du compartiment —
   * et rend une adresse par partie.
   *
   * **404 quand le stockage distant n'est plus configuré** (retiré des
   * réglages entre la demande et l'envoi), et non 5xx : Wings traite un 4xx
   * comme définitif, quand un 5xx le ferait réessayer en boucle pour une
   * condition qui ne changera pas sans intervention humaine. La sauvegarde
   * échoue alors, et son propriétaire en est prévenu. Le daemon n'en garde pas
   * de copie : l'adaptateur `s3` efface toujours son archive locale.
   */
  @Get("backups/:uuid")
  async backupUploadUrls(
    @Req() request: RemoteRequest,
    @Param("uuid", REMOTE_UUID) uuid: string,
    @Query("size") size?: string,
  ) {
    const urls = await this.backups.openUpload(request.node.id, uuid, toPositiveInt(size, 0));
    if (!urls) throw new NotFoundException("Aucun stockage distant configuré.");
    return urls;
  }

  /**
   * Fin d'une sauvegarde.
   *
   * 204 sans corps : Wings n'attend rien d'autre, et tout ce qu'on renverrait
   * serait ignoré. L'identifiant du node vient du jeton vérifié, jamais de
   * l'URL — c'est lui qui limite la portée du compte rendu.
   */
  @Post("backups/:uuid")
  @HttpCode(204)
  async backupCompleted(
    @Req() request: RemoteRequest,
    @Param("uuid", REMOTE_UUID) uuid: string,
    @Body() body: unknown,
  ): Promise<void> {
    // Le corps vient du daemon, mais il est validé comme tout le reste : un
    // champ hors format doit produire un 400 net, pas une erreur plus loin.
    // Partiel : des daemons n'envoient rien, et le service sait s'en passer.
    const parsed = WingsBackupReport.partial().safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException("Compte rendu de sauvegarde invalide.");
    await this.backups.complete(request.node.id, uuid, parsed.data as BackupReport);
  }

  /**
   * Fin d'une restauration, réussie ou non (`{ "successful": bool }`).
   *
   * Relâche l'état `restoring` du serveur (NC-44). La demande est déjà au
   * journal d'activité (`backup.restore`), avec son auteur.
   */
  @Post("backups/:uuid/restore")
  @HttpCode(204)
  async backupRestored(
    @Req() request: RemoteRequest,
    @Param("uuid", REMOTE_UUID) uuid: string,
    @Body() body: unknown,
  ): Promise<void> {
    const successful = (body as { successful?: unknown } | null)?.successful === true;
    await this.backups.restored(request.node.id, uuid, successful);
  }

  /**
   * Journal remonté par le daemon.
   *
   * Ces lignes décrivent ce qui s'est passé hors du panel — une écriture SFTP,
   * par exemple. Le node authentifié borne ce qu'elles peuvent affirmer : voir
   * `RemoteActivityService.record`.
   */
  @Post("activity")
  @HttpCode(204)
  async recordActivity(@Req() request: RemoteRequest, @Body() body: unknown): Promise<void> {
    const data = (body as { data?: unknown })?.data;
    await this.activity.record(
      request.node.id,
      Array.isArray(data) ? (data as WingsActivity[]) : [],
    );
  }
}

/** Refus d'identifiants SFTP, au code que Wings interprète comme tel. */
class InvalidSftpCredentials extends NotFoundException {
  constructor() {
    super("Identifiants invalides.");
  }

  override getStatus(): number {
    return SFTP_INVALID_CREDENTIALS_STATUS;
  }
}

/**
 * Numéro de page demandé, ramené dans une plage exploitable.
 *
 * Attention, comportement observé sur le daemon réel : **Wings commence à la
 * page 0**, puis poursuit de `meta.current_page + 1` jusqu'à `meta.last_page`
 * (`remote/servers.go`, `GetServers`). Les pages 0 et 1 doivent donc désigner
 * la même première page, et la réponse annoncer `current_page: 1` — sinon le
 * daemon redemanderait la page 1 après la page 0 et verrait deux fois les
 * mêmes serveurs.
 *
 * Toute valeur non exploitable retombe sur la première page plutôt que de
 * produire un décalage négatif, que PostgreSQL refuserait.
 */
function toPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * `Pterodactyl Wings/v1.11.13 (id:abcdef)` → `1.11.13`.
 *
 * Le `v` est répété une ou plusieurs fois, et ce n'est pas une coquette :
 * Wings compose son agent avec un `v` littéral suivi de sa chaîne de version,
 * laquelle porte déjà son propre `v` depuis la 1.13 — d'où le `vv1.13.3` qu'un
 * vrai daemon présente. N'en accepter qu'un rendait `null` sur ces versions,
 * et le panel affichait « version inconnue » à un node parfaitement bavard.
 */
export function parseWingsVersion(userAgent: string | undefined): string | null {
  const match = userAgent?.match(/Wings\/v+([0-9][^\s(]*)/);
  return match?.[1] ?? null;
}

function parseInstallStatus(body: unknown): WingsInstallStatus {
  const raw = (body ?? {}) as Record<string, unknown>;
  return {
    // Une valeur absente vaut « échec » : conclure au succès sur un corps
    // incomplet marquerait installé un serveur qui ne l'est pas.
    successful: raw.successful === true,
    reinstall: raw.reinstall === true,
  };
}
