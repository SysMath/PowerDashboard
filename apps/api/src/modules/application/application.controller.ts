import {
  ApplicationServerCreate,
  ApplicationServerOwner,
  ApplicationUserCreate,
  ApplicationUserUpdate,
  ServerLimitsPatch,
} from "@gamedashboard/contracts";
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Headers,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { singleQuery } from "../../common/query-param";
import { isUuid } from "../../common/uuid";
import { ActivityService } from "../activity/activity.service";
import { AdminActionsService } from "../admin/admin-actions.service";
import { AdminServerService } from "../admin/admin-server.service";
import { BillingSsoService } from "../auth/billing-sso.service";
import { ServerResizeService } from "../client/server-resize.service";
import { BrandingService } from "../reseller/branding.service";
import { ResellerQuotaService } from "../reseller/reseller-quota.service";
import { DAEMON_UNAVAILABLE_MESSAGE, WingsUnavailableError } from "../wings/wings-client.service";
import {
  ApplicationGuard,
  type ApplicationRequest,
  PlatformOnly,
  RequireScopes,
} from "./application.guard";
import { ApplicationService } from "./application.service";
import { IdempotencyService } from "./idempotency.service";
import { ResellerScopeService } from "./reseller-scope.service";

/*
 * Création et correction de comptes et de serveurs : schémas bornés, partagés
 * par `@gamedashboard/contracts` (NC-23). Ils vivaient ici sans aucune borne.
 */
const CreateUser = ApplicationUserCreate;
const UpdateUser = ApplicationUserUpdate;
const CreateServer = ApplicationServerCreate;

const Suspension = z.object({
  suspended: z.boolean(),
  reason: z.string().optional(),
});

const Quota = z.object({
  memoryMb: z.number().int().min(0).nullable(),
  diskMb: z.number().int().min(0).nullable(),
  serversMax: z.number().int().min(0).nullable(),
});

/**
 * API applicative : le point d'entrée des systèmes tiers (§5.2).
 *
 * Elle existe parce que la facturation ne vit pas dans ce projet. La boutique
 * encaisse, puis demande ici — créer un compte, créer un serveur, suspendre sur
 * impayé, supprimer à la résiliation.
 *
 * Trois choix de fond, et chacun se voit dans le code plutôt que dans une note :
 *
 * 1. **Un préfixe d'URL à part.** `/api/v1/application` n'est ni l'API du panel
 *    (`/api/v1/client`) ni celle du daemon (`/api/remote`). Une route ajoutée
 *    au panel n'apparaît jamais ici par accident, et l'inverse est vrai aussi.
 * 2. **Une clé, jamais un cookie.** `ApplicationGuard` ignore la session : une
 *    page visitée par un administrateur connecté ne doit pas pouvoir
 *    provisionner en son nom, or un navigateur joint ses cookies tout seul.
 * 3. **Des portées déclarées route par route.** Aucune n'est déduite d'une
 *    autre : créer n'autorise ni à lister ni à supprimer.
 */
/**
 * Ce que l'agent de certificats rend d'une tentative.
 *
 * Les trois champs sont facultatifs et leur **combinaison** porte le sens :
 * un motif d'échec seul dit que rien n'a été obtenu ; des dates seules disent
 * que tout s'est bien passé ; les deux ensemble disent qu'un renouvellement a
 * échoué alors que l'ancien certificat tient encore — le moment précis où il
 * faut prévenir.
 */
const CertificateResult = z.object({
  issuedAt: z.string().nullable().optional(),
  expiresAt: z.string().nullable().optional(),
  failure: z.string().nullable().optional(),
});

@Controller("api/v1/application")
@UseGuards(ApplicationGuard)
export class ApplicationController {
  private readonly logger = new Logger(ApplicationController.name);

  constructor(
    @Inject(ApplicationService) private readonly app: ApplicationService,
    @Inject(AdminActionsService) private readonly actions: AdminActionsService,
    @Inject(ResellerQuotaService) private readonly quotas: ResellerQuotaService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(ActivityService) private readonly activity: ActivityService,
    @Inject(BillingSsoService) private readonly billingSso: BillingSsoService,
    @Inject(ResellerScopeService) private readonly scope: ResellerScopeService,
    @Inject(BrandingService) private readonly branding: BrandingService,
    // La même porte que l'espace revendeur et l'administration : un quota qui
    // se ferait contourner par l'une des trois ne bornerait rien.
    @Inject(ServerResizeService) private readonly resize: ServerResizeService,
    // Le changement de titulaire de l'administration, et non une copie : le
    // consentement du revendeur et la révocation des consoles y vivent.
    @Inject(AdminServerService) private readonly adminServers: AdminServerService,
  ) {}

  /**
   * Ce que cette clé est autorisée à faire.
   *
   * La première route que tout intégrateur appelle : elle confirme que la clé
   * passe, depuis cette adresse IP, avec ces portées — sans rien créer. Sans
   * elle, la mise en service se ferait en tentant une vraie écriture.
   */
  @Get("identity")
  @RequireScopes()
  identity(@Req() request: ApplicationRequest) {
    return {
      data: {
        name: request.application.name,
        scopes: request.application.scopes,
      },
    };
  }

  /* --- Comptes -------------------------------------------------------------- */

  @Get("users")
  @RequireScopes("users.read")
  async findUser(
    @Req() request: ApplicationRequest,
    @Query("email") email?: unknown,
    @Query("externalId") externalId?: unknown,
    @Query("id") id?: unknown,
  ) {
    const user = await this.app.findUser({
      id: singleQuery(id, "id"),
      email: singleQuery(email, "email"),
      externalId: singleQuery(externalId, "externalId"),
    });
    // 404 plutôt qu'une liste vide : la route cherche **un** compte, et rendre
    // `[]` obligerait chaque intégration à écrire le même `if (length === 0)`.
    if (!user) throw new NotFoundException("Compte introuvable.");
    // Une clé de revendeur ne lit que ses clients. Le refus emprunte le même
    // message que l'absence : les distinguer renseignerait sur les clients des
    // autres revendeurs.
    await this.scope.requireUser(request.application.resellerId, user.id);
    return { data: user };
  }

  @Get("users/:userId")
  @RequireScopes("users.read")
  async user(@Req() request: ApplicationRequest, @Param("userId") userId: string) {
    await this.scope.requireUser(request.application.resellerId, userId);
    const user = await this.app.findUser({ id: userId });
    if (!user) throw new NotFoundException("Compte introuvable.");
    return { data: user };
  }

  @Post("users")
  @RequireScopes("users.write")
  async createUser(
    @Req() request: ApplicationRequest,
    @Body() body: unknown,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    const input = parse(CreateUser, body);

    const data = await this.idempotency.run(
      request.application.keyId,
      "POST /users",
      idempotencyKey,
      input,
      async () => {
        // Créé par une clé de revendeur, le compte lui est rattaché : sa
        // boutique pourra lui livrer un serveur (`requireRecipient`).
        const user = await this.app.createUser(input, request.application.resellerId);
        await this.trace(request, "application.user_created", null, {
          userId: user.id,
          resellerId: request.application.resellerId,
        });
        return { data: user };
      },
    );

    return data;
  }

  @Patch("users/:userId")
  @RequireScopes("users.write")
  async updateUser(
    @Req() request: ApplicationRequest,
    @Param("userId") userId: string,
    @Body() body: unknown,
  ) {
    // Entièrement à lui, et pas seulement lisible : réécrire l'identifiant
    // externe d'un client partagé coupait la facturation du confrère.
    await this.scope.requireOwnedUser(request.application.resellerId, userId);
    const user = await this.app.updateUser(userId, parse(UpdateUser, body));
    await this.trace(request, "application.user_updated", null, { userId });
    return { data: user };
  }

  /**
   * Supprime un compte.
   *
   * Refusé tant qu'il possède des serveurs, comme depuis l'administration : la
   * contrainte existe en base, mais la vérifier ici permet de dire **combien**
   * bloquent, donc quoi faire — les supprimer d'abord.
   */
  @Delete("users/:userId")
  @RequireScopes("users.delete")
  async deleteUser(@Req() request: ApplicationRequest, @Param("userId") userId: string) {
    await this.scope.requireOwnedUser(request.application.resellerId, userId);

    const owned = await this.app.ownedServers(userId);
    if (owned > 0) {
      throw new ConflictException(
        `Ce compte possède ${owned} serveur(s). Supprimez-les avant le compte.`,
      );
    }

    await this.actions.deleteUser("application:platform", userId);
    await this.trace(request, "application.user_deleted", null, { userId });
    return { data: { deleted: userId } };
  }

  /**
   * Un lien de connexion pour un client, à usage unique.
   *
   * **C'est le chemin d'entrée ordinaire du client**, pas une commodité : il
   * n'a pas de mot de passe sur ce panel, il a un compte chez le facturier. Le
   * plugin installé là-bas appelle cette route derrière son bouton « Gérer mon
   * serveur » et redirige vers l'URL rendue.
   *
   * Le client se désigne par `externalId` — son identifiant **chez vous** —
   * plutôt que par celui du panel : vous connaissez vos clients, et retenir nos
   * identifiants vous obligerait à tenir une correspondance qui se
   * désynchronise au premier incident.
   *
   * Le compte doit exister : créez-le à la commande par `POST users`. Le panel
   * refuse d'ouvrir une session pour quelqu'un qu'il ne connaît pas, et refuse
   * toujours pour un compte du personnel.
   */
  @Post("users/sso-link")
  @RequireScopes("users.sso")
  async ssoLink(@Req() request: ApplicationRequest, @Body() body: unknown) {
    const { userId, externalId } = (body ?? {}) as { userId?: unknown; externalId?: unknown };
    const criteria = {
      ...(typeof userId === "string" && userId !== "" ? { userId } : {}),
      ...(typeof externalId === "string" && externalId !== "" ? { externalId } : {}),
    };

    /*
     * Le périmètre est vérifié **avant** l'émission.
     *
     * C'est la route la plus sensible de l'API : elle ouvre une session au nom
     * de quelqu'un. Une clé de revendeur qui pourrait la demander pour un
     * client de la plateforme entrerait dans un compte qui ne la regarde pas.
     */
    const link = await this.billingSso.issue(criteria, request.application.resellerId);

    // L'URL n'est **pas** journalisée : elle porte le jeton, et un journal lu
    // par plusieurs personnes deviendrait une réserve de sessions ouvertes.
    await this.trace(request, "application.sso_link_issued", null, criteria);
    return { data: link };
  }

  /* --- Serveurs ------------------------------------------------------------- */

  @Get("servers")
  @RequireScopes("servers.read")
  async servers(@Req() request: ApplicationRequest, @Query("ownerId") ownerId?: unknown) {
    return {
      data: await this.app.servers({
        ownerId: singleQuery(ownerId, "ownerId"),
        resellerId: request.application.resellerId,
      }),
    };
  }

  @Get("servers/:serverId")
  @RequireScopes("servers.read")
  async server(@Req() request: ApplicationRequest, @Param("serverId") serverId: string) {
    return { data: await this.app.server(serverId, request.application.resellerId) };
  }

  /**
   * Crée un serveur pour un client.
   *
   * L'en-tête `Idempotency-Key` est la précaution qui compte : une réponse
   * perdue, une file qui réémet, un humain qui reclique — sans elle, chacun de
   * ces accidents crée un second serveur facturé une fois.
   */
  @Post("servers")
  @RequireScopes("servers.create")
  async createServer(
    @Req() request: ApplicationRequest,
    @Body() body: unknown,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    const input = parse(CreateServer, body);

    return this.idempotency.run(
      request.application.keyId,
      "POST /servers",
      idempotencyKey,
      input,
      async () => {
        /*
         * Donner un serveur fait entrer le compte dans le périmètre de la
         * clé : sans ce contrôle, une clé de revendeur annexait le client
         * d'un confrère ou un administrateur, puis lisait et réécrivait sa
         * fiche.
         *
         * **Dans** le travail idempotent, et non avant : une boutique qui a
         * perdu la réponse et rejoue doit retrouver son serveur, même si le
         * compte a changé entre-temps (invité ailleurs, suspendu). Contrôlé
         * avant, le rejeu rendait 404 pour un serveur bel et bien créé.
         */
        await this.scope.requireRecipient(request.application.resellerId, input.ownerId);
        const server = await this.relay(() =>
          this.app.createServer(input, request.application.resellerId),
        );
        await this.trace(request, "application.server_created", server.id, {
          ownerId: input.ownerId,
          planId: input.planId ?? null,
        });
        return { data: server };
      },
    );
  }

  /**
   * Suspend ou rétablit un serveur — le geste de l'impayé et de la régularisation.
   *
   * Une seule route pour les deux sens, avec un booléen : deux routes
   * symétriques finissent toujours par diverger, et c'est celle qui rétablit
   * qu'on oublie de tenir à jour.
   */
  @Post("servers/:serverId/suspension")
  @RequireScopes("servers.suspend")
  async setSuspension(
    @Req() request: ApplicationRequest,
    @Param("serverId") serverId: string,
    @Body() body: unknown,
  ) {
    const { suspended, reason } = parse(Suspension, body);

    await this.scope.requireServer(request.application.resellerId, serverId);
    await this.actions.setServerSuspended(serverId, suspended, reason ?? "");
    await this.trace(
      request,
      suspended ? "application.server_suspended" : "application.server_resumed",
      serverId,
      { reason: reason ?? null },
    );

    return { data: { serverId, suspended } };
  }

  /**
   * Changer les limites d'un serveur — la montée en gamme.
   *
   * C'est l'événement le plus ordinaire de l'hébergement, et il n'avait aucun
   * chemin : la boutique pouvait créer, suspendre et supprimer, mais pas
   * agrandir. Le seul contournement était de supprimer et recréer, c'est-à-dire
   * de perdre le monde du client pour lui vendre plus de mémoire.
   *
   * `PATCH` et non `PUT` : le corps ne porte que ce qui change, et une
   * facturation qui n'envoie que la mémoire ne doit pas remettre le reste à
   * zéro.
   */
  @Patch("servers/:serverId")
  @RequireScopes("servers.resize")
  async resizeServer(
    @Req() request: ApplicationRequest,
    @Param("serverId") serverId: string,
    @Body() body: unknown,
  ) {
    const patch = parse(ServerLimitsPatch, body);

    await this.scope.requireServer(request.application.resellerId, serverId);
    const limites = await this.resize.resize(
      {
        id: request.application.keyId,
        role: "admin",
        // Le rattachement de la clé : une boutique de revendeur agrandit chez
        // lui, et la capacité doit être évaluée sur sa part, pas sur le
        // matériel entier.
        onBehalfOf: request.application.resellerId,
      },
      serverId,
      patch,
    );

    await this.trace(request, "application.server_resized", serverId, { ...patch });
    return { data: limites };
  }

  /**
   * Change le titulaire d'un serveur : le service a changé de client chez le
   * facturier, le serveur suit.
   *
   * Sans cette route, le module de facturation créait bien le compte du
   * nouveau client mais devait rendre un échec et laisser le geste à la main
   * — pendant quoi l'ancien titulaire gardait la console d'un serveur qu'il
   * ne payait plus.
   *
   * Tout le métier est celui de l'administration (`AdminServerService.setOwner`) :
   * le revendeur hébergeur reste, un revendeur qui refuse le provisionnement
   * ne se voit rien imposer, et ce que l'ancien titulaire avait installé
   * autour du serveur s'en va — sous-utilisateurs, invitations, rappels
   * sortants, mots de passe des bases, sessions SFTP et consoles ouvertes.
   * S'y ajoute le périmètre de la clé, des deux côtés : le serveur doit être chez elle, et le destinataire aussi — ou
   * n'avoir encore aucun serveur, cas du client tout juste créé.
   *
   * Pas d'`Idempotency-Key` : rejouer le même transfert ne fait rien de plus
   * que le premier, et rend son bilan (`changed: false`).
   */
  @Post("servers/:serverId/owner")
  @RequireScopes("servers.owner")
  async setServerOwner(
    @Req() request: ApplicationRequest,
    @Param("serverId") serverId: string,
    @Body() body: unknown,
  ) {
    const { ownerId } = parse(ApplicationServerOwner, body);

    await this.scope.requireServer(request.application.resellerId, serverId);
    await this.scope.requireRecipient(request.application.resellerId, ownerId);
    // Même trace que `trace()`, mais écrite dans la transaction du
    // changement : c'est elle qui coupe le journal de l'ancien titulaire.
    const nettoyage = await this.adminServers.setOwner(serverId, ownerId, {
      event: "application.server_owner_changed",
      actorId: null,
      actorType: "api_key",
      actorLabel: `application:${request.application.name}`,
      ip: request.ip ?? null,
    });

    /*
     * Le bilan revient à la facturation, qui est seule à le voir au moment du
     * geste : une base restée sur son ancien mot de passe se signale à son
     * administrateur, pas dans un journal qu'il ne lit pas. Les comptes dont
     * la session n'a pu être fermée ne sont que comptés : un invité n'est
     * pas forcément un client de cette clé.
     */
    return {
      data: {
        serverId,
        ownerId,
        cleanup: {
          changed: nettoyage.changed,
          subusersRemoved: nettoyage.subusersRemoved,
          invitesRemoved: nettoyage.invitesRemoved,
          webhooksRemoved: nettoyage.webhooksRemoved,
          databasesRotated: nettoyage.databasesRotated,
          databasesNotRotated: nettoyage.databasesNotRotated,
          sessionsNotClosed: nettoyage.sessionsNotClosed.length,
        },
      },
    };
  }

  @Delete("servers/:serverId")
  @RequireScopes("servers.delete")
  async deleteServer(@Req() request: ApplicationRequest, @Param("serverId") serverId: string) {
    await this.scope.requireServer(request.application.resellerId, serverId);
    await this.relay(() => this.actions.deleteServer(serverId));
    await this.trace(request, "application.server_deleted", null, { serverId });
    return { data: { deleted: serverId } };
  }

  /* --- Revendeurs ----------------------------------------------------------- */

  @Get("resellers/:userId/quota")
  @RequireScopes("resellers.read")
  @PlatformOnly("les enveloppes de revente")
  async quota(@Param("userId") userId: string) {
    if (!isUuid(userId)) throw new NotFoundException("Compte introuvable.");
    return { data: await this.quotas.report(userId) };
  }

  /**
   * Pose l'enveloppe d'un revendeur, telle que son abonnement la définit.
   *
   * `PUT` et non `PATCH` : les trois dimensions sont remplacées ensemble.
   * `null` veut dire **sans limite** ; un champ omis est refusé, pour que
   * « je n'ai rien dit » ne puisse pas ouvrir la vanne.
   */
  @Put("resellers/:userId/quota")
  @RequireScopes("resellers.write")
  @PlatformOnly("les enveloppes de revente")
  async setQuota(
    @Req() request: ApplicationRequest,
    @Param("userId") userId: string,
    @Body() body: unknown,
  ) {
    if (!isUuid(userId)) throw new NotFoundException("Compte introuvable.");
    const quota = parse(Quota, body);
    await this.quotas.setQuota(userId, quota);
    await this.trace(request, "application.reseller_quota_set", null, { userId, ...quota });
    return { data: { userId, quota } };
  }

  /* --- Certificats des domaines --------------------------------------------- */
  /*
   * Les deux routes de l'agent de certificats.
   *
   * Elles vivent dans l'API applicative parce que l'agent est exactement ce
   * qu'elle sert : une machine qui parle au panel avec une clé. Il tourne sur
   * le serveur web de la plateforme, là où vivent nginx et certbot — que le
   * panel, lui, ne peut pas atteindre.
   */

  /**
   * Les domaines vérifiés et l'état de leur certificat, puis les domaines
   * déclarés non vérifiés (`verified: false`, jamais `pending`), à qui l'agent
   * ne pose qu'une page d'attente sur le port 80.
   *
   * `pending` est calculé **ici** et non dans l'agent : la règle de reprise —
   * pas de certificat, expiration proche, ou échec vieux d'une heure —
   * appartient au panel. Un agent qui la réinventerait finirait par redemander
   * tous les quarts d'heure un certificat que l'autorité vient de refuser, et
   * la limite de débit tomberait.
   */
  @Get("domains/certificates")
  @RequireScopes("domains.certificates")
  @PlatformOnly("la délivrance des certificats")
  async domainCertificates() {
    return { data: await this.branding.certificateQueue() };
  }

  /**
   * L'issue d'une tentative, réussie ou non.
   *
   * Le motif d'échec est une phrase destinée à un humain, pas un journal ACME :
   * ce qu'un administrateur doit savoir, c'est à qui est le problème — au
   * revendeur qui n'a pas pointé sa zone, à nous, ou à l'autorité.
   */
  @Post("domains/:domain/certificate")
  @RequireScopes("domains.certificates")
  @PlatformOnly("la délivrance des certificats")
  async reportCertificate(
    @Req() request: ApplicationRequest,
    @Param("domain") domain: string,
    @Body() body: unknown,
  ) {
    const result = parse(CertificateResult, body);
    await this.branding.recordCertificate(domain, result);

    await this.trace(request, "application.domain_certificate_reported", null, {
      domain,
      issued: (result.failure ?? null) === null,
    });

    return { data: { domain } };
  }

  /* --- Infrastructure, en lecture seule ------------------------------------- */

  @Get("nodes")
  @RequireScopes("infrastructure.read")
  async nodes(@Req() request: ApplicationRequest) {
    return { data: await this.app.nodes(request.application.resellerId) };
  }

  @Get("locations")
  @RequireScopes("infrastructure.read")
  async locations() {
    return { data: await this.app.locations() };
  }

  @Get("plans")
  @RequireScopes("infrastructure.read")
  async plans() {
    return { data: await this.app.plans() };
  }

  @Get("eggs")
  @RequireScopes("infrastructure.read")
  async eggs() {
    return { data: await this.app.eggs() };
  }

  /* --- Outillage ------------------------------------------------------------ */

  /**
   * Consigne l'acte au journal d'audit.
   *
   * `actorType: "api_key"` et le nom de la clé en libellé : le jour où un
   * serveur disparaît, la question posée est « qui », et « la boutique » est
   * une réponse, « un administrateur » n'en serait pas une.
   */
  private async trace(
    request: ApplicationRequest,
    event: string,
    serverId: string | null,
    properties: Record<string, unknown>,
  ): Promise<void> {
    await this.activity.record({
      event,
      serverId,
      // Aucun identifiant de compte : cet acte n'est celui de personne.
      actorId: null,
      actorType: "api_key",
      actorLabel: `application:${request.application.name}`,
      ip: request.ip ?? null,
      properties,
    });
  }

  /** Voir `ServerRuntimeController.relay` : un node muet n'est pas un bogue du panel. */
  private async relay<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof WingsUnavailableError) {
        // Le nom interne du node et la cause brute ne sortent pas du panel,
        // pas plus vers une boutique que vers un navigateur.
        this.logger.warn(`Relais vers le daemon : ${error.message}`);
        throw new ServiceUnavailableException(DAEMON_UNAVAILABLE_MESSAGE);
      }
      throw error;
    }
  }
}

/** Les messages de zod dans la langue du panel. */
const MESSAGES_ZOD = z.locales.fr();

/**
 * Valide un corps, et ne rend que le premier manquement.
 *
 * Le chemin du champ est inclus : un intégrateur qui lit « invalide » sans
 * savoir où passe la journée à deviner.
 */
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  // Sans corps, zod répondait dans sa langue (« Invalid input: expected
  // object ») : le message part tel quel vers le facturier.
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new BadRequestException("Corps de requête manquant : un objet JSON est attendu.");
  }
  // Les messages de zod en français : ils partent tels quels vers le
  // facturier (« Invalid input: expected string… » pour un champ absent).
  // Un message écrit dans le schéma garde la priorité.
  const result = schema.safeParse(body, { error: MESSAGES_ZOD.localeError });
  if (result.success) return result.data;

  const issue = result.error.issues[0];
  const path = issue?.path.join(".");
  throw new BadRequestException(
    path ? `Champ « ${path} » : ${issue?.message}` : (issue?.message ?? "Requête invalide."),
  );
}
