import { Module } from "@nestjs/common";
import { databaseProvider } from "../../common/database.provider";
import { PlatformSettingsService } from "../admin/platform-settings.service";
import { MailerService } from "../mail/mailer.service";
import { PushOutboxService } from "../push/push-outbox.service";
import { BrandingService } from "../reseller/branding.service";
import { ClientWebhookEmitterService } from "../webhooks/client-webhook-emitter.service";
import { NotificationPreferencesRepository } from "./notification-preferences.repository";
import { NotificationsService } from "./notifications.service";

/**
 * Les notifications persistantes.
 *
 * Module partagé : elles sont lues par le module client et **écrites** par le
 * module remote, puisque les événements qui méritent une cloche — installation
 * terminée, sauvegarde échouée — viennent du daemon.
 */
@Module({
  providers: [
    databaseProvider,
    NotificationsService,
    NotificationPreferencesRepository,
    // Le mailer est fourni ici plutôt qu'importé : le module qui le porte
    // importe déjà celui-ci, et un import en retour formerait un cycle.
    MailerService,
    PlatformSettingsService,
    // Fourni ici, comme le mailer et pour la même raison : le module des
    // rappels importe déjà celui-ci, et un import en retour formerait un cycle.
    ClientWebhookEmitterService,
    // La marque des courriels hors requête. Fournie ici pour la même raison :
    // le module des revendeurs importe, par l'authentification, celui-ci.
    BrandingService,
    // La mise en file vers les téléphones ; l'envoi vit dans `PushModule`.
    PushOutboxService,
  ],
  exports: [NotificationsService, NotificationPreferencesRepository],
})
export class NotificationsModule {}
