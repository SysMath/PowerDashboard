import {
  ATTEMPT_WINDOW_MS,
  hashToken,
  MAX_ATTEMPTS_PER_ACCOUNT,
  shouldAlertOwner,
} from "@gamedashboard/auth";
import { type MailSender, mailSender } from "@gamedashboard/contracts";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { battre } from "../../common/background-tick";
import { ActivityService } from "../activity/activity.service";
import { PlatformSettingsService } from "../admin/platform-settings.service";
import { MailerService } from "../mail/mailer.service";
import { NotificationsService } from "../notifications/notifications.service";
import { BrandingService } from "../reseller/branding.service";
import {
  type AlertTexts,
  type CredentialChange,
  credentialChangeTexts,
  describeDevice,
  failureAlertTexts,
  formatWhen,
  newDeviceAlertTexts,
} from "./security-alert.messages";
import { type AlertRecipient, SecurityAlertRepository } from "./security-alert.repository";
import { assessSignIn, deviceFamily, networkOf } from "./sign-in-origin";

/** Types posés en base, dans `notifications.type`. */
export const FAILURE_ALERT = "account.login_failures";
export const NEW_DEVICE_ALERT = "account.new_device";
export const CREDENTIAL_CHANGE_ALERT = "account.credential_changed";

/**
 * Changements qui affaiblissent la protection, ou la déplacent hors de portée
 * du titulaire : la cloche les signale plus fort que ceux qu'on fait pour se
 * protéger.
 */
const WEAKENING_CHANGES: ReadonlySet<CredentialChange> = new Set([
  "passwordReset",
  "twoFactorDisabled",
  "passkeyRemoved",
  "emailChanged",
  "appDeviceReplayed",
]);

/**
 * Étape à laquelle une preuve a été refusée, telle que le journal la nomme.
 *
 * La distinction est ce que cherche celui qui relit un compte compromis :
 * des échecs au mot de passe disent qu'on le devine, des échecs au second
 * facteur disent qu'on le **connaît** déjà.
 */
export type FailureStage = "password" | "second_factor" | "passkey" | "reauthentication";

/** Page où l'on change son mot de passe, active la 2FA et ferme ses sessions. */
const SECURITY_PAGE = "/account/security";

/** Ce que la route sait d'un échec sur un compte existant. */
export interface FailureContext {
  userId: string;
  /** Adresse **du compte**, et non celle saisie : c'est elle que le journal nomme. */
  email: string;
  ip: string | null;
  userAgent: string | null;
  /** Domaine d'arrivée, pour la marque et le lien du courriel. */
  host: string | null;
  stage: FailureStage;
}

/** Ce qu'un geste sur les authentifiants sait de lui-même. */
export interface CredentialChangeContext {
  userId: string;
  kind: CredentialChange;
  /** Adresse d'où le geste a été fait ; nulle quand elle n'a pas à sortir. */
  ip: string | null;
  /** Domaine d'arrivée, pour la marque et le lien du courriel. */
  host: string | null;
  /**
   * Pour un changement d'adresse : l'**ancienne**, seule à pouvoir alerter le
   * titulaire, et si elle était confirmée.
   */
  previousEmail?: { address: string; verified: boolean };
}

/** Ce que la connexion sait d'elle-même, au moment où la session s'ouvre. */
export interface SignInContext {
  userId: string;
  /** Jeton en clair de la session qui vient d'être ouverte, pour l'écarter de l'historique. */
  token: string;
  ip: string | null;
  userAgent: string | null;
  /** Pays, seulement quand un intermédiaire de confiance l'a fourni. */
  country: string | null;
  /** Domaine d'arrivée, pour la marque et le lien du courriel. */
  host: string | null;
  authMethod: string;
}

/**
 * Alertes de sécurité du compte (§5.1).
 *
 * Deux alertes, et une seule règle de conduite : **elles ne coûtent rien à la
 * connexion.** Chaque vérification part en tâche détachée, par `battre`, et la
 * réponse HTTP n'attend ni la base, ni le serveur SMTP. Une panne de courrier
 * — ou une lenteur de dix secondes avant abandon — ne doit ni retarder ni faire
 * échouer une connexion : l'alerte est un avertissement, pas une condition.
 *
 * **Elles ne se désactivent pas.** Ce ne sont pas des nouvelles du panel mais
 * la seule façon dont le titulaire apprend qu'un autre essaie d'entrer, ou y
 * est parvenu. Les laisser couper, c'est laisser couper l'alarme par qui a
 * volé la session : son premier geste serait de décocher la case. Elles
 * suivent donc la règle des courriels de réinitialisation — envoyés quoi
 * qu'il arrive — et ne figurent pas au catalogue des préférences
 * (`NOTIFICATION_EVENTS`), où elles apparaîtraient comme un choix qui n'en est
 * pas un. `NotificationsService.notify` passe un type absent du catalogue par
 * la cloche seule : le courriel, traduit, part d'ici et n'est donc jamais
 * doublé.
 *
 * Une seule réserve, reprise de `emailIfWanted` : le courriel ne part qu'à une
 * adresse **confirmée**. Sinon, créer un compte au nom d'un tiers puis échouer
 * cinq fois ferait du panel un moyen d'écrire à qui l'on veut. La cloche, elle,
 * est toujours déposée.
 */
@Injectable()
export class SecurityAlertService {
  /** Publique pour qu'un test puisse la museler. */
  readonly logger = new Logger(SecurityAlertService.name);

  /** Tâches en vol : `settled()` les attend, la connexion jamais. */
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    @Inject(SecurityAlertRepository) private readonly repository: SecurityAlertRepository,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Inject(MailerService) private readonly mail: MailerService,
    @Inject(ActivityService) private readonly activity: ActivityService,
    @Inject(BrandingService) private readonly branding: BrandingService,
    @Inject(PlatformSettingsService) private readonly platform: PlatformSettingsService,
  ) {}

  /**
   * Après un échec sur un compte **existant**.
   *
   * L'appelant ne l'appelle pas pour une adresse inconnue : il n'y a personne à
   * prévenir, ni d'historique de compte où ranger l'échec. Et rien de ce qui se
   * passe ici ne revient dans la réponse — elle est la même pour un compte
   * inconnu et pour un mot de passe faux, sans quoi le formulaire de connexion
   * redeviendrait un annuaire des clients. C'est aussi pourquoi le journal
   * s'écrit ici, détaché : deux écritures de plus, attendues par la route,
   * suffiraient à distinguer au chronomètre une adresse connue d'une autre.
   */
  afterFailure(input: FailureContext) {
    this.detach("échec de connexion", () => this.checkFailures(input));
  }

  /** Après l'ouverture d'une session, quel que soit le chemin d'entrée. */
  afterSignIn(context: SignInContext): void {
    this.detach("alerte de nouvel appareil", () => this.checkSignIn(context));
  }

  /**
   * Après un changement d'authentifiant : mot de passe, second facteur, clé
   * d'accès, adresse (ASVS 2.2.3, 2.5.5).
   *
   * Même conduite que les deux autres alertes : détachée, elle ne retarde ni ne
   * fait échouer le geste qu'elle décrit — le mot de passe est changé, que le
   * serveur SMTP réponde ou non. C'est l'avis qui dit au titulaire qu'un autre
   * a peut-être déjà la main : le premier geste de qui vole une session est de
   * changer ce qui permettrait de l'en déloger.
   */
  afterCredentialChange(input: CredentialChangeContext): void {
    this.detach("avis de changement d'authentifiant", () => this.noticeCredentialChange(input));
  }

  /** Attend les tâches en cours. Pour les tests ; la connexion ne l'appelle jamais. */
  async settled(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  private detach(label: string, task: () => Promise<void>): void {
    // `battre` et non un simple `void` : un rejet non rattrapé abat le
    // processus sous Node 24, et une alerte ratée ne vaut pas l'API entière.
    const running = battre(this.logger, label, task).finally(() => {
      this.inFlight.delete(running);
    });
    this.inFlight.add(running);
  }

  /**
   * Cinq échecs d'affilée, dans la fenêtre du verrou : une alerte, une seule.
   *
   * `shouldAlertOwner` ne répond vrai qu'au franchissement exact du seuil, et
   * la cloche déjà déposée dans la fenêtre fait le reste : une attaque qui dure
   * voit son compteur glisser et repasser par cinq, et ne doit pas pour autant
   * remplir la boîte du titulaire.
   */
  private async checkFailures(input: FailureContext): Promise<void> {
    const since = new Date(Date.now() - ATTEMPT_WINDOW_MS);
    await this.journalFailure(input, since);

    const failures = await this.repository.consecutiveFailures(input.email, since);
    if (!shouldAlertOwner(failures)) return;
    if (await this.repository.alertedSince(input.userId, FAILURE_ALERT, since)) return;

    const recipient = await this.repository.recipient(input.userId);
    if (!recipient) return;

    const { brand, link, sender } = await this.brandAndLink(input.host);
    const texts = failureAlertTexts({
      locale: recipient.locale,
      brand,
      count: failures,
      ip: input.ip,
      when: formatWhen(recipient.locale, recipient.timezone, new Date()),
      link,
    });

    await this.deliver(recipient, FAILURE_ALERT, "danger", texts, sender);
  }

  /**
   * Consigne l'échec au journal d'audit, puis le verrouillage s'il vient de
   * s'enclencher (ASVS 7.2.1).
   *
   * `login_attempts` les gardait déjà, mais trente jours et hors de tout
   * écran : l'administrateur qui reconstitue une compromission lit le journal,
   * et y voyait des connexions sans jamais les essais qui les précédaient.
   *
   * Ni le secret essayé, ni sa longueur : seulement l'étape refusée. Le
   * verrouillage n'est consigné qu'au franchissement exact du seuil, comme
   * l'alerte : le compteur n'avance plus tant que le verrou tient, et une
   * ligne par tentative refusée noierait le journal sous l'attaque même.
   */
  private async journalFailure(input: FailureContext, since: Date): Promise<void> {
    const entry = {
      serverId: null,
      actorId: input.userId,
      actorType: "user" as const,
      actorLabel: input.email,
      ip: input.ip,
      userAgent: input.userAgent,
    };
    await this.activity.record({
      ...entry,
      event: "account.login_failed",
      properties: { stage: input.stage },
    });

    const failures = await this.repository.failuresSince(input.email, since);
    if (failures !== MAX_ATTEMPTS_PER_ACCOUNT) return;
    await this.activity.record({
      ...entry,
      event: "account.locked",
      properties: { failures, minutes: ATTEMPT_WINDOW_MS / 60_000 },
    });
  }

  /**
   * Connexion réussie : l'appareil et le réseau sont-ils connus ?
   *
   * La connexion est d'abord consignée au journal (`account.login`), avec son
   * pays quand on le connaît : c'est la seule trace des pays déjà vus, et la
   * question « qui est entré chez moi, et d'où » s'y pose de toute façon.
   */
  private async checkSignIn(context: SignInContext): Promise<void> {
    const recipient = await this.repository.recipient(context.userId);
    if (!recipient) return;

    const [history, countries] = await Promise.all([
      this.repository.priorSignIns(context.userId, hashToken(context.token)),
      this.repository.knownCountries(context.userId),
    ]);

    await this.activity.record({
      event: "account.login",
      serverId: null,
      actorId: context.userId,
      actorType: "user",
      actorLabel: recipient.email,
      ip: context.ip,
      userAgent: context.userAgent,
      properties: {
        method: context.authMethod,
        ...(context.country ? { country: context.country } : {}),
      },
    });

    const verdict = assessSignIn(
      history.map((past) => ({
        device: deviceFamily(past.userAgent),
        network: networkOf(past.ip),
      })),
      countries,
      {
        device: deviceFamily(context.userAgent),
        network: networkOf(context.ip),
        country: context.country,
      },
    );
    if (verdict !== "new") return;

    const { brand, link, sender } = await this.brandAndLink(context.host);
    const texts = newDeviceAlertTexts({
      locale: recipient.locale,
      brand,
      device: describeDevice(recipient.locale, context.userAgent),
      ip: context.ip,
      country: context.country,
      when: formatWhen(recipient.locale, recipient.timezone, new Date()),
      link,
    });

    await this.deliver(recipient, NEW_DEVICE_ALERT, "warning", texts, sender);
  }

  private async noticeCredentialChange(input: CredentialChangeContext): Promise<void> {
    const recipient = await this.repository.recipient(input.userId);
    if (!recipient) return;

    const { brand, link, sender } = await this.brandAndLink(input.host);
    const texts = credentialChangeTexts({
      locale: recipient.locale,
      brand,
      kind: input.kind,
      ip: input.ip,
      when: formatWhen(recipient.locale, recipient.timezone, new Date()),
      link,
    });
    const level = WEAKENING_CHANGES.has(input.kind) ? "warning" : "info";

    /*
     * Le courriel ne part qu'à une adresse confirmée, la règle des autres
     * alertes, avec deux exceptions qui n'ouvrent aucun envoi nouveau :
     *
     * - la réinitialisation, parce que le lien qui vient de servir est parti
     *   vers cette même boîte — qui la lit l'a prouvé ;
     * - le changement d'adresse, qui part vers l'**ancienne**, s'il avait été
     *   confirmée : la nouvelle n'apprend rien à qui la contrôle déjà.
     */
    if (input.previousEmail) {
      await this.deliver(
        { ...recipient, email: input.previousEmail.address },
        CREDENTIAL_CHANGE_ALERT,
        level,
        texts,
        sender,
        input.previousEmail.verified,
      );
      return;
    }
    await this.deliver(
      recipient,
      CREDENTIAL_CHANGE_ALERT,
      level,
      texts,
      sender,
      recipient.emailVerifiedAt !== null || input.kind === "passwordReset",
    );
  }

  /**
   * La cloche d'abord, le courriel ensuite.
   *
   * L'ordre importe : la cloche sert aussi de trace « déjà prévenu », et c'est
   * précisément quand le courriel ne part pas qu'il faut pouvoir retrouver
   * l'alerte en ouvrant le panel.
   */
  private async deliver(
    recipient: AlertRecipient,
    type: string,
    level: "info" | "warning" | "danger",
    texts: AlertTexts,
    sender: MailSender,
    mailable = recipient.emailVerifiedAt !== null,
  ): Promise<void> {
    await this.notifications.notify({
      userId: recipient.id,
      type,
      title: texts.title,
      body: texts.summary,
      level,
      href: SECURITY_PAGE,
    });

    if (!mailable) return;
    await this.mail.send({
      to: recipient.email,
      subject: texts.subject,
      text: texts.text,
      ...sender,
    });
  }

  /**
   * Marque et lien, selon le domaine d'arrivée — la règle des autres courriels.
   *
   * Le domaine n'est repris que s'il est celui d'un revendeur vérifié ; sinon
   * c'est celui de la plateforme. L'en-tête d'arrivée est forgeable, et un
   * lien de sécurité ne doit mener que chez nous.
   */
  private async brandAndLink(
    host: string | null,
  ): Promise<{ brand: string; link: string; sender: MailSender }> {
    const branding = await this.branding.forHost(host);
    const domain =
      host !== null && branding.resellerId !== null
        ? host
        : await this.platform.text("brand.domain");
    return {
      brand: branding.name,
      link: `https://${domain}${SECURITY_PAGE}`,
      sender: mailSender(branding),
    };
  }
}
