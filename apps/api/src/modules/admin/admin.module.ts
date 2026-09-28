import { Module } from "@nestjs/common";
import { ActivityModule } from "../activity/activity.module";
import { AuthModule } from "../auth/auth.module";
import { BillingModule } from "../billing/billing.module";
import { ClientModule } from "../client/client.module";
import { ConsumptionModule } from "../consumption/consumption.module";
import { DnsModule } from "../dns/dns.module";
import { MailerService } from "../mail/mailer.service";
import { NotificationsModule } from "../notifications/notifications.module";
import { ResellerModule } from "../reseller/reseller.module";
import { SchedulerModule } from "../scheduler/scheduler.module";
import { StorageModule } from "../storage/storage.module";
import { WebhooksModule } from "../webhooks/webhooks.module";
import { WingsModule } from "../wings/wings.module";
import { AdminController } from "./admin.controller";
import { AdminGuard } from "./admin.guard";
import { AdminService } from "./admin.service";
import { AdminActionsService } from "./admin-actions.service";
import { AdminConsumptionController } from "./admin-consumption.controller";
import { AdminNodesController } from "./admin-nodes.controller";
import { AdminServerService } from "./admin-server.service";
import { AdminUsersController } from "./admin-users.controller";
import { AdminUsersService } from "./admin-users.service";
import { AdminWriteGuard } from "./admin-write.guard";
import { AnnouncementsService } from "./announcements.service";
import { DatabaseHostsService } from "./database-hosts.service";
import { EggEditorService } from "./egg-editor.service";
import { EggImportService } from "./egg-import.service";
import { InfrastructureService } from "./infrastructure.service";
import { MountsService } from "./mounts.service";
import { NodeConfigurationService } from "./node-configuration.service";
import { NodeLoadService } from "./node-load.service";
import { PlatformSettingsService } from "./platform-settings.service";
import { ServerTransferService } from "./server-transfer.service";
import { ServerTransferReaperService } from "./server-transfer-reaper.service";
import { StaffTwoFactorGuard } from "./staff-2fa.guard";

@Module({
  // `ResellerModule` pour poser les enveloppes : l'administration les décide,
  // mais la règle qui les fait respecter vit avec le revendeur.
  // `NotificationsModule` pour le transfert : un déménagement prévient le
  // propriétaire, dont l'adresse de serveur vient de changer.
  // `ActivityModule` pour la lecture du journal : il est écrit partout, et
  // l'administration est le seul endroit d'où on puisse le lire en entier.
  // `SchedulerModule` pour que l'administration puisse rendre compte de ce qui
  // tourne sans elle : la rétention s'exécute à l'heure, et c'est ici qu'on
  // vient vérifier qu'elle s'exécute bien.
  imports: [
    AuthModule,
    WingsModule,
    ResellerModule,
    // Pour le redimensionnement des serveurs. Le module client n'importe pas
    // celui-ci, donc l'import ne forme pas de cycle.
    ClientModule,
    WebhooksModule,
    NotificationsModule,
    ActivityModule,
    SchedulerModule,
    // Supprimer un serveur efface ses archives du compartiment.
    StorageModule,
    // L'essai de connexion au facturier, depuis les réglages.
    BillingModule,
    // Le sous-domaine suit le transfert et part avec le serveur ; essai de la zone.
    DnsModule,
    // La consommation de la plateforme, à télécharger.
    ConsumptionModule,
  ],
  // La fiche d'un node et la modification d'un compte ont leurs contrôleurs,
  // sous le même préfixe et les mêmes gardes : `AdminController` dépasse déjà
  // le millier de lignes.
  controllers: [
    AdminController,
    AdminNodesController,
    AdminUsersController,
    AdminConsumptionController,
  ],
  providers: [
    AdminService,
    // Fourni ici comme dans les autres modules qui envoient : le service ne
    // dépend que des réglages, que ce module possède déjà. L'administration en
    // a besoin pour éprouver le SMTP — seul moyen de savoir qu'il fonctionne
    // avant qu'un client ne découvre le contraire en perdant son mot de passe.
    MailerService,
    AdminServerService,
    AdminGuard,
    AdminWriteGuard,
    // Le réglage « 2FA obligatoire pour le personnel » existait sans que rien ne
    // le lise : ce garde est ce qui le rend vrai.
    StaffTwoFactorGuard,
    AdminActionsService,
    AdminUsersService,
    ServerTransferService,
    // Sans lui, un transfert dont aucun daemon ne rapporte l'issue laissait le
    // serveur bloqué pour toujours.
    ServerTransferReaperService,
    // Sans hôte déclaré, la fonction « bases de données » de l'espace client
    // est complète mais inutilisable : c'est cet écran qui la met en service.
    DatabaseHostsService,
    // Les tables `mounts` et `server_mounts` existaient sans que rien ne les
    // serve : le daemon recevait une liste vide en dur.
    MountsService,
    NodeConfigurationService,
    AnnouncementsService,
    NodeLoadService,
    PlatformSettingsService,
    EggImportService,
    EggEditorService,
    InfrastructureService,
  ],
  // Sortent pour l'API applicative : la suspension, la suppression et les
  // gardes d'administration y sont les mêmes, et une seconde implémentation
  // finirait par diverger sur le contrôle qui compte.
  // `ServerTransferService` sort pour le module remote : le compte rendu du
  // daemon et la bascule en base sont deux moments du même acte, et une
  // seconde implémentation finirait par les désaccorder.
  exports: [
    AdminActionsService,
    // Le changement de titulaire aussi : la boutique qui transfère un service
    // doit passer par le consentement du revendeur et la révocation des
    // consoles, exactement comme l'administration.
    AdminServerService,
    // La coquille du panel lit les annonces en cours : elles s'affichent à
    // tout le monde, pas seulement dans l'administration qui les rédige.
    AnnouncementsService,
    AdminGuard,
    AdminWriteGuard,
    ServerTransferService,
    // Les contrôleurs de l'API applicative et des incidents l'emploient aussi :
    // la règle vaut pour tout l'espace d'administration, pas pour un écran.
    StaffTwoFactorGuard,
  ],
})
export class AdminModule {}
