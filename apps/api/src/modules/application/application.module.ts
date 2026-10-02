import { Module } from "@nestjs/common";
import { ActivityModule } from "../activity/activity.module";
import { AdminModule } from "../admin/admin.module";
import { PlatformSettingsService } from "../admin/platform-settings.service";
import { AuthModule } from "../auth/auth.module";
import { ClientModule } from "../client/client.module";
import { ConsumptionModule } from "../consumption/consumption.module";
import { NodeAgentModule } from "../node-agent/node-agent.module";
import { ResellerModule } from "../reseller/reseller.module";
import { WebhooksModule } from "../webhooks/webhooks.module";
import { WingsModule } from "../wings/wings.module";
import { ApplicationController } from "./application.controller";
import { ApplicationGuard } from "./application.guard";
import { ApplicationService } from "./application.service";
import { ApplicationConsumptionController } from "./application-consumption.controller";
import { ApplicationKeyRepository } from "./application-key.repository";
import { ApplicationKeysController } from "./application-keys.controller";
import { ApplicationKeysService } from "./application-keys.service";
import { IdempotencyService } from "./idempotency.service";
import { NodeAgentConfigurationController } from "./node-agent-configuration.controller";
import { NodeConfigurationController } from "./node-configuration.controller";
import { ResellerScopeService } from "./reseller-scope.service";
import { WebhooksController } from "./webhooks.controller";

/**
 * API applicative : l'entrée des systèmes tiers (§5.2).
 *
 * Le module importe ceux qui portent déjà les règles — provisionnement,
 * suspension, enveloppes — plutôt que de les réécrire. C'est ce qui garantit
 * qu'une commande passée par la boutique subit exactement les mêmes contrôles
 * qu'une création faite depuis le panel : mêmes bornes, même capacité de node,
 * même consentement du revendeur, même enveloppe.
 *
 * `ApplicationKeysService` en sort, parce que c'est l'administration qui émet
 * les clés — l'API applicative ne s'en délivre pas à elle-même.
 */
@Module({
  imports: [
    AuthModule,
    ClientModule,
    AdminModule,
    ResellerModule,
    ActivityModule,
    WingsModule,
    WebhooksModule,
    // La consommation journalière, pour la facturation à l'usage.
    ConsumptionModule,
    // Le jeton de l'agent de node, tiré par `gamedashboard-agent configure`.
    NodeAgentModule,
  ],
  controllers: [
    ApplicationController,
    ApplicationConsumptionController,
    ApplicationKeysController,
    WebhooksController,
    // Sur `/api/application`, le préfixe que Wings impose — pas le nôtre.
    NodeConfigurationController,
    // `gamedashboard-agent configure`, sur le même préfixe et la même clé.
    NodeAgentConfigurationController,
  ],
  providers: [
    ApplicationService,
    // Le périmètre d'une clé : ce qu'elle peut voir, par opposition aux
    // portées, qui disent ce qu'elle peut faire.
    ResellerScopeService,
    ApplicationKeyRepository,
    ApplicationKeysService,
    ApplicationGuard,
    IdempotencyService,
    // Même raison que dans le module de statut : le garde du personnel lit les
    // réglages de la plateforme.
    PlatformSettingsService,
  ],
  exports: [ApplicationKeysService],
})
export class ApplicationModule {}
