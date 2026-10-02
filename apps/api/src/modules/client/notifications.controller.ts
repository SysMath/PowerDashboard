import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { AnnouncementsService } from "../admin/announcements.service";
import { ImpersonationReadOnlyGuard } from "../auth/impersonation.guard";
import type { AuthenticatedRequest } from "../auth/session.guard";
import { SessionGuard } from "../auth/session.guard";
import { MailerService } from "../mail/mailer.service";
import { NotificationPreferencesRepository } from "../notifications/notification-preferences.repository";
import { NotificationsService } from "../notifications/notifications.service";
import { pushConfig } from "../push/push-config";

/**
 * Cloche du panel.
 *
 * Le destinataire vient de la session, jamais de l'URL : sans cela, changer un
 * identifiant suffirait à lire les notifications d'autrui — et elles nomment
 * les serveurs, les échecs de sauvegarde et les incidents de chacun.
 */
@Controller("api/v1/client/notifications")
@UseGuards(SessionGuard, ImpersonationReadOnlyGuard)
export class NotificationsController {
  constructor(
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Inject(NotificationPreferencesRepository)
    private readonly preferences: NotificationPreferencesRepository,
    @Inject(MailerService) private readonly mail: MailerService,
    @Inject(AnnouncementsService) private readonly announcementsService: AnnouncementsService,
  ) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest) {
    const result = await this.notifications.forUser(request.user.id);
    return { data: result.items, meta: { unread: result.unread } };
  }

  @Post("read-all")
  async markAllRead(@Req() request: AuthenticatedRequest) {
    return { data: await this.notifications.markAllRead(request.user.id) };
  }

  /**
   * Ce que le compte veut recevoir, et par quels moyens.
   *
   * Le catalogue est servi **avec** les réglages plutôt que codé dans l'écran :
   * un événement ajouté côté serveur apparaît alors tout seul, et une liste
   * recopiée dans le navigateur aurait fini par proposer des interrupteurs qui
   * ne commandent rien.
   */
  /**
   * Annonces en cours pour ce compte.
   *
   * Servies avec la cloche parce que la coquille les lit au même moment : une
   * route à part ferait un second aller-retour à chaque page.
   *
   * Le rôle vient de la session, jamais d'un paramètre : sans cela, il
   * suffirait d'en changer un pour lire les annonces réservées au personnel.
   */
  @Get("announcements")
  async announcements(@Req() request: AuthenticatedRequest) {
    return { data: await this.announcementsService.active(request.user.role) };
  }

  @Get("preferences")
  async listPreferences(@Req() request: AuthenticatedRequest) {
    const { mode } = pushConfig();
    const [items, mailEnabled, pushDevices] = await Promise.all([
      this.preferences.forUser(request.user.id),
      // L'écran doit pouvoir dire que le courriel ne partira pas : proposer une
      // case qui n'enverra rien fait attendre des messages qui ne viendront
      // jamais.
      this.mail.isConfigured(),
      // Même raison pour le téléphone : un panel sans chemin de notifications,
      // ou un compte sans téléphone relié.
      mode === "aucune" ? 0 : this.preferences.pushDevices(request.user.id, mode),
    ]);

    return {
      data: items,
      meta: {
        mailEnabled,
        emailVerified: request.user.emailVerifiedAt !== null,
        pushEnabled: mode !== "aucune",
        pushDevices,
      },
    };
  }

  @Post("preferences")
  async savePreference(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const payload = (body ?? {}) as { type?: unknown; channels?: unknown };
    if (typeof payload.type !== "string" || !Array.isArray(payload.channels)) {
      throw new BadRequestException("Événement et moyens attendus.");
    }

    await this.preferences.save(
      request.user.id,
      payload.type,
      payload.channels.filter((channel): channel is string => typeof channel === "string"),
    );

    return { data: await this.preferences.forUser(request.user.id) };
  }
}
