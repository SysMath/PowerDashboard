import { Module } from "@nestjs/common";
import { ActivityModule } from "../activity/activity.module";
import { AnnouncementsService } from "../admin/announcements.service";
import { PlatformSettingsService } from "../admin/platform-settings.service";
import { AuthModule } from "../auth/auth.module";
import { BillingModule } from "../billing/billing.module";
import { ConsumptionModule } from "../consumption/consumption.module";
import { DnsModule } from "../dns/dns.module";
import { MailerService } from "../mail/mailer.service";
import { MarketplaceModule } from "../marketplace/marketplace.module";
import { NodeAgentRepository } from "../node-agent/node-agent.repository";
import { NodeCapabilitiesService } from "../node-agent/node-capabilities.service";
import { NotificationsModule } from "../notifications/notifications.module";
import { ResellerModule } from "../reseller/reseller.module";
import { StorageModule } from "../storage/storage.module";
import { WebhooksModule } from "../webhooks/webhooks.module";
import { WingsModule } from "../wings/wings.module";
import { AccountController } from "./account.controller";
import { AccountPreferencesService } from "./account-preferences.service";
import { AllocationsService } from "./allocations.service";
import { ApiKeysService } from "./api-keys.service";
import { BackupHooks } from "./backup-hooks";
import { BackupsService } from "./backups.service";
import { CatalogueService } from "./catalogue.service";
import { ClientController } from "./client.controller";
import { ClientNodesService } from "./client-nodes.service";
import { ClientServersService } from "./client-servers.service";
import { DatabasesService } from "./databases.service";
import { FileUploadService } from "./file-upload.service";
import { InvitationsController } from "./invitations.controller";
import { MysqlProvisionerService } from "./mysql-provisioner.service";
import { NotificationsController } from "./notifications.controller";
import { SchedulesService } from "./schedules.service";
import { ServerAccessService } from "./server-access.service";
import { ServerConsumptionController } from "./server-consumption.controller";
import { ServerFeaturesController } from "./server-features.controller";
import { ServerInvitesService } from "./server-invites.service";
import { ServerMetricsController } from "./server-metrics.controller";
import { ServerMetricsService } from "./server-metrics.service";
import { ServerPlayersService } from "./server-players.service";
import { ServerProvisioningService } from "./server-provisioning.service";
import { ServerResizeService } from "./server-resize.service";
import { ServerRuntimeController } from "./server-runtime.controller";
import { ServerSettingsService } from "./server-settings.service";
import { ServerSubdomainController } from "./server-subdomain.controller";
import { ServerWebhooksService } from "./server-webhooks.service";
import { SubusersService } from "./subusers.service";

@Module({
  imports: [
    AuthModule,
    // Les services facturés du client, pour l'accueil.
    BillingModule,
    WingsModule,
    ActivityModule,
    MarketplaceModule,
    NotificationsModule,
    // Les rappels sortants : une création faite ici doit parvenir au tiers,
    // quelle que soit la porte par laquelle elle est entrée.
    WebhooksModule,
    // Pour l'enveloppe des revendeurs, que la création de serveur doit faire
    // respecter. Le module n'expose que ce service.
    ResellerModule,
    // Pour rendre une adresse signée vers une archive déposée sur le
    // compartiment : le panel ne relaie pas les octets.
    StorageModule,
    // Le sous-domaine du serveur, sur l'écran réseau.
    DnsModule,
    // La consommation journalière, à télécharger depuis la page du serveur.
    ConsumptionModule,
  ],
  controllers: [
    ClientController,
    ServerRuntimeController,
    ServerFeaturesController,
    // L'historique des mesures : relu en base, jamais demandé au daemon.
    ServerMetricsController,
    ServerConsumptionController,
    ServerSubdomainController,
    AccountController,
    NotificationsController,
    // Le bout du lien d'invitation. Sans garde de serveur, puisqu'à cet instant
    // celui qui l'ouvre n'y a précisément aucun accès — et souvent pas encore
    // de compte.
    InvitationsController,
  ],
  providers: [
    ClientServersService,
    ClientNodesService,
    ServerAccessService,
    ServerMetricsService,
    // La vue joueurs : dernière sonde et commandes déclarées par l'egg.
    ServerPlayersService,
    // L'assemblage des envois reprenables. Il vit côté panel parce que Wings,
    // non modifié, ne sait pas compléter un fichier déjà commencé.
    FileUploadService,
    // Les rappels sortants que le client déclare sur son serveur.
    ServerWebhooksService,
    BackupsService,
    BackupHooks,
    DatabasesService,
    MysqlProvisionerService,
    AllocationsService,
    SubusersService,
    // Les invitations par courriel, pour les adresses sans compte : le seul
    // chemin où un pouvoir sur un serveur transite par une boîte aux lettres.
    ServerInvitesService,
    SchedulesService,
    ApiKeysService,
    AccountPreferencesService,
    ServerSettingsService,
    CatalogueService,
    ServerProvisioningService,
    ServerResizeService,
    // Pour le défaut du tueur de mémoire, décidé par la plateforme.
    PlatformSettingsService,
    // Fournis ici et non importés : le module de l'agent importe
    // l'administration, qui importe ce module. Sans état, deux instances ne
    // divergent pas.
    NodeAgentRepository,
    NodeCapabilitiesService,
    // L'écran des notifications doit pouvoir dire si le courriel partira :
    // proposer une case qui n'enverra rien fait attendre des messages qui ne
    // viendront jamais.
    MailerService,
    // Fourni ici plutôt qu'importé du module d'administration : celui-ci importe
    // déjà le module client pour la création de serveurs, et un import en retour
    // formerait un cycle. Les deux instances lisent la même table.
    AnnouncementsService,
  ],
  // Sortent pour l'API applicative : une commande passée par la boutique doit
  // suivre le même chemin de création qu'un serveur créé depuis le panel.
  // `BackupsService` sort pour le planificateur : une sauvegarde planifiée doit
  // emprunter la même porte qu'une sauvegarde demandée, contrôle de quota
  // compris. Deux chemins d'écriture vers la même table finissent toujours par
  // diverger, et c'est celui qu'on regarde le moins qui diverge.
  exports: [
    CatalogueService,
    ServerProvisioningService,
    // Sort pour l'administration et pour l'API applicative : changer les
    // limites d'un serveur doit emprunter la même porte, quel qu'en soit le
    // demandeur, sinon le quota se ferait contourner par la porte la moins
    // regardée.
    ServerResizeService,
    BackupsService,
    // Le module des instantanés s'y inscrit (sûreté avant une restauration).
    BackupHooks,
    // Pour le changement de titulaire : les mots de passe des bases changent
    // avec lui, par le même chemin que le bouton du client.
    DatabasesService,
    // Le contrôle d'accès d'un serveur, pour les routes client des fonctions
    // de l'agent de node (instantanés) : une seule règle des permissions.
    ServerAccessService,
  ],
})
export class ClientModule {}
