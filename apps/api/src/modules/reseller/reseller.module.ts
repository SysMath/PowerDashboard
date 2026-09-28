import { Module } from "@nestjs/common";
import { ActivityModule } from "../activity/activity.module";
import { AdminActionsService } from "../admin/admin-actions.service";
import { PlatformSettingsService } from "../admin/platform-settings.service";
import { StaffTwoFactorGuard } from "../admin/staff-2fa.guard";
import { ApplicationKeysService } from "../application/application-keys.service";
import { ResellerScopeService } from "../application/reseller-scope.service";
import { AuthModule } from "../auth/auth.module";
import { CatalogueService } from "../client/catalogue.service";
import { ServerResizeService } from "../client/server-resize.service";
import { ConsumptionModule } from "../consumption/consumption.module";
import { DnsModule } from "../dns/dns.module";
import { StorageModule } from "../storage/storage.module";
import { WebhooksModule } from "../webhooks/webhooks.module";
import { WingsModule } from "../wings/wings.module";
import { BrandImagesService } from "./brand-images.service";
import { BrandingController } from "./branding.controller";
import { BrandingService } from "./branding.service";
import { ResellerController } from "./reseller.controller";
import { ResellerGuard } from "./reseller.guard";
import { ResellerService } from "./reseller.service";
import { ResellerConsumptionController } from "./reseller-consumption.controller";
import { ResellerQuotaService } from "./reseller-quota.service";
import { ResellerShareService } from "./reseller-share.service";

/**
 * L'espace d'un revendeur sur son propre parc.
 *
 * Distinct du module d'administration et non une variante paramétrée : les deux
 * répondent à des questions différentes — « qu'y a-t-il sur la plateforme » et
 * « qu'y a-t-il sur mes machines ». Les fondre obligerait chaque requête à
 * porter la réponse dans un filtre, et un filtre oublié fuite tout le parc.
 */
@Module({
  /*
   * `WebhooksModule` s'importe sans précaution : il n'importe lui-même que la
   * base, précisément pour rester importable par tous ceux qui font changer
   * l'état. Aucun retour possible, donc aucun cycle — à la différence des
   * services fournis en double plus bas.
   *
   * `StorageModule` de même, qui ne dépend que de la base et des réglages :
   * supprimer un serveur efface ses archives du compartiment.
   */
  imports: [
    AuthModule,
    ActivityModule,
    WebhooksModule,
    WingsModule,
    StorageModule,
    // Supprimer un serveur retire son sous-domaine.
    DnsModule,
    // La consommation du parc, à télécharger.
    ConsumptionModule,
  ],
  controllers: [ResellerController, BrandingController, ResellerConsumptionController],
  providers: [
    ResellerService,
    ResellerQuotaService,
    ResellerShareService,
    ResellerGuard,
    BrandingService,
    BrandImagesService,
    // Fourni ici et non importé du module applicatif, qui importe déjà
    // celui-ci : un import en retour formerait un cycle. Le service ne dépend
    // que de la base, et les deux instances écrivent la même table.
    ApplicationKeysService,
    // Le service de réglages est fourni ici plutôt qu'importé du module
    // d'administration, qui importe déjà celui-ci : un import en retour
    // formerait un cycle que Nest refuse.
    PlatformSettingsService,
    // Même raison : le garde vient du module d'administration, mais il ne
    // dépend que des réglages et du dépôt 2FA, tous deux disponibles ici.
    StaffTwoFactorGuard,
    /*
     * Le périmètre du revendeur, fourni ici plutôt qu'importé du module
     * applicatif — qui importe déjà celui-ci. Il ne dépend que de la base, et
     * les deux instances lisent la même colonne.
     */
    ResellerScopeService,
    /*
     * Le redimensionnement et le catalogue, fournis ici pour la raison
     * habituelle : le module client importe déjà celui-ci, pour l'enveloppe
     * que la création doit respecter. L'importer en retour formerait le cycle
     * que Nest refuse — et qui a déjà coûté quatre minutes de bêta.
     *
     * Les deux instances lisent la même base et appellent le même daemon ; ce
     * qu'elles ne partagent pas, c'est l'objet, et il ne porte aucun état.
     */
    CatalogueService,
    ServerResizeService,
    /*
     * Les gestes du parc — suspendre, rétablir, supprimer — partagés avec
     * l'administration et la boutique.
     *
     * **Fourni ici, et pas importé.** `AdminModule` importe déjà celui-ci pour
     * les enveloppes : l'importer en retour formerait un cycle que Nest
     * refuse — ce qu'il a fait, en arrêtant l'API.
     *
     * Ce service ne dépend que de la base, de Wings, des sessions et de
     * l'émetteur de rappels : rien qui touche aux revendeurs. Les cinq se
     * résolvent ici — `AuthModule` sort la base et les sessions, `WingsModule`
     * les deux clients, `WebhooksModule` l'émetteur — et `WingsModule`
     * n'importe rien, donc aucun cycle n'est possible par ce chemin.
     */
    AdminActionsService,
  ],
  /**
   * L'enveloppe sort du module, pas le reste.
   *
   * La création de serveur doit la faire respecter et l'administration doit
   * pouvoir la poser ; les deux passent donc par ce service plutôt que de
   * relire la table chacun de leur côté — une enveloppe interprétée à trois
   * endroits finit par l'être de trois façons.
   */
  exports: [ResellerQuotaService, ResellerShareService, BrandingService, BrandImagesService],
})
export class ResellerModule {}
