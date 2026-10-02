import {
  assertValidCron,
  type CronFields,
  CronSyntaxError,
  PowerSignal,
  RELEASE_VERSION_MAX_LENGTH,
} from "@gamedashboard/contracts";
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Logger,
  Param,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { singleQuery } from "../../common/query-param";
import { ActivityService } from "../activity/activity.service";
import { PlatformSettingsService } from "../admin/platform-settings.service";
import { ImpersonationReadOnlyGuard, withImpersonator } from "../auth/impersonation.guard";
import type { AuthenticatedRequest } from "../auth/session.guard";
import { SessionGuard } from "../auth/session.guard";
import { EngineService } from "../marketplace/engine.service";
import { EulaService, MINECRAFT_EULA_URL } from "../marketplace/eula.service";
import { MarketplaceService } from "../marketplace/marketplace.service";
import {
  DAEMON_UNAVAILABLE_MESSAGE,
  WingsClientService,
  WingsUnavailableError,
} from "../wings/wings-client.service";
import { AllocationsService } from "./allocations.service";
import { BackupsService } from "./backups.service";
import { DatabasesService } from "./databases.service";
import {
  SchedulesService,
  type ScheduleTaskInput,
  SUPPORTED_ACTIONS,
  type SupportedAction,
} from "./schedules.service";
import { accessPrincipal, ServerAccessService } from "./server-access.service";
import { ServerInvitesService } from "./server-invites.service";
import { ServerSettingsService } from "./server-settings.service";
import { ServerWebhooksService } from "./server-webhooks.service";
import { SubusersService } from "./subusers.service";

type ClientRequest = AuthenticatedRequest & {
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
};

/**
 * Adresse d'un invité : une adresse, et non « quelque chose qui contient un
 * @ ». `includes("@")` laissait partir `@` ou `a@` chercher un compte et
 * fabriquer une invitation qui n'arriverait nulle part. Même forme que
 * l'adresse d'un compte côté administration.
 */
const InviteEmail = z.string().trim().email().max(255);

/** Longueur maximale d'une image Docker, comme dans l'éditeur d'eggs. */
const MAX_DOCKER_IMAGE_LENGTH = 255;

/** Décalage maximal d'une étape de tâche planifiée, en secondes (15 minutes, comme Pterodactyl). */
const MAX_TASK_OFFSET_SECONDS = 900;
/** Nombre maximal d'étapes par tâche planifiée. */
const MAX_SCHEDULE_TASKS = 20;

/**
 * Qui agit, et sous quelle restriction.
 *
 * Les deux champs voyagent ensemble jusqu'au contrôle d'accès : séparer
 * l'identité de ses portées ferait qu'un oubli donne à une clé d'API tous les
 * droits de son propriétaire.
 */
/**
 * Hôte par lequel le navigateur est arrivé.
 *
 * Même en-tête et même défiance que pour les jetons de courrier : la valeur est
 * forgeable, et seul `BrandingService` décide si elle désigne un revendeur au
 * domaine vérifié. Elle ne sert qu'à cela.
 */
function arrivalHost(request: ClientRequest): string | null {
  const raw = request.headers?.["x-gd-host"];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim().toLowerCase() ?? "";
  return value === "" ? null : value;
}

/**
 * Version d'extension demandée, facultative.
 *
 * Absente, l'installation prend la plus récente compatible. Présente, elle
 * doit être une chaîne non vide et bornée : elle n'est que comparée aux
 * publications du catalogue, jamais transmise telle quelle au daemon.
 */
function readReleaseVersion(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string" || raw.trim() === "" || raw.length > RELEASE_VERSION_MAX_LENGTH) {
    throw new BadRequestException("Version d'extension invalide.");
  }
  return raw;
}

/**
 * Attente d'une sauvegarde préalable à un changement de moteur.
 *
 * Un monde de plusieurs gigaoctets s'archive en minutes ; au-delà de celles-ci
 * on renonce, sans rien écrire, plutôt que de garder le serveur verrouillé.
 */
const ENGINE_BACKUP_TIMEOUT_MS = 30 * 60_000;

function principalOf(request: ClientRequest) {
  return accessPrincipal(request);
}

/**
 * Sauvegardes, bases de données, ports et accès d'un serveur.
 *
 * Distinct du contrôleur d'exécution : celui-ci porte des objets dont le panel
 * tient le registre, là où l'autre ne fait que relayer ce que seul le daemon
 * connaît. Les mêler donnerait l'impression que tout vient de Wings, alors
 * qu'une base de données ne le concerne pas du tout.
 */
@Controller("api/v1/client/servers/:id")
@UseGuards(SessionGuard, ImpersonationReadOnlyGuard)
export class ServerFeaturesController {
  private readonly logger = new Logger(ServerFeaturesController.name);

  constructor(
    @Inject(ServerAccessService) private readonly access: ServerAccessService,
    @Inject(ServerWebhooksService) private readonly serverWebhooks: ServerWebhooksService,
    @Inject(BackupsService) private readonly backups: BackupsService,
    @Inject(DatabasesService) private readonly databases: DatabasesService,
    @Inject(AllocationsService) private readonly allocations: AllocationsService,
    @Inject(SubusersService) private readonly subusers: SubusersService,
    @Inject(ServerInvitesService) private readonly invites: ServerInvitesService,
    @Inject(SchedulesService) private readonly schedules: SchedulesService,
    @Inject(ServerSettingsService) private readonly settings: ServerSettingsService,
    @Inject(ActivityService) private readonly activity: ActivityService,
    @Inject(WingsClientService) private readonly wings: WingsClientService,
    @Inject(MarketplaceService) private readonly marketplace: MarketplaceService,
    @Inject(EngineService) private readonly engine: EngineService,
    @Inject(EulaService) private readonly eula: EulaService,
    @Inject(PlatformSettingsService) private readonly platform: PlatformSettingsService,
  ) {}

  /* --- Sauvegardes ------------------------------------------------------- */

  @Get("backups")
  async listBackups(@Req() request: ClientRequest, @Param("id") id: string) {
    await this.access.require(principalOf(request), id, "backups.read");
    const [items, quota] = await Promise.all([this.backups.list(id), this.backups.quota(id)]);
    return { data: items, meta: quota };
  }

  @Post("backups")
  async createBackup(
    @Req() request: ClientRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const { name, ignore } = (body ?? {}) as { name?: unknown; ignore?: unknown };
    if (typeof name !== "string" || name.trim() === "") {
      throw new BadRequestException("Nom de sauvegarde manquant.");
    }

    await this.access.require(principalOf(request), id, "backups.create");
    /*
     * Le daemon ne dira pas non à celle-ci.
     *
     * Il refuse de démarrer un serveur suspendu, mais il fabrique volontiers
     * sa sauvegarde : la suspension coupe l'exécution, pas l'écriture. Sans ce
     * contrôle, un serveur coupé par l'enveloppe de son hébergeur continuait
     * de remplir le disque du node et son propre quota — exactement ce que la
     * coupure devait arrêter.
     */
    await this.access.requireOperable(id);
    const created = await this.relay(() =>
      this.backups.create(id, name, Array.isArray(ignore) ? ignore.map(String) : []),
    );
    await this.log(request, id, "backup.create", { name, backupId: created.id });
    return { data: created };
  }

  /**
   * Verrouillage.
   *
   * Rattaché à `backups.delete` et non à une permission de lecture : verrouiller
   * comme déverrouiller décide de ce que la rotation de rétention a le droit
   * d'effacer. Donner ce pouvoir à quelqu'un qui n'a pas celui de supprimer
   * serait incohérent dans les deux sens.
   */
  @Post("backups/:backupId/lock")
  async lockBackup(
    @Req() request: ClientRequest,
    @Param("id") id: string,
    @Param("backupId") backupId: string,
    @Body() body: unknown,
  ) {
    const locked = (body as { locked?: unknown })?.locked;
    if (typeof locked !== "boolean") throw new BadRequestException("État de verrou manquant.");

    await this.access.require(principalOf(request), id, "backups.delete");
    const locked_ = await this.backups.setLocked(id, backupId, locked);
    await this.log(request, id, "backup.lock", { backupId, locked });
    return { data: locked_ };
  }

  /**
   * Adresse de téléchargement d'une archive.
   *
   * Rendue plutôt que suivie : le panel ne relaie pas les octets, le navigateur
   * va les chercher lui-même auprès du compartiment ou du daemon.
   *
   * Journalisée, et c'est important : emporter une archive, c'est emporter tout
   * le serveur — fichiers de configuration, mots de passe RCON et clés d'API
   * compris. C'est exactement le genre de geste qu'on veut retrouver dans un
   * journal après coup.
   */
  @Get("backups/:backupId/download")
  async downloadBackup(
    @Req() request: ClientRequest,
    @Param("id") id: string,
    @Param("backupId") backupId: string,
  ) {
    await this.access.require(principalOf(request), id, "backups.download");
    // L'identité vient de la session, jamais de l'URL : le jeton remis au daemon
    // porte le compte au nom duquel l'archive est tirée.
    const url = await this.backups.downloadUrl(id, backupId, principalOf(request).id);
    await this.log(request, id, "backup.download", { backupId });
    return { data: { url } };
  }

  @Post("backups/:backupId/restore")
  async restoreBackup(
    @Req() request: ClientRequest,
    @Param("id") id: string,
    @Param("backupId") backupId: string,
    @Body() body: unknown,
  ) {
    const truncate = (body as { truncate?: unknown })?.truncate === true;
    await this.access.require(principalOf(request), id, "backups.restore");
    // Rendre une sauvegarde par-dessus une installation en cours écrase des
    // fichiers que le daemon est en train d'écrire, et laisse un serveur dont
    // ni l'une ni l'autre n'est complète.
    await this.access.requireOperable(id);
    await this.relay(() => this.backups.restore(id, backupId, truncate));
    await this.log(request, id, "backup.restore", { backupId, truncate });
    return { data: { restored: backupId } };
  }

  @Delete("backups/:backupId")
  async deleteBackup(
    @Req() request: ClientRequest,
    @Param("id") id: string,
    @Param("backupId") backupId: string,
  ) {
    await this.access.require(principalOf(request), id, "backups.delete");
    await this.relay(() => this.backups.remove(id, backupId));
    await this.log(request, id, "backup.delete", { backupId });
    return { data: { deleted: backupId } };
  }

  /* --- Bases de données -------------------------------------------------- */

  @Get("databases")
  async listDatabases(@Req() request: ClientRequest, @Param("id") id: string) {
    await this.access.require(principalOf(request), id, "databases.read");
    const [items, quota] = await Promise.all([this.databases.list(id), this.databases.quota(id)]);
    return { data: items, meta: quota };
  }

  @Post("databases")
  async createDatabase(
    @Req() request: ClientRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const { name, remote } = (body ?? {}) as { name?: unknown; remote?: unknown };
    if (typeof name !== "string" || name.trim() === "") {
      throw new BadRequestException("Nom de base manquant.");
    }

    await this.access.require(principalOf(request), id, "databases.create");
    // Une base vit sur le serveur MySQL, pas dans le conteneur : rien ne
    // l'empêcherait d'être créée pour un serveur suspendu, ni de survivre.
    await this.access.requireOperable(id);
    const db = await this.databases.create(id, name, typeof remote === "string" ? remote : "%");
    await this.log(request, id, "database.create", { database: db.name });
    return { data: db };
  }

  /**
   * Mot de passe d'une base.
   *
   * Exige `databases.update`, et non `databases.read` : la lecture donne les
   * coordonnées de connexion, pas les identifiants. Qui peut changer le mot de
   * passe peut de toute façon s'en donner un nouveau — l'afficher ne lui accorde
   * rien de plus. Pour les autres, ce serait un droit supplémentaire accordé
   * sans qu'on l'ait décidé.
   */
  @Get("databases/:databaseId/password")
  async databasePassword(
    @Req() request: ClientRequest,
    @Param("id") id: string,
    @Param("databaseId") databaseId: string,
  ) {
    await this.access.require(principalOf(request), id, "databases.update");
    /*
     * Pas pendant une prise en main. Le garde laisse passer les `GET`, mais
     * celui-ci fait sortir un secret — remis à l'agent, sous le nom du client.
     * « Voir ce que voit le client » n'en a pas besoin : l'écran montre les
     * coordonnées de la base sans le mot de passe.
     */
    if (request.user.impersonator) {
      throw new ForbiddenException(
        "Vous regardez ce compte en tant que membre du personnel : le mot de passe d'une base ne vous est pas révélé.",
      );
    }
    const revealed = await this.databases.password(id, databaseId);
    // La consultation est journalisée au même titre que la modification :
    // c est le moment où un identifiant quitte le panel.
    await this.log(request, id, "database.password", { databaseId });
    return { data: { password: revealed } };
  }

  @Post("databases/:databaseId/rotate")
  async rotateDatabasePassword(
    @Req() request: ClientRequest,
    @Param("id") id: string,
    @Param("databaseId") databaseId: string,
  ) {
    await this.access.require(principalOf(request), id, "databases.update");
    const rotated = await this.databases.rotatePassword(id, databaseId);
    await this.log(request, id, "database.rotate", { databaseId });
    return { data: { password: rotated } };
  }

  @Delete("databases/:databaseId")
  async deleteDatabase(
    @Req() request: ClientRequest,
    @Param("id") id: string,
    @Param("databaseId") databaseId: string,
  ) {
    await this.access.require(principalOf(request), id, "databases.delete");
    await this.databases.remove(id, databaseId);
    await this.log(request, id, "database.delete", { databaseId });
    return { data: { deleted: databaseId } };
  }

  /* --- Réseau ------------------------------------------------------------ */

  @Get("allocations")
  async listAllocations(@Req() request: ClientRequest, @Param("id") id: string) {
    await this.access.require(principalOf(request), id, "allocations.read");
    const [items, quota, available] = await Promise.all([
      this.allocations.list(id),
      this.allocations.quota(id),
      this.allocations.availableOnNode(id),
    ]);
    return { data: items, meta: { ...quota, available } };
  }

  /**
   * Prend un port.
   *
   * Sans corps : le client ne choisit pas lequel. Accepter un numéro de port
   * lui permettrait de viser celui d'un voisin sur le même node.
   */
  @Post("allocations")
  async claimAllocation(@Req() request: ClientRequest, @Param("id") id: string) {
    await this.access.require(principalOf(request), id, "allocations.create");
    // Un port réservé l'est sur le node, et le reste tant qu'on ne le rend
    // pas : le prendre pendant une suspension immobilise la machine d'autrui.
    await this.access.requireOperable(id);
    const claimed = await this.allocations.claim(id);
    await this.log(request, id, "allocation.claim", { port: claimed.port, ip: claimed.ip });
    return { data: claimed };
  }

  @Post("allocations/:allocationId/primary")
  async setPrimaryAllocation(
    @Req() request: ClientRequest,
    @Param("id") id: string,
    @Param("allocationId") allocationId: string,
  ) {
    await this.access.require(principalOf(request), id, "allocations.update");
    await this.allocations.setPrimary(id, allocationId);
    await this.log(request, id, "allocation.primary", { allocationId });
    return { data: { primary: allocationId } };
  }

  @Post("allocations/:allocationId/notes")
  async setAllocationNotes(
    @Req() request: ClientRequest,
    @Param("id") id: string,
    @Param("allocationId") allocationId: string,
    @Body() body: unknown,
  ) {
    const notes = (body as { notes?: unknown })?.notes;
    if (notes !== null && typeof notes !== "string") {
      throw new BadRequestException("Note invalide.");
    }
    await this.access.require(principalOf(request), id, "allocations.update");
    await this.allocations.setNotes(id, allocationId, notes === "" ? null : notes);
    await this.log(request, id, "allocation.notes", { allocationId });
    return { data: { notes } };
  }

  @Delete("allocations/:allocationId")
  async releaseAllocation(
    @Req() request: ClientRequest,
    @Param("id") id: string,
    @Param("allocationId") allocationId: string,
  ) {
    await this.access.require(principalOf(request), id, "allocations.delete");
    await this.allocations.release(id, allocationId);
    await this.log(request, id, "allocation.release", { allocationId });
    return { data: { released: allocationId } };
  }

  /* --- Sous-utilisateurs -------------------------------------------------- */

  @Get("subusers")
  async listSubusers(@Req() request: ClientRequest, @Param("id") id: string) {
    await this.access.require(principalOf(request), id, "subusers.read");
    return { data: await this.subusers.list(id) };
  }

  /**
   * Presets proposés à l'invitation, tels que l'administration les a définis.
   *
   * Servis par l'API plutôt que lus dans `contracts` par l'écran : sans quoi
   * une redéfinition par l'administration ne changerait rien à ce que le
   * formulaire pré-coche. Seuls les presets en vigueur sortent — les valeurs du
   * code et l'état « modifié » n'intéressent que l'administration.
   */
  @Get("subusers/presets")
  async subuserPresets(@Req() request: ClientRequest, @Param("id") id: string) {
    await this.access.require(principalOf(request), id, "subusers.read");
    return { data: (await this.platform.rolePresets()).presets };
  }

  /**
   * Invite.
   *
   * L'auteur est pris de la session, jamais du corps : c'est lui qui borne les
   * permissions accordables, et le laisser se désigner annulerait la règle.
   */
  @Post("subusers")
  async inviteSubuser(
    @Req() request: ClientRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const { email: brute, permissions } = (body ?? {}) as {
      email?: unknown;
      permissions?: unknown;
    };
    const adresse = InviteEmail.safeParse(brute);
    if (!adresse.success) throw new BadRequestException("Adresse e-mail invalide.");
    const email = adresse.data;
    if (!Array.isArray(permissions)) throw new BadRequestException("Permissions manquantes.");

    await this.access.require(principalOf(request), id, "subusers.create");
    const invited = await this.subusers.invite(
      id,
      request.user.id,
      email,
      permissions.map(String),
      // L'hôte d'arrivée, pour que le lien d'un client de revendeur porte le
      // domaine de ce revendeur. Il n'est retenu que s'il est vérifié.
      arrivalHost(request),
    );

    // Deux issues, et le journal doit les distinguer : un accès en attente
    // d'acceptation n'est pas un courriel parti vers quelqu'un qui n'a pas
    // encore de compte. Les confondre ferait chercher une ligne inexistante
    // dans la liste des sous-utilisateurs.
    if ("pendingInvite" in invited) {
      await this.log(request, id, "subuser.invite_sent", {
        email,
        permissions: invited.pendingInvite.permissions,
      });
      return { data: invited };
    }

    await this.log(request, id, "subuser.invite", { email, permissions: invited.permissions });
    return { data: invited };
  }

  /* --- Invitations par courriel ------------------------------------------- */

  /**
   * Invitations émises et pas encore tranchées.
   *
   * Servies à part des sous-utilisateurs : elles ne donnent aucun accès et ne
   * désignent aucun compte. Les mêler ferait apparaître dans la liste des
   * personnes qui n'existent pas encore.
   */
  @Get("subusers/invites")
  async listInvites(@Req() request: ClientRequest, @Param("id") id: string) {
    await this.access.require(principalOf(request), id, "subusers.read");
    return { data: await this.invites.listFor(id) };
  }

  /** Annule une invitation : le lien déjà parti cesse aussitôt de valoir. */
  @Delete("subusers/invites/:inviteId")
  async revokeInvite(
    @Req() request: ClientRequest,
    @Param("id") id: string,
    @Param("inviteId") inviteId: string,
  ) {
    await this.access.require(principalOf(request), id, "subusers.delete");
    await this.invites.revoke(id, inviteId);
    await this.log(request, id, "subuser.invite_revoked", { inviteId });
    return { data: { revoked: inviteId } };
  }

  @Post("subusers/:subuserId")
  async updateSubuser(
    @Req() request: ClientRequest,
    @Param("id") id: string,
    @Param("subuserId") subuserId: string,
    @Body() body: unknown,
  ) {
    const permissions = (body as { permissions?: unknown })?.permissions;
    if (!Array.isArray(permissions)) throw new BadRequestException("Permissions manquantes.");

    await this.access.require(principalOf(request), id, "subusers.update");
    const updated = await this.subusers.update(
      id,
      request.user.id,
      subuserId,
      permissions.map(String),
    );
    await this.log(request, id, "subuser.update", {
      subuser: updated.email,
      permissions: updated.permissions,
    });
    return { data: updated };
  }

  @Delete("subusers/:subuserId")
  async removeSubuser(
    @Req() request: ClientRequest,
    @Param("id") id: string,
    @Param("subuserId") subuserId: string,
  ) {
    await this.access.require(principalOf(request), id, "subusers.delete");
    const { sessionClosed } = await this.subusers.remove(id, subuserId);
    await this.log(request, id, "subuser.delete", { subuserId, sessionClosed });
    return { data: { removed: subuserId, sessionClosed } };
  }

  /* --- Planification ------------------------------------------------------ */

  /**
   * Planifier une action exige le droit de la faire soi-même.
   *
   * Sans ce contrôle, `schedules.create` valait `console.send` et `power.*`
   * avec un délai : la tâche s'exécute avec le jeton du panel, pas avec les
   * droits de qui l'a écrite. Pterodactyl a la même faiblesse ; ici elle est
   * fermée.
   */
  private async requireTaskPermissions(
    request: ClientRequest,
    serverId: string,
    tasks: readonly { action: SupportedAction; payload: string }[],
  ): Promise<void> {
    const principal = principalOf(request);
    for (const task of tasks) {
      if (task.action === "command") {
        await this.access.require(principal, serverId, "console.send");
      } else if (task.action === "power") {
        const signal = PowerSignal.safeParse(task.payload);
        if (!signal.success) throw new BadRequestException("Signal d'alimentation inconnu.");
        await this.access.require(principal, serverId, `power.${signal.data}` as never);
      } else if (task.action === "backup") {
        await this.access.require(principal, serverId, "backups.create");
      }
    }
  }

  @Get("schedules")
  async listSchedules(@Req() request: ClientRequest, @Param("id") id: string) {
    await this.access.require(principalOf(request), id, "schedules.read");
    return { data: await this.schedules.list(id) };
  }

  @Post("schedules")
  async createSchedule(
    @Req() request: ClientRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const input = parseSchedule(body);
    await this.access.require(principalOf(request), id, "schedules.create");
    await this.requireTaskPermissions(request, id, input.tasks);
    const schedule = await this.schedules.create(
      id,
      input.name,
      input.cron,
      input.options,
      input.tasks,
    );
    await this.log(request, id, "schedule.create", { name: schedule.name });
    return { data: schedule };
  }

  @Post("schedules/:scheduleId")
  async updateSchedule(
    @Req() request: ClientRequest,
    @Param("id") id: string,
    @Param("scheduleId") scheduleId: string,
    @Body() body: unknown,
  ) {
    const input = parseSchedule(body);
    await this.access.require(principalOf(request), id, "schedules.update");
    await this.requireTaskPermissions(request, id, input.tasks);
    const schedule = await this.schedules.update(
      id,
      scheduleId,
      input.name,
      input.cron,
      input.options,
      input.tasks,
    );
    await this.log(request, id, "schedule.update", { name: schedule.name });
    return { data: schedule };
  }

  @Post("schedules/:scheduleId/active")
  async setScheduleActive(
    @Req() request: ClientRequest,
    @Param("id") id: string,
    @Param("scheduleId") scheduleId: string,
    @Body() body: unknown,
  ) {
    const active = (body as { active?: unknown })?.active;
    if (typeof active !== "boolean") throw new BadRequestException("État manquant.");

    await this.access.require(principalOf(request), id, "schedules.update");
    /*
     * Réactiver, c'est rendre au planificateur des étapes qu'il exécutera avec
     * le jeton du panel : le droit de les faire soi-même est exigé, comme à la
     * création. La pause, non — elle n'exécute rien, et le même invité peut
     * déjà vider la tâche de ses étapes par une modification.
     */
    if (active) {
      await this.requireTaskPermissions(request, id, await this.schedules.tasksOf(id, scheduleId));
    }
    await this.schedules.setActive(id, scheduleId, active);
    await this.log(request, id, "schedule.active", { scheduleId, active });
    return { data: { active } };
  }

  /**
   * Exécution immédiate.
   *
   * Rattachée à `schedules.update` : lancer une tâche revient à décider de son
   * moment d'exécution, ce qui est bien une modification. La lecture seule ne
   * doit pas permettre de déclencher un redémarrage.
   *
   * **Et au droit de faire chaque étape.** `schedules.update` seul laissait un
   * invité sans `power.stop` arrêter le serveur en lançant une tâche écrite
   * par le propriétaire : le planificateur l'exécute avec le jeton du panel.
   */
  @Post("schedules/:scheduleId/run")
  async runSchedule(
    @Req() request: ClientRequest,
    @Param("id") id: string,
    @Param("scheduleId") scheduleId: string,
  ) {
    await this.access.require(principalOf(request), id, "schedules.update");
    await this.requireTaskPermissions(request, id, await this.schedules.tasksOf(id, scheduleId));
    await this.schedules.runNow(id, scheduleId);
    await this.log(request, id, "schedule.run", { scheduleId });
    return { data: { queued: scheduleId } };
  }

  @Delete("schedules/:scheduleId")
  async deleteSchedule(
    @Req() request: ClientRequest,
    @Param("id") id: string,
    @Param("scheduleId") scheduleId: string,
  ) {
    await this.access.require(principalOf(request), id, "schedules.delete");
    await this.schedules.remove(id, scheduleId);
    await this.log(request, id, "schedule.delete", { scheduleId });
    return { data: { deleted: scheduleId } };
  }

  /**
   * Le catalogue d'extensions est-il ouvert ?
   *
   * Le drapeau est tenu **ici**, sur les deux routes, et pas seulement à
   * l'écran. Masquer l'entrée de navigation suffirait à qui poste directement,
   * et c'est précisément ce que faisait ce drapeau avant : il ne commandait
   * rien du tout.
   */
  private async requireMarketplace(): Promise<void> {
    if (!(await this.platform.flag("marketplace"))) {
      throw new ForbiddenException("Le catalogue d'extensions est désactivé sur ce panel.");
    }
  }

  /* --- Paramètres --------------------------------------------------------- */

  @Get("settings")
  async getSettings(@Req() request: ClientRequest, @Param("id") id: string) {
    await this.access.require(principalOf(request), id, "startup.read");
    return { data: await this.settings.get(id, request.user.email) };
  }

  @Post("settings/rename")
  async rename(@Req() request: ClientRequest, @Param("id") id: string, @Body() body: unknown) {
    const { name, description } = (body ?? {}) as { name?: unknown; description?: unknown };
    if (typeof name !== "string") throw new BadRequestException("Nom manquant.");

    await this.access.require(principalOf(request), id, "settings.rename");
    const clean = typeof description === "string" && description.trim() !== "" ? description : null;
    await this.settings.rename(id, name, clean);
    await this.log(request, id, "server.rename", { name });
    return { data: { name } };
  }

  @Post("settings/variables")
  async setVariables(
    @Req() request: ClientRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const values = (body as { values?: unknown })?.values;
    if (!values || typeof values !== "object" || Array.isArray(values)) {
      throw new BadRequestException("Variables manquantes.");
    }

    await this.access.require(principalOf(request), id, "startup.update");
    await this.settings.setVariables(id, values as Record<string, string>);
    // Seuls les noms sont journalisés, jamais les valeurs : une variable de
    // démarrage contient souvent un mot de passe, et le journal est lisible par
    // quiconque a `activity.read` — soit moins que `startup.read`.
    await this.log(request, id, "server.variables", { variables: Object.keys(values) });
    return { data: { updated: Object.keys(values).length } };
  }

  /**
   * Choisit l'image de conteneur parmi celles que l'egg déclare.
   *
   * `startup.docker-image` existe précisément pour ça : c'est une permission à
   * part de `startup.update`, parce que changer la version de Java d'un
   * serveur et changer sa ligne de commande ne se donnent pas au même monde.
   *
   * Le service refuse toute image absente du catalogue de l'egg — la liste
   * fermée est la règle, pas l'affichage.
   */
  @Post("settings/docker-image")
  async setDockerImage(
    @Req() request: ClientRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const image = (body as { image?: unknown })?.image;
    if (typeof image !== "string" || image.trim() === "") {
      throw new BadRequestException("Image manquante.");
    }
    // Le service la cherche parmi celles de l'egg et refuserait l'inconnue ;
    // la borne évite seulement de la chercher, et de la journaliser, à
    // n'importe quelle taille.
    if (image.length > MAX_DOCKER_IMAGE_LENGTH) {
      throw new BadRequestException(
        `Nom d'image trop long (${MAX_DOCKER_IMAGE_LENGTH} caractères au plus).`,
      );
    }

    await this.access.require(principalOf(request), id, "startup.docker-image");
    // Changer l'image pendant qu'une installation écrit dans le serveur ferait
    // redémarrer le daemon sur une arborescence à moitié posée.
    await this.access.requireOperable(id);

    await this.settings.setDockerImage(id, image.trim());
    await this.log(request, id, "server.docker_image", { image: image.trim() });
    return { data: { image: image.trim() } };
  }

  /**
   * Réinstallation.
   *
   * Le daemon réexécute le script d'installation de l'egg par-dessus le volume
   * existant. C'est irréversible et ça peut écraser des fichiers de
   * configuration — d'où une permission qui lui est propre, absente même du
   * préset « développeur ».
   */
  @Post("settings/reinstall")
  async reinstall(@Req() request: ClientRequest, @Param("id") id: string) {
    await this.access.require(principalOf(request), id, "settings.reinstall");
    // Sauf sur une installation déjà échouée, qu'elle est là pour réparer.
    await this.access.requireReinstallable(id);
    await this.relay(() => this.wings.reinstallServer(id));
    await this.log(request, id, "server.reinstall", {});
    return { data: { started: true } };
  }

  /* --- Marketplace --------------------------------------------------------- */

  /**
   * Catalogue d'extensions applicable à ce serveur.
   *
   * Rattaché à `files.read` plutôt qu'à une permission propre : consulter le
   * catalogue revient à savoir ce qui est installé dans le conteneur, et
   * inventer une permission de plus pour cela compliquerait l'écran des
   * sous-utilisateurs sans rien protéger de nouveau.
   */
  @Get("marketplace")
  async marketplaceCatalogue(
    @Req() request: ClientRequest,
    @Param("id") id: string,
    @Query("q") query?: unknown,
  ) {
    const recherche = singleQuery(query, "q") ?? "";
    await this.requireMarketplace();
    await this.access.require(principalOf(request), id, "files.read");
    const [result, installed] = await Promise.all([
      this.relay(() => this.marketplace.catalogue(id, recherche)),
      this.marketplace.installed(id),
    ]);
    return {
      data: result.entries,
      // Le sort de chaque source accompagne le catalogue : une source tombée
      // et une source sans résultats donnent la même liste courte, et rien
      // d'autre à l'écran ne les distinguerait.
      meta: {
        runtime: result.runtime,
        unavailableReason: result.unavailableReason,
        sources: result.sources,
        // Ce qui est installé, indépendamment de la recherche du moment.
        installed,
      },
    };
  }

  /**
   * Installe une extension.
   *
   * `files.write` : l'opération dépose un fichier exécutable dans le
   * conteneur. C'est exactement ce que la permission couvre, et la rattacher
   * ailleurs laisserait quelqu'un sans droit d'écriture modifier le
   * comportement du serveur.
   */
  @Post("marketplace/install")
  async installAddon(
    @Req() request: ClientRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const projectId = (body as { projectId?: unknown })?.projectId;
    if (typeof projectId !== "string" || projectId.trim() === "") {
      throw new BadRequestException("Extension manquante.");
    }
    const version = readReleaseVersion((body as { version?: unknown })?.version);

    await this.requireMarketplace();
    await this.access.require(principalOf(request), id, "files.write");
    await this.access.requireOperable(id);
    const installed = await this.relay(() =>
      this.marketplace.install(id, projectId, version, request.user.id),
    );
    await this.log(request, id, "marketplace.install", { projectId, ...installed });
    return { data: installed };
  }

  /**
   * Ce qui peut remplacer le moteur de ce serveur.
   *
   * `files.read` comme le catalogue : lire ce qui est proposable ne change
   * rien au serveur.
   */
  @Get("engine")
  async engineState(
    @Req() request: ClientRequest,
    @Param("id") id: string,
    @Query("q") query?: unknown,
  ) {
    const recherche = singleQuery(query, "q") ?? "";
    await this.access.require(principalOf(request), id, "files.read");
    const state = await this.relay(() => this.engine.state(id, recherche));
    return {
      data: { platforms: state.platforms, packs: state.packs },
      meta: {
        runtime: state.runtime,
        unavailableReason: state.unavailableReason,
        current: state.current,
        packSources: state.packSources,
        install: state.install,
      },
    };
  }

  /**
   * Remplace le moteur : plateforme de serveur ou modpack.
   *
   * **Deux permissions exigées**, et ce n'est pas un excès de zèle : un
   * modpack écrase des fichiers existants autant qu'il en pose. Ne demander
   * que l'écriture laisserait quelqu'un sans droit de suppression effacer
   * l'arborescence d'un serveur par un choix dans une liste.
   */
  @Post("engine/install")
  @HttpCode(202)
  async installEngine(
    @Req() request: ClientRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const payload = body as { optionId?: unknown; versionId?: unknown; backupFirst?: unknown };
    if (
      typeof payload?.optionId !== "string" ||
      payload.optionId.trim() === "" ||
      payload.optionId.length > 160
    ) {
      throw new BadRequestException("Moteur manquant.");
    }
    if (
      typeof payload?.versionId !== "string" ||
      payload.versionId.trim() === "" ||
      payload.versionId.length > 120
    ) {
      throw new BadRequestException("Version manquante.");
    }
    if (payload.backupFirst !== undefined && typeof payload.backupFirst !== "boolean") {
      throw new BadRequestException("Choix de sauvegarde invalide.");
    }

    const principal = principalOf(request);
    await this.access.require(principal, id, "files.write");
    await this.access.require(principal, id, "files.delete");
    // Le serveur est arrêté par le service avant toute écriture : la
    // permission qui l'autorise doit donc être exigée ici aussi.
    await this.access.require(principal, id, "power.stop");
    // Deux installations qui se chevauchent se marcheraient dessus : la
    // seconde écrirait pendant que la première renomme.
    await this.access.requireOperable(id);

    /*
     * La sauvegarde préalable est une sauvegarde **ordinaire** : même quota,
     * même permission, même liste à l'écran, même restauration. Elle est
     * lancée serveur arrêté et verrouillé, et l'installation attend qu'elle
     * soit close — une archive prise pendant qu'on écrase des fichiers ne
     * servirait à rien. Son échec arrête tout avant la première écriture.
     */
    const backupFirst = payload.backupFirst === true;
    if (backupFirst) await this.access.require(principal, id, "backups.create");
    const beforeWrite = backupFirst
      ? async () => {
          const created = await this.backups.create(id, "Avant changement de moteur", []);
          await this.log(request, id, "backup.create", {
            name: created.name,
            backupId: created.id,
          });
          await this.backups.awaitCompletion(id, created.id, ENGINE_BACKUP_TIMEOUT_MS);
        }
      : undefined;

    /*
     * L'installation part **en tâche de fond** : un modpack enchaîne des
     * centaines de téléchargements, la sauvegarde préalable peut prendre une
     * demi-heure, et l'interface, le vhost ou Passenger couperaient la requête
     * bien avant. Les refus sûrs (version, chargeur, archive, runtime, une
     * installation déjà en cours) tombent ici, avant la réponse ; le compte
     * rendu se lit ensuite sur `GET engine` (`meta.install`).
     */
    const optionId = payload.optionId as string;
    const versionId = payload.versionId as string;
    const run = await this.relay(() =>
      this.engine.start(id, optionId, versionId, {
        installedBy: request.user.id,
        beforeWrite,
        onSettled: async (outcome) => {
          if ("error" in outcome) {
            await this.log(request, id, "engine.install_failed", {
              optionId,
              versionId,
              error: outcome.error,
              backupFirst,
            });
            return;
          }
          const installed = outcome.result;
          // Des comptes et non des listes : un pack pose des centaines de
          // fichiers, et le journal n'est pas un inventaire.
          await this.log(request, id, "engine.install", {
            optionId,
            versionId,
            label: installed.label,
            files: installed.files,
            missing: installed.missing.length,
            kept: installed.kept.length,
            removed: installed.removed,
            backupFirst,
          });
          /*
           * Le retrait de l'acceptation est un événement **à part**.
           *
           * Le noyer dans les propriétés de l'installation le rendrait
           * invisible : qui relit un journal pour savoir depuis quand un
           * serveur ne peut plus démarrer cherche « acceptation », pas
           * « moteur installé ».
           */
          if (installed.eulaReset) {
            await this.log(request, id, "server.eula_reset", { reason: installed.label });
          }
        },
      }),
    );
    return { data: run };
  }

  /**
   * Le contrat de licence de Minecraft : est-il accepté ?
   *
   * `files.read`, parce que la réponse se lit dans un fichier du conteneur et
   * ne dit rien de plus que ce fichier.
   */
  @Get("eula")
  async eulaState(@Req() request: ClientRequest, @Param("id") id: string) {
    await this.access.require(principalOf(request), id, "files.read");
    return { data: await this.relay(() => this.eula.state(id)) };
  }

  /**
   * Accepte le contrat, **explicitement**.
   *
   * Le panel ne l'accepte jamais de lui-même : ni à la création, ni au premier
   * démarrage raté. Écrire ce fichier, c'est accepter un contrat au nom de
   * quelqu'un, et un contrat accepté sans que personne ne l'ait voulu n'engage
   * rien de solide.
   *
   * Qui a accepté et quand vont au journal. Le fichier, lui, vit dans le
   * conteneur et le client peut le réécrire — la trace d'activité non, et c'est
   * elle qui fait foi.
   */
  @Post("eula")
  async acceptEula(@Req() request: ClientRequest, @Param("id") id: string) {
    await this.access.require(principalOf(request), id, "files.write");
    // Le fichier est écrit dans le conteneur : pendant une installation, le
    // daemon y écrit déjà, et sur un serveur suspendu personne ne devrait.
    await this.access.requireOperable(id);
    await this.relay(() => this.eula.accept(id));
    await this.log(request, id, "server.eula_accepted", { url: MINECRAFT_EULA_URL });
    return { data: { accepted: true } };
  }

  /** `files.delete` : la désinstallation efface un fichier du conteneur. */
  @Post("marketplace/uninstall")
  async uninstallAddon(
    @Req() request: ClientRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const projectId = (body as { projectId?: unknown })?.projectId;
    if (typeof projectId !== "string") throw new BadRequestException("Extension manquante.");

    await this.access.require(principalOf(request), id, "files.delete");
    // Symétrique de l'installation, qui est gardée depuis le début : retirer
    // un fichier d'un conteneur en cours de peuplement n'a pas plus de sens
    // que d'en ajouter un.
    await this.access.requireOperable(id);
    await this.relay(() => this.marketplace.uninstall(id, projectId));
    await this.log(request, id, "marketplace.uninstall", { projectId });
    return { data: { uninstalled: projectId } };
  }

  /* --- Journal d'activité -------------------------------------------------- */

  @Get("activity")
  async listActivity(
    @Req() request: ClientRequest,
    @Param("id") id: string,
    @Query("q") query?: unknown,
    @Query("page") page?: unknown,
  ) {
    const recherche = singleQuery(query, "q");
    const numero = singleQuery(page, "page");
    const { isOwner } = await this.access.require(principalOf(request), id, "activity.read");
    const result = await this.activity.forServer(id, {
      query: recherche,
      page: Number.parseInt(numero ?? "1", 10) || 1,
      // Les adresses des acteurs ne vont qu'à qui a tous les droits sur ce
      // serveur : voir `ActivityService.forServer`.
      revealIp: isOwner,
    });
    return { data: result.items, meta: { page: result.page, hasMore: result.hasMore } };
  }

  /* --- Rappels sortants du client ----------------------------------------- */

  /**
   * Les rappels déclarés sur ce serveur.
   *
   * Le secret n'y figure pas, et aucune route ne le rend : il n'est montré
   * qu'à la création et à la régénération. Un accès en lecture au panel ne doit
   * pas suffire à contrefaire des rappels.
   */
  @Get("webhooks")
  async webhooks(@Req() request: ClientRequest, @Param("id") id: string) {
    await this.access.require(principalOf(request), id, "webhooks.read");
    return { data: await this.serverWebhooks.list(id) };
  }

  /** L'historique des livraisons, avec ce que le receveur a répondu. */
  @Get("webhooks/:webhookId/deliveries")
  async webhookDeliveries(
    @Req() request: ClientRequest,
    @Param("id") id: string,
    @Param("webhookId") webhookId: string,
  ) {
    await this.access.require(principalOf(request), id, "webhooks.read");
    return { data: await this.serverWebhooks.deliveries(id, webhookId) };
  }

  /**
   * Déclare un rappel, et rend son secret **une seule fois**.
   *
   * Le propriétaire du serveur est l'auteur, quel que soit le sous-utilisateur
   * qui déclare : c'est son serveur, et un accès retiré ne doit pas emporter
   * un rappel dont dépend son intégration.
   */
  @Post("webhooks")
  async createWebhook(
    @Req() request: ClientRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    await this.access.require(principalOf(request), id, "webhooks.manage");
    const { url, events } = (body ?? {}) as { url?: unknown; events?: unknown };

    const created = await this.serverWebhooks.create(id, {
      url: String(url ?? ""),
      events: Array.isArray(events) ? events : [],
    });

    await this.log(request, id, "webhook.create", { url: created.webhook.url });
    return { data: created };
  }

  @Post("webhooks/:webhookId")
  async updateWebhook(
    @Req() request: ClientRequest,
    @Param("id") id: string,
    @Param("webhookId") webhookId: string,
    @Body() body: unknown,
  ) {
    await this.access.require(principalOf(request), id, "webhooks.manage");
    const { url, events, isActive } = (body ?? {}) as {
      url?: unknown;
      events?: unknown;
      isActive?: unknown;
    };

    const updated = await this.serverWebhooks.update(id, webhookId, {
      ...(typeof url === "string" ? { url } : {}),
      ...(Array.isArray(events) ? { events } : {}),
      ...(typeof isActive === "boolean" ? { isActive } : {}),
    });

    await this.log(request, id, "webhook.update", { webhookId });
    return { data: updated };
  }

  /** Renouvelle le secret. L'ancien cesse de valoir immédiatement. */
  @Post("webhooks/:webhookId/rotate")
  async rotateWebhook(
    @Req() request: ClientRequest,
    @Param("id") id: string,
    @Param("webhookId") webhookId: string,
  ) {
    await this.access.require(principalOf(request), id, "webhooks.manage");
    const rotated = await this.serverWebhooks.rotate(id, webhookId);
    await this.log(request, id, "webhook.rotate", { webhookId });
    return { data: rotated };
  }

  @Delete("webhooks/:webhookId")
  async deleteWebhook(
    @Req() request: ClientRequest,
    @Param("id") id: string,
    @Param("webhookId") webhookId: string,
  ) {
    await this.access.require(principalOf(request), id, "webhooks.manage");
    await this.serverWebhooks.remove(id, webhookId);
    await this.log(request, id, "webhook.delete", { webhookId });
    return { data: { deleted: webhookId } };
  }

  /**
   * Consigne une action.
   *
   * Appelée **après** que l'action a réussi : journaliser d'abord inscrirait
   * dans l'audit des opérations qui n'ont jamais eu lieu, ce qui est pire que
   * de n'en inscrire aucune.
   *
   * Le type d'acteur distingue une session d'une clé d'API. La distinction est
   * ce qui permet de répondre à « est-ce moi, ou mon bot ? » — la première
   * question que se pose quiconque découvre une action qu'il ne reconnaît pas.
   *
   * Pendant une prise en main, l'agent est nommé (`withImpersonator`) : les
   * `GET` qui ont un effet — tirer une sauvegarde — lui passent, et le journal
   * les imputait au client.
   */
  private async log(
    request: ClientRequest,
    serverId: string,
    event: string,
    properties: Record<string, unknown>,
  ): Promise<void> {
    await this.activity.record({
      event,
      serverId,
      actorId: request.user.id,
      actorType: request.scopes === null ? "user" : "api_key",
      actorLabel: await this.activity.labelFor(request.user.id),
      ip: request.ip ?? null,
      properties: withImpersonator(request, properties),
    });
  }

  /**
   * Voir `ServerRuntimeController.relay` : un node muet n'est pas un bogue du
   * panel, et un refus du daemon n'est pas une panne.
   *
   * Le refus passait ici en 503 « le node n'a pas répondu ». Une restauration
   * depuis le compartiment se refuse pourtant pour des raisons précises, que
   * le daemon écrit — lien expiré, archive servie sous un autre type, adresse
   * privée non autorisée dans sa configuration — et que personne ne lisait.
   */
  private async relay<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof WingsUnavailableError) {
        if (error.isRefusal && error.detail) throw new BadRequestException(error.detail);
        this.logger.warn(`Relais vers le daemon : ${error.message}`);
        throw new ServiceUnavailableException(DAEMON_UNAVAILABLE_MESSAGE);
      }
      throw error;
    }
  }
}

/**
 * Lit une tâche planifiée depuis un corps de requête.
 *
 * La validation est exhaustive ici plutôt que répartie dans le service : c'est
 * la frontière entre ce que quelqu'un a envoyé et ce que le code tient pour
 * vrai, et la franchir à moitié laisse passer une expression cron que le
 * planificateur ne saura pas lire — donc une tâche qui ne part jamais, sans
 * message.
 */
function parseSchedule(body: unknown): {
  name: string;
  cron: CronFields;
  options: { onlyWhenOnline: boolean; isActive: boolean };
  tasks: ScheduleTaskInput[];
} {
  const raw = (body ?? {}) as Record<string, unknown>;

  if (typeof raw.name !== "string" || raw.name.trim() === "") {
    throw new BadRequestException("Nom de tâche manquant.");
  }

  const cron = raw.cron as Partial<CronFields> | undefined;
  const fields: (keyof CronFields)[] = ["minute", "hour", "dayOfMonth", "month", "dayOfWeek"];
  if (!cron || fields.some((f) => typeof cron[f] !== "string")) {
    throw new BadRequestException("Expression cron incomplète.");
  }
  // Les cinq champs sont recopiés un par un, et non repris en bloc : c'est ce
  // qui garantit qu'aucune autre clé du corps ne se retrouve dans l'objet.
  const parsed: CronFields = {
    minute: cron.minute as string,
    hour: cron.hour as string,
    dayOfMonth: cron.dayOfMonth as string,
    month: cron.month as string,
    dayOfWeek: cron.dayOfWeek as string,
  };

  try {
    assertValidCron(parsed);
  } catch (error) {
    if (error instanceof CronSyntaxError) throw new BadRequestException(error.message);
    throw error;
  }

  const tasks = Array.isArray(raw.tasks) ? raw.tasks : [];
  if (tasks.length > MAX_SCHEDULE_TASKS) {
    throw new BadRequestException(`Une tâche compte au plus ${MAX_SCHEDULE_TASKS} étapes.`);
  }
  const parsedTasks = tasks.map((entry, index) => {
    const task = (entry ?? {}) as Record<string, unknown>;
    if (!SUPPORTED_ACTIONS.includes(task.action as SupportedAction)) {
      throw new BadRequestException(
        `Étape ${index + 1} : action « ${String(task.action)} » non prise en charge.`,
      );
    }
    /*
     * Le décalage est borné, et ce n'est pas une question de confort : le
     * planificateur l'attend réellement. Les séquences avancent en parallèle,
     * mais le nombre de places est fini — un décalage d'un milliard de
     * secondes immobiliserait l'une d'elles jusqu'au redémarrage. Même
     * plafond que Pterodactyl.
     */
    const timeOffset = Number.isFinite(Number(task.timeOffset)) ? Number(task.timeOffset) : 0;
    if (timeOffset < 0 || timeOffset > MAX_TASK_OFFSET_SECONDS) {
      throw new BadRequestException(
        `Étape ${index + 1} : le décalage doit être compris entre 0 et ${MAX_TASK_OFFSET_SECONDS} secondes.`,
      );
    }
    return {
      action: task.action as SupportedAction,
      payload: typeof task.payload === "string" ? task.payload : "",
      timeOffset,
      continueOnFailure: task.continueOnFailure === true,
    };
  });

  return {
    name: raw.name,
    cron: parsed,
    options: {
      onlyWhenOnline: raw.onlyWhenOnline !== false,
      isActive: raw.isActive !== false,
    },
    tasks: parsedTasks,
  };
}
