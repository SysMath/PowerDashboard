import {
  isBrandImageKind,
  PLATFORM_ACCESS_LEVELS,
  ServerLimitsPatch,
} from "@gamedashboard/contracts";
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { ActivityService } from "../activity/activity.service";
import { AdminActionsService } from "../admin/admin-actions.service";
import { StaffTwoFactorGuard } from "../admin/staff-2fa.guard";
import { ApplicationKeysService } from "../application/application-keys.service";
import { ResellerScopeService } from "../application/reseller-scope.service";
import { ImpersonationReadOnlyGuard } from "../auth/impersonation.guard";
import type { AuthenticatedRequest } from "../auth/session.guard";
import { SessionGuard } from "../auth/session.guard";
import { ServerResizeService } from "../client/server-resize.service";
import { WebhookRegistryService } from "../webhooks/webhook-registry.service";
import { BrandImagesService } from "./brand-images.service";
import { BrandingService, brandImageBases, brandingInput } from "./branding.service";
import { ResellerGuard } from "./reseller.guard";
import { ResellerService } from "./reseller.service";
import { ResellerQuotaService } from "./reseller-quota.service";

/**
 * Le niveau que le revendeur se choisit.
 *
 * Une énumération et non un booléen : le réglage précédent n'avait que deux
 * positions et n'en tenait qu'une — il refusait la création, et laissait la
 * console, les fichiers et la suppression.
 */
const PlatformAccessChoice = z.object({ level: z.enum(PLATFORM_ACCESS_LEVELS) });

/** Suspendre ou rétablir : un seul geste, un booléen, et un motif facultatif. */
const ResellerSuspension = z.object({
  suspended: z.boolean(),
  reason: z.string().max(500).optional(),
});

/**
 * Ce qu'un revendeur peut demander pour sa clé.
 *
 * **Pas de `resellerId`** : le périmètre vient de la session. L'accepter ici
 * ferait de cette route le moyen exact qu'on cherche à fermer — obtenir une
 * clé pour le parc d'un confrère.
 */
const ResellerKey = z.object({
  name: z.string().min(1),
  scopes: z.array(z.string()),
  allowedIps: z.array(z.string()).optional(),
  expiresInDays: z.number().int().optional(),
});

/**
 * Ce qu'un revendeur peut demander pour un rappel sortant.
 *
 * La clé désignée doit être une des siennes, et le registre le vérifie avec le
 * périmètre de la session. Accepter la clé sans ce contrôle ferait de cette
 * route un moyen de brancher un rappel sur la clé d'un confrère — c'est-à-dire
 * de recevoir son trafic sans jamais toucher à sa clé.
 */
const ResellerWebhook = z.object({
  applicationKeyId: z.string().uuid(),
  url: z.string().min(1),
  events: z.array(z.string()),
});

const ResellerWebhookActive = z.object({ active: z.boolean() });

/** `AuthenticatedRequest` ne porte pas l'adresse : Fastify la pose à part. */
type ResellerRequest = AuthenticatedRequest & { ip?: string };

/**
 * Espace revendeur.
 *
 * Aucune route ne prend d'identifiant de compte : le revendeur est celui que la
 * session a reconnu. En accepter un ferait de cet espace un moyen de lire le
 * parc d'un confrère en changeant un paramètre.
 */
@Controller("api/v1/reseller")
// Même exigence de seconde preuve que pour le personnel (§5.1) : un revendeur
// tient le parc de ses clients, un mot de passe seul ne suffit pas.
//
// Lecture seule en prise en main, comme l'espace client : sans ce garde, un
// agent entré chez un revendeur se donnait le consentement de provisionnement,
// émettait une clé ou supprimait un serveur, et le journal l'imputait au
// revendeur. La cible est refusée en amont (`impersonationTarget`) ; ce garde
// tient le cas d'une session empruntée devenue celle d'un revendeur en route.
@UseGuards(SessionGuard, ResellerGuard, StaffTwoFactorGuard, ImpersonationReadOnlyGuard)
export class ResellerController {
  constructor(
    @Inject(ResellerService) private readonly reseller: ResellerService,
    @Inject(ActivityService) private readonly activity: ActivityService,
    @Inject(ResellerQuotaService) private readonly quotas: ResellerQuotaService,
    @Inject(ApplicationKeysService) private readonly keys_: ApplicationKeysService,
    @Inject(BrandingService) private readonly branding_: BrandingService,
    @Inject(BrandImagesService) private readonly images_: BrandImagesService,
    @Inject(WebhookRegistryService) private readonly webhooks_: WebhookRegistryService,
    // Le périmètre : « ce serveur est-il sur mon parc ? ». Le même service que
    // celui qui borne les clés applicatives — une seule règle, un seul endroit.
    @Inject(ResellerScopeService) private readonly scope_: ResellerScopeService,
    // Les gestes eux-mêmes, partagés avec l'administration et la boutique.
    @Inject(AdminActionsService) private readonly actions_: AdminActionsService,
    // Le redimensionnement, partagé avec la boutique et l'administration.
    @Inject(ServerResizeService) private readonly resize_: ServerResizeService,
  ) {}

  /* --- Marque blanche et domaine propre ---------------------------------- */

  /**
   * Personnalisation du revendeur, telle qu'il l'a saisie.
   *
   * Sans replis : le formulaire doit distinguer « je n'ai rien mis » de « j'ai
   * mis la même valeur que la plateforme », sans quoi un champ vidé
   * réapparaîtrait rempli au rechargement.
   */
  @Get("branding")
  async branding(@Req() request: ResellerRequest) {
    const [overrides, domain] = await Promise.all([
      this.branding_.overridesFor(request.user.id),
      this.branding_.domainState(request.user.id),
    ]);

    return { data: { overrides, domain } };
  }

  @Post("branding")
  async saveBranding(@Req() request: ResellerRequest, @Body() body: unknown) {
    // `imageBases` : la valeur de logo et de favicon que le formulaire a vue en
    // dernier. Une image envoyée depuis n'est pas écrasée (`saveWithBases`).
    const { overrides, keptImages } = await this.branding_.saveWithBases(
      request.user.id,
      brandingInput(body),
      brandImageBases(body),
    );
    // Un logo envoyé que le champ ne désigne plus (vidé, ou remplacé par une
    // adresse) n'a plus de raison d'occuper la base.
    await this.images_.prune(request.user.id);

    await this.activity.record({
      event: "reseller.branding_saved",
      serverId: null,
      actorId: request.user.id,
      actorType: "user",
      actorLabel: request.user.email,
      ip: request.ip ?? null,
      properties: keptImages.length > 0 ? { keptImages } : {},
    });

    // `keptImages` s'ajoute aux champs : la réponse reste la marque enregistrée.
    return { data: { ...overrides, keptImages } };
  }

  /**
   * Envoi du logo ou du favicon par fichier (corps `application/octet-stream`).
   *
   * Le type est lu dans les octets, pas dans le nom : PNG, JPEG, WebP ou ICO,
   * jamais de SVG. L'adresse interne rendue est aussitôt celle de la marque.
   */
  @Post("branding/images/:kind")
  async uploadBrandImage(
    @Req() request: ResellerRequest,
    @Param("kind") kind: string,
    @Body() body: unknown,
  ) {
    if (!isBrandImageKind(kind)) throw new BadRequestException("Image de marque inconnue.");
    const url = await this.images_.uploadForReseller(request.user.id, kind, body);

    await this.activity.record({
      event: "reseller.branding_image_uploaded",
      serverId: null,
      actorId: request.user.id,
      actorType: "user",
      actorLabel: request.user.email,
      ip: request.ip ?? null,
      properties: { kind },
    });

    return { data: { url } };
  }

  /**
   * Déclare le domaine propre, ou le retire.
   *
   * La vérification repart de zéro à chaque changement : un domaine vérifié
   * hier n'atteste rien du nom saisi aujourd'hui.
   */
  @Post("branding/domain")
  async setDomain(@Req() request: ResellerRequest, @Body() body: unknown) {
    const domain = (body as { domain?: unknown })?.domain;
    const state = await this.branding_.setDomain(
      request.user.id,
      typeof domain === "string" ? domain : "",
    );

    await this.activity.record({
      event: "reseller.domain_declared",
      serverId: null,
      actorId: request.user.id,
      actorType: "user",
      actorLabel: request.user.email,
      ip: request.ip ?? null,
      properties: { domain: state.domain },
    });

    return { data: state };
  }

  /** Interroge le DNS : possession, puis acheminement. */
  @Post("branding/domain/verify")
  async verifyDomain(@Req() request: ResellerRequest) {
    const state = await this.branding_.verifyDomain(request.user.id);

    await this.activity.record({
      event: state.verifiedAt ? "reseller.domain_verified" : "reseller.domain_check_failed",
      serverId: null,
      actorId: request.user.id,
      actorType: "user",
      actorLabel: request.user.email,
      ip: request.ip ?? null,
      properties: { domain: state.domain, failure: state.failure },
    });

    return { data: state };
  }

  /**
   * Vue d'ensemble, en une réponse.
   *
   * Les trois listes sont servies ensemble parce que la page les montre
   * ensemble : trois aller-retours feraient apparaître l'écran par morceaux, et
   * les totaux sauteraient sous les yeux.
   */
  @Get("overview")
  async overview(@Req() request: ResellerRequest) {
    const [nodes, servers, clients, platformAccess, quota] = await Promise.all([
      this.reseller.nodes(request.user.id),
      this.reseller.servers(request.user.id),
      this.reseller.clients(request.user.id),
      this.reseller.platformAccess(request.user.id),
      // Le revendeur lit son enveloppe, il ne la modifie pas : c'est
      // l'administration qui l'accorde, sans quoi ce ne serait pas un plafond.
      this.quotas.report(request.user.id),
    ]);

    return { data: { nodes, servers, clients, platformAccess, quota } };
  }

  /**
   * Autorise, ou retire l'autorisation à, l'administration de la plateforme.
   *
   * Tracé au journal dans les deux sens. Retirer une permission est un
   * événement autant que l'accorder : le jour où un serveur apparaît sans
   * qu'on l'ait demandé, la question posée est « quand ai-je autorisé cela ».
   */
  @Post("platform-provisioning")
  async setPlatformAccess(@Req() request: ResellerRequest, @Body() body: unknown) {
    const parsed = PlatformAccessChoice.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Niveau d'accès attendu.");

    await this.reseller.setPlatformAccess(request.user.id, parsed.data.level);

    await this.activity.record({
      /*
       * Un seul événement, avec le niveau en propriété.
       *
       * Les deux événements précédents — « autorisé », « retiré » — ne savaient
       * dire qu'une bascule. À trois positions, ils auraient menti sur celle du
       * milieu, et la question qu'on pose au journal est « quel niveau, et
       * depuis quand », pas « dans quel sens ».
       */
      event: "reseller.platform_access_set",
      serverId: null,
      actorId: request.user.id,
      actorType: "user",
      actorLabel: request.user.email,
      ip: request.ip ?? null,
      properties: { level: parsed.data.level },
    });

    return { data: { level: parsed.data.level } };
  }

  /* --- Clés applicatives du revendeur ------------------------------------ */

  /**
   * Les clés du revendeur, et rien que les siennes.
   *
   * Un revendeur branche sa propre boutique : il lui faut une clé, et jusqu'ici
   * il fallait la demander à la plateforme, qui la lui remettait à la main.
   * Cela tenait tant qu'il y avait un revendeur ; cela ne tient plus à dix.
   *
   * Il ne voit jamais celles des autres, ni celles de la plateforme : le
   * service filtre en SQL, pas après coup.
   */
  @Get("keys")
  async keys(@Req() request: ResellerRequest) {
    return { data: await this.keys_.all(request.user.id) };
  }

  /**
   * Émet une clé bornée à ce revendeur.
   *
   * **Le périmètre vient de la session, jamais du corps.** C'est toute la
   * sûreté de cette route : un revendeur ne peut pas demander une clé pour un
   * autre, ni pour la plateforme, parce que l'identifiant n'est pas un champ
   * qu'il remplit.
   *
   * Les portées réservées à la plateforme sont refusées à l'émission par le
   * service, plutôt qu'au premier appel : une clé qu'on croit large et qui se
   * fait refuser en production coûte bien plus cher qu'un refus ici.
   */
  @Post("keys")
  async createKey(@Req() request: ResellerRequest, @Body() body: unknown) {
    const parsed = ResellerKey.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? "Requête invalide.");
    }

    const created = await this.keys_.create(request.user.id, {
      ...parsed.data,
      resellerId: request.user.id,
    });

    await this.activity.record({
      event: "reseller.key_created",
      serverId: null,
      actorId: request.user.id,
      actorType: "user",
      actorLabel: request.user.email,
      ip: request.ip ?? null,
      // Le préfixe, jamais le secret : il identifie la clé dans le journal
      // sans permettre de s'en servir.
      properties: { prefix: created.key.prefix, scopes: created.key.scopes },
    });

    return { data: created };
  }

  /** Révoque une de ses clés. Celles des autres restent introuvables. */
  @Delete("keys/:keyId")
  async revokeKey(@Req() request: ResellerRequest, @Param("keyId") keyId: string) {
    await this.keys_.revoke(keyId, request.user.id);

    await this.activity.record({
      event: "reseller.key_revoked",
      serverId: null,
      actorId: request.user.id,
      actorType: "user",
      actorLabel: request.user.email,
      ip: request.ip ?? null,
      properties: { keyId },
    });

    return { data: { revoked: keyId } };
  }

  /* --- Rappels sortants ------------------------------------------------------
   *
   * Un revendeur déclare ses propres points d'entrée, sur ses propres clés.
   * Jusqu'ici, seule l'administration le pouvait : le rappel existait, mais il
   * fallait nous le demander — ce qui revenait à faire dépendre la mise en
   * service de sa boutique d'un geste chez nous.
   *
   * Ce qu'il reçoit est borné par la clé, pas par cet écran : un rappel posé
   * sur une clé de revendeur ne porte que le trafic de son parc, et c'est
   * l'émetteur qui s'en assure. L'écran ne fait que lui rendre la main.
   */

  /** Ses points d'entrée. Ceux des autres n'apparaissent pas. */
  @Get("webhooks")
  async webhooks(@Req() request: ResellerRequest) {
    return { data: await this.webhooks_.all(request.user.id) };
  }

  /**
   * Ses dernières livraisons : de quoi diagnostiquer une intégration muette.
   *
   * Sans cet écran, le diagnostic se ferait dans les journaux du processus,
   * c'est-à-dire chez nous — donc pas du tout, pour lui.
   */
  @Get("webhooks/deliveries")
  async webhookDeliveries(@Req() request: ResellerRequest) {
    return { data: await this.webhooks_.deliveries(50, request.user.id) };
  }

  /** Déclare un point d'entrée et rend son secret de signature, une seule fois. */
  @Post("webhooks")
  async createWebhook(@Req() request: ResellerRequest, @Body() body: unknown) {
    const parsed = ResellerWebhook.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? "Requête invalide.");
    }

    const created = await this.webhooks_.create(parsed.data, request.user.id);

    await this.activity.record({
      event: "reseller.webhook_created",
      serverId: null,
      actorId: request.user.id,
      actorType: "user",
      actorLabel: request.user.email,
      ip: request.ip ?? null,
      // L'URL est journalisée, le secret non : un journal est fait pour être
      // relu, exporté et conservé.
      properties: {
        webhookId: created.webhook.id,
        url: parsed.data.url,
        events: parsed.data.events,
      },
    });

    return { data: created };
  }

  /** Regénère le secret de signature. L'ancien cesse aussitôt d'être valable. */
  @Post("webhooks/:webhookId/secret")
  async rotateWebhookSecret(
    @Req() request: ResellerRequest,
    @Param("webhookId") webhookId: string,
  ) {
    const rotated = await this.webhooks_.rotateSecret(webhookId, request.user.id);

    await this.activity.record({
      event: "reseller.webhook_secret_rotated",
      serverId: null,
      actorId: request.user.id,
      actorType: "user",
      actorLabel: request.user.email,
      ip: request.ip ?? null,
      properties: { webhookId },
    });

    return { data: rotated };
  }

  /** Suspend ou rouvre un point d'entrée, sans perdre ce qui est en attente. */
  @Post("webhooks/:webhookId/active")
  async setWebhookActive(
    @Req() request: ResellerRequest,
    @Param("webhookId") webhookId: string,
    @Body() body: unknown,
  ) {
    const parsed = ResellerWebhookActive.safeParse(body);
    if (!parsed.success) throw new BadRequestException("État manquant.");

    await this.webhooks_.setActive(webhookId, parsed.data.active, request.user.id);

    // Seul geste de l'espace qui n'était pas consigné : couper un rappel rend
    // sa boutique sourde, et « depuis quand » est la première question.
    await this.activity.record({
      event: "reseller.webhook_active_set",
      serverId: null,
      actorId: request.user.id,
      actorType: "user",
      actorLabel: request.user.email,
      ip: request.ip ?? null,
      properties: { webhookId, active: parsed.data.active },
    });

    return { data: { webhookId, active: parsed.data.active } };
  }

  @Delete("webhooks/:webhookId")
  async removeWebhook(@Req() request: ResellerRequest, @Param("webhookId") webhookId: string) {
    await this.webhooks_.remove(webhookId, request.user.id);

    await this.activity.record({
      event: "reseller.webhook_deleted",
      serverId: null,
      actorId: request.user.id,
      actorType: "user",
      actorLabel: request.user.email,
      ip: request.ip ?? null,
      properties: { webhookId },
    });

    return { data: { deleted: webhookId } };
  }
  /* --- Son parc : les gestes qui manquaient --------------------------------
   *
   * Un revendeur pouvait tout **voir** de son parc et n'y rien **faire**. Ni
   * suspendre un impayé, ni rendre un serveur résilié : ces gestes
   * n'existaient que pour sa boutique, par clé applicative. Un revendeur sans
   * boutique — le cas le plus simple, celui qui prend une enveloppe et sert
   * quelques clients — n'avait aucun moyen d'agir.
   *
   * Les routes délèguent aux **mêmes services** que la clé applicative. Une
   * seconde implémentation de « suspendre » aurait fini par diverger sur le
   * contrôle qui compte, et c'est toujours celui-là qu'on oublie.
   */

  /**
   * Suspend ou rétablit un serveur de son parc.
   *
   * Une seule route pour les deux sens : deux routes symétriques finissent
   * toujours par diverger, et c'est celle qui rétablit qu'on oublie de tenir
   * à jour.
   */
  @Post("servers/:serverId/suspension")
  async setSuspension(
    @Req() request: ResellerRequest,
    @Param("serverId") serverId: string,
    @Body() body: unknown,
  ) {
    const parsed = ResellerSuspension.safeParse(body);
    if (!parsed.success) throw new BadRequestException("État de suspension attendu.");

    // Le périmètre d'abord, et il rend « introuvable » : un revendeur ne doit
    // pas pouvoir distinguer le serveur d'un confrère d'un serveur inexistant.
    await this.scope_.requireServer(request.user.id, serverId);
    const { sessionsNotClosed } = await this.actions_.setServerSuspended(
      serverId,
      parsed.data.suspended,
      parsed.data.reason ?? "",
    );

    await this.activity.record({
      event: parsed.data.suspended ? "reseller.server_suspended" : "reseller.server_resumed",
      serverId,
      actorId: request.user.id,
      actorType: "user",
      actorLabel: request.user.email,
      ip: request.ip ?? null,
      properties: parsed.data.suspended
        ? { reason: parsed.data.reason ?? null, sessionsNotClosed }
        : { reason: parsed.data.reason ?? null },
    });

    return { data: { serverId, suspended: parsed.data.suspended, sessionsNotClosed } };
  }

  /**
   * Change les limites d'un serveur de son parc.
   *
   * Un revendeur sans facturation branchée — le cas que l'on m'a rappelé — n'a
   * que cet écran pour faire monter un client en gamme. Sans lui, il devait
   * demander à la plateforme, ce qui contredit tout le modèle : la plateforme
   * loue de la machine, elle n'arbitre pas les offres de ses revendeurs.
   *
   * L'enveloppe s'applique à lui comme au reste : agrandir consomme, et c'est
   * son propre plafond qui borne ce qu'il peut vendre.
   */
  @Post("servers/:serverId/limits")
  async setServerLimits(
    @Req() request: ResellerRequest,
    @Param("serverId") serverId: string,
    @Body() body: unknown,
  ) {
    const parsed = ServerLimitsPatch.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? "Limites invalides.");
    }

    // Le périmètre d'abord, et il rend « introuvable ».
    await this.scope_.requireServer(request.user.id, serverId);
    const limites = await this.resize_.resize(
      { id: request.user.id, role: "reseller" },
      serverId,
      parsed.data,
    );

    await this.activity.record({
      event: "reseller.server_resized",
      serverId,
      actorId: request.user.id,
      actorType: "user",
      actorLabel: request.user.email,
      ip: request.ip ?? null,
      properties: { ...parsed.data },
    });

    return { data: limites };
  }

  /**
   * Supprime un serveur de son parc.
   *
   * Le geste de la résiliation. Il passe par le service d'administration, qui
   * prévient le daemon et refuse si la machine ne répond pas — supprimer la
   * ligne laisserait sinon un conteneur tourner sans que rien ne le rattache
   * plus à personne.
   */
  @Delete("servers/:serverId")
  async removeServer(@Req() request: ResellerRequest, @Param("serverId") serverId: string) {
    await this.scope_.requireServer(request.user.id, serverId);
    await this.actions_.deleteServer(serverId);

    await this.activity.record({
      event: "reseller.server_deleted",
      // Le serveur n'existe plus : l'y rattacher ferait échouer l'écriture.
      serverId: null,
      actorId: request.user.id,
      actorType: "user",
      actorLabel: request.user.email,
      ip: request.ip ?? null,
      properties: { serverId },
    });

    return { data: { deleted: serverId } };
  }
}
