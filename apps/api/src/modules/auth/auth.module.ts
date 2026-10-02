import { Module } from "@nestjs/common";
import { databaseProvider } from "../../common/database.provider";
import { ActivityModule } from "../activity/activity.module";
import { PlatformSettingsService } from "../admin/platform-settings.service";
import { MailerService } from "../mail/mailer.service";
import { NotificationsModule } from "../notifications/notifications.module";
import { BrandingService } from "../reseller/branding.service";
import { WingsModule } from "../wings/wings.module";
import { AccountMailService } from "./account-mail.service";
import { ApiKeyRepository } from "./api-key.repository";
import { AppDeviceController } from "./app-device.controller";
import { AppDeviceRepository } from "./app-device.repository";
import { AuthController } from "./auth.controller";
import { AuthTokenRepository } from "./auth-token.repository";
import { BillingSsoService } from "./billing-sso.service";
import { BrowserSessionGuard } from "./browser-session.guard";
import { InstanceController } from "./instance.controller";
import { PasskeyRepository } from "./passkey.repository";
import { PasskeyService } from "./passkey.service";
import { PasswordConfirmationService } from "./password-confirmation.service";
import { SecurityAlertRepository } from "./security-alert.repository";
import { SecurityAlertService } from "./security-alert.service";
import { SessionGuard } from "./session.guard";
import { SessionRepository } from "./session.repository";
import { SessionIssuerService } from "./session-issuer.service";
import { SshKeyRepository } from "./ssh-key.repository";
import { SsoService } from "./sso.service";
import { TurnstileService } from "./turnstile.service";
import { TwoFactorRepository } from "./two-factor.repository";
import { UserRepository } from "./user.repository";

@Module({
  // Les notifications, pour la cloche des alertes de sécurité. Le module ne
  // dépend de rien : l'importer ne forme aucun cycle. Wings non plus : la
  // déconnexion ferme les consoles de la session, et le registre des jetons
  // émis doit être **le même** que celui qui les a signés.
  imports: [ActivityModule, NotificationsModule, WingsModule],
  // La liaison de l'application mobile et l'identité de l'instance (ADR 0010)
  // vivent avec les sessions : `SessionGuard` lit les jetons des appareils.
  controllers: [AuthController, AppDeviceController, InstanceController],
  providers: [
    databaseProvider,
    UserRepository,
    SessionRepository,
    ApiKeyRepository,
    AppDeviceRepository,
    SessionGuard,
    BrowserSessionGuard,
    TwoFactorRepository,
    PasskeyRepository,
    PasskeyService,
    // Le service de réglages est fourni ici plutôt qu'importé du module
    // d'administration : celui-ci importe déjà AuthModule pour ses gardes, et
    // l'importer en retour formerait un cycle que Nest refuse.
    PlatformSettingsService,
    SsoService,
    AuthTokenRepository,
    // L'unique fabricant de sessions, partagé avec le contrôleur des
    // invitations : un second finirait par diverger d'un détail invisible.
    SessionIssuerService,
    // Alertes de sécurité (§5.1) : cinquième échec, nouvel appareil. Appelées
    // par le fabricant de sessions et par le contrôleur, jamais attendues.
    SecurityAlertService,
    SecurityAlertRepository,
    // Le mot de passe redemandé avant un geste sensible, et le verrou qu'il
    // partage avec la connexion.
    PasswordConfirmationService,
    // Le lien de connexion remis au plugin de facturation. Ici et non dans le
    // module applicatif : il émet et consomme un jeton d'authentification, et
    // l'y loger aurait formé un cycle, `ApplicationModule` important déjà
    // celui-ci.
    BillingSsoService,
    // Le mailer suit le même raisonnement que les réglages : fourni ici, et non
    // importé d'un module qui importe déjà celui-ci.
    MailerService,
    // Même raison encore : le module revendeur importe celui-ci pour ses
    // gardes. Le service est fourni ici, et les deux instances lisent la même
    // table — le cache d'une minute de chacune vaut celui de l'autre.
    BrandingService,
    SshKeyRepository,
    TurnstileService,
    // Les courriers porteurs de jeton, partagés avec l'administration qui
    // déclenche une réinitialisation ou revérifie une adresse changée.
    AccountMailService,
  ],
  // Exporté pour que le module client puisse protéger ses routes sans
  // redéclarer la logique de session.
  // `TwoFactorRepository` sort pour le garde qui exige une seconde preuve du
  // personnel : il lit l'état réel du compte, et une seconde instance ailleurs
  // lirait la même table sans rien apporter.
  exports: [
    SessionRepository,
    ApiKeyRepository,
    // Sort avec la garde, qui en dépend dans chaque module qui l'emploie.
    AppDeviceRepository,
    SessionGuard,
    TwoFactorRepository,
    // Sortent : l'émission du lien pour l'API applicative, l'ouverture de
    // session pour le contrôleur des invitations.
    SessionIssuerService,
    // Sort avec lui : le contrôleur des invitations crée le compte de l'invité
    // avant d'ouvrir sa session.
    UserRepository,
    BillingSsoService,
    AccountMailService,
    // Sort pour la suspension d'un compte : les liens déjà envoyés meurent
    // avec elle, et la règle vit avec les jetons.
    AuthTokenRepository,
    // Sort pour l'administration, qui change l'adresse d'un compte : l'avis à
    // l'ancienne boîte part du même service que les autres alertes.
    SecurityAlertService,
    // Sort pour le module client : la création d'une clé d'API redemande le
    // mot de passe, avec le même verrou que la connexion.
    PasswordConfirmationService,
    databaseProvider,
  ],
})
export class AuthModule {}
