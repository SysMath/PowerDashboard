import {
  isExternalHref,
  mailSender,
  type NotificationTarget,
  resolveNotificationHref,
} from "@gamedashboard/contracts";
import { type Database, notifications, servers, users } from "@gamedashboard/db";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { DATABASE } from "../../common/database.provider";
import { MailerService } from "../mail/mailer.service";
import { PushOutboxService } from "../push/push-outbox.service";
import { BrandingService } from "../reseller/branding.service";
import { ClientWebhookEmitterService } from "../webhooks/client-webhook-emitter.service";
import { NotificationPreferencesRepository } from "./notification-preferences.repository";

export type NotificationLevel = "info" | "success" | "warning" | "danger";

export interface ClientNotification {
  id: string;
  title: string;
  body: string;
  level: NotificationLevel;
  /** Contexte : nom du serveur concerné, quand il y en a un. */
  source: string | null;
  /**
   * Où mène la notification, ou `null` quand il n'y a rien à ouvrir.
   *
   * Calculée à la lecture et non rangée en base : un serveur supprimé, une
   * adresse d'espace client changée, et un lien figé à l'écriture mènerait
   * ailleurs — ou nulle part — des mois plus tard.
   */
  href: string | null;
  createdAt: string;
  readAt: string | null;
}

/**
 * Au-delà, la cloche devient une archive que personne ne déroule. Les anciennes
 * restent en base — `RetentionService` les retire trois mois après lecture —
 * mais n'encombrent pas l'écran.
 */
const PAGE_SIZE = 20;

/**
 * Notifications persistantes (§6.6).
 *
 * À ne pas confondre avec le journal d'activité : celui-ci retient **ce qui a
 * été fait**, pour l'audit ; celles-ci annoncent **ce qui vient d'arriver**, à
 * quelqu'un qui n'était pas devant l'écran. Une suppression de fichier
 * volontaire mérite une ligne de journal, pas une cloche.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(NotificationPreferencesRepository)
    private readonly preferences: NotificationPreferencesRepository,
    @Inject(MailerService) private readonly mail: MailerService,
    @Inject(ClientWebhookEmitterService)
    private readonly clientWebhooks: ClientWebhookEmitterService,
    @Inject(BrandingService) private readonly branding: BrandingService,
    @Inject(PushOutboxService) private readonly push: PushOutboxService,
  ) {}

  async forUser(userId: string): Promise<{ items: ClientNotification[]; unread: number }> {
    const rows = await this.db
      .select({
        id: notifications.id,
        type: notifications.type,
        title: notifications.title,
        body: notifications.body,
        data: notifications.data,
        readAt: notifications.readAt,
        createdAt: notifications.createdAt,
        serverName: servers.name,
      })
      .from(notifications)
      .leftJoin(servers, eq(sql`${notifications.data}->>'serverId'`, sql`${servers.id}::text`))
      .where(eq(notifications.userId, userId))
      .orderBy(desc(notifications.createdAt))
      .limit(PAGE_SIZE);

    const [count] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));

    return {
      unread: count?.n ?? 0,
      items: rows.map((row) => ({
        id: row.id,
        title: row.title,
        body: row.body,
        // Le niveau voyage dans `data` plutôt que dans une colonne : c'est une
        // décision d'affichage, et lui donner une colonne obligerait à migrer
        // la base chaque fois qu'on veut nuancer une couleur.
        level: readLevel(row.data),
        source: row.serverName,
        href: resolveNotificationHref(row.type, (row.data ?? {}) as NotificationTarget),
        createdAt: row.createdAt,
        readAt: row.readAt,
      })),
    };
  }

  /**
   * Marque tout comme lu.
   *
   * La condition `is null` fait partie de la requête : sans elle, rouvrir la
   * cloche réécrirait la date de lecture de notifications déjà lues, et on
   * perdrait le moment réel où la personne les a vues.
   */
  async markAllRead(userId: string): Promise<{ marked: number }> {
    const marked = await this.db
      .update(notifications)
      .set({ readAt: sql`now()` })
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
      .returning({ id: notifications.id });

    return { marked: marked.length };
  }

  /**
   * Dépose une notification.
   *
   * **N'échoue jamais**, pour la même raison que le journal d'audit : prévenir
   * quelqu'un est utile, mais faire échouer une sauvegarde parce que la cloche
   * n'a pas pu être écrite serait absurde.
   */
  async notify(input: {
    userId: string;
    type: string;
    title: string;
    body: string;
    level: NotificationLevel;
    serverId?: string;
    /**
     * Destination que l'émetteur seul connaît — l'espace client du facturier,
     * par exemple. Le reste se déduit du type à la lecture.
     */
    href?: string;
    /**
     * Repères propres à l'émetteur, rangés tels quels.
     *
     * Ils servent à **ne pas se répéter** : la veille de facturation y note le
     * service concerné, et retrouve ainsi ce qu'elle a déjà dit. Sans cela,
     * elle redéposerait la même échéance à chaque tour.
     */
    context?: Record<string, string>;
  }): Promise<void> {
    let notificationId: string | null = null;
    try {
      const [row] = await this.db
        .insert(notifications)
        .values({
          userId: input.userId,
          type: input.type,
          title: input.title,
          body: input.body,
          channel: "inapp",
          data: {
            level: input.level,
            ...(input.serverId ? { serverId: input.serverId } : {}),
            ...(input.href ? { href: input.href } : {}),
            ...(input.context ?? {}),
          },
        })
        .returning({ id: notifications.id });
      notificationId = row?.id ?? null;
    } catch (error) {
      this.logger.error(
        `Notification « ${input.type} » non déposée — ${
          error instanceof Error ? error.message : "erreur inconnue"
        }`,
      );
    }

    /*
     * Le courriel part **après** la cloche, et sans la conditionner.
     *
     * L'ordre importe : la cloche est le moyen qui ne peut pas manquer, et la
     * faire attendre un serveur SMTP lent retarderait un compte rendu de
     * daemon. Un envoi raté ne doit pas non plus effacer la trace — c'est
     * précisément quand le courrier ne part pas qu'il faut pouvoir retrouver
     * l'événement en ouvrant le panel.
     */
    void this.emailIfWanted(input);

    // Le téléphone, comme le courriel : après la cloche, et seulement si elle
    // existe, puisque c'est elle que l'application ouvre au toucher.
    if (notificationId) void this.pushIfWanted({ ...input, notificationId });
  }

  /**
   * Double la notification sur les téléphones liés au compte, si le compte
   * le veut pour ce type (ADR 0010). Seuls le type et le nom du serveur
   * partent ; le titre et le corps restent dans la cloche.
   */
  private async pushIfWanted(input: {
    userId: string;
    type: string;
    serverId?: string;
    notificationId: string;
  }): Promise<void> {
    try {
      const channels = await this.preferences.channelsFor(input.userId, input.type);
      if (!channels.includes("push")) return;
      const [server] = input.serverId
        ? await this.db
            .select({ name: servers.name })
            .from(servers)
            .where(eq(servers.id, input.serverId))
            .limit(1)
        : [];
      await this.push.enqueue({
        userId: input.userId,
        notificationId: input.notificationId,
        type: input.type,
        serverName: server?.name ?? null,
      });
    } catch (error) {
      this.logger.warn(
        `Notification « ${input.type} » non poussée — ${
          error instanceof Error ? error.message : "erreur inconnue"
        }`,
      );
    }
  }

  /**
   * Double la notification par courriel, si l'utilisateur l'a voulu.
   *
   * Trois conditions, et chacune répond à une objection distincte : le réglage
   * de l'utilisateur, une adresse **vérifiée** — écrire à une adresse que
   * personne n'a confirmée, c'est écrire à un inconnu que quelqu'un a saisi —
   * et un SMTP configuré, faute de quoi il n'y a rien à tenter.
   */
  private async emailIfWanted(input: {
    userId: string;
    type: string;
    title: string;
    body: string;
    serverId?: string;
    href?: string;
  }): Promise<void> {
    try {
      const channels = await this.preferences.channelsFor(input.userId, input.type);
      if (!channels.includes("email")) return;

      const [account] = await this.db
        .select({ email: users.email, verifiedAt: users.emailVerifiedAt })
        .from(users)
        .where(eq(users.id, input.userId))
        .limit(1);

      if (!account?.verifiedAt) return;

      const { branding, domain } = await this.branding.forReseller(
        await this.resellerOf(input.serverId),
      );
      const link = emailLink(
        resolveNotificationHref(input.type, { serverId: input.serverId, href: input.href }),
        domain,
      );

      await this.mail.send({
        to: account.email,
        subject: input.title,
        // Le corps du courriel est celui de la cloche, suivi de où aller voir,
        // puis de l'endroit où couper l'envoi : une notification qu'on ne sait
        // pas arrêter finit en filtre de messagerie, et les suivantes sont
        // perdues avec.
        text: [
          input.body,
          "",
          ...(link ? ["Voir dans le panel :", link, ""] : []),
          "Vous réglez ces envois dans votre compte, onglet Profil.",
          "",
        ].join("\n"),
        // La marque du serveur quand son revendeur a un domaine vérifié :
        // c'est là que son client la voit déjà (`BrandingService.forReseller`).
        ...mailSender(branding),
      });
    } catch (error) {
      // Comme la cloche : prévenir est utile, faire échouer une sauvegarde
      // parce qu'un courriel n'est pas parti serait absurde.
      this.logger.warn(
        `Courriel de « ${input.type} » non envoyé — ${
          error instanceof Error ? error.message : "erreur inconnue"
        }`,
      );
    }
  }

  /** Revendeur d'un serveur, `null` sans serveur ou pour un serveur de la plateforme. */
  private async resellerOf(serverId: string | undefined): Promise<string | null> {
    if (!serverId) return null;
    const [row] = await this.db
      .select({ resellerId: servers.resellerId })
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);
    return row?.resellerId ?? null;
  }

  /**
   * Prévient le propriétaire d'un serveur.
   *
   * Le destinataire est déduit du serveur, jamais reçu de l'appelant : c'est ce
   * qui garantit qu'un compte rendu de daemon ne puisse pas faire apparaître
   * une notification dans la cloche de quelqu'un d'autre.
   */
  async notifyServerOwner(
    serverId: string,
    input: { type: string; title: string; body: string; level: NotificationLevel },
  ): Promise<void> {
    const [row] = await this.db
      .select({ ownerId: servers.ownerId })
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);

    if (!row) return;
    await this.notify({ ...input, userId: row.ownerId, serverId });

    /*
     * Les rappels sortants du client partent du **même** point.
     *
     * C'est ce qui garantit que le catalogue proposé à l'écran ne promet rien
     * qui ne se produise : tout ce qui passe ici peut être annoncé, et rien
     * d'autre ne peut l'être. Un émetteur posé ailleurs finirait par offrir un
     * abonnement à un événement que plus rien n'émet, ce qui est indétectable
     * côté client — l'absence de message ressemble à un serveur tranquille.
     *
     * Volontairement sans `await` bloquant l'appelant en cas d'échec : le
     * service avale ses erreurs, une file de rappels indisponible ne doit pas
     * empêcher la notification d'arriver dans la cloche.
     */
    await this.clientWebhooks.emit(serverId, input.type);
  }
}

/** Le niveau est une donnée d'affichage : une valeur inconnue retombe sur `info`. */
function readLevel(data: unknown): NotificationLevel {
  const level = (data as { level?: unknown })?.level;
  return level === "success" || level === "warning" || level === "danger" ? level : "info";
}

/**
 * Lien absolu à mettre dans un courriel, ou `null`.
 *
 * Un chemin interne n'a de sens qu'avec un domaine : sans `brand.domain`
 * réglé, mieux vaut ne pas mettre de lien qu'en mettre un qui ne mène nulle
 * part. Une adresse externe (l'espace client du facturier) passe telle quelle.
 */
export function emailLink(href: string | null, domain: string | null): string | null {
  if (!href) return null;
  if (isExternalHref(href)) return href;
  if (!href.startsWith("/") || href.startsWith("//") || !domain) return null;
  return `https://${domain}${href}`;
}
