import {
  checkPassword,
  hashPassword,
  identityFragments,
  needsRehash,
  otpauthUri,
  type PasswordProblem,
  passwordStanding,
  publicFailureMessage,
  verifyPassword,
} from "@gamedashboard/auth";
import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Logger,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { ActivityService } from "../activity/activity.service";
import { PlatformSettingsService } from "../admin/platform-settings.service";
import { requiresStaffSecondFactor } from "../admin/staff-2fa.guard";
import { MailerService } from "../mail/mailer.service";
import { BrandingService } from "../reseller/branding.service";
import { WingsClientService } from "../wings/wings-client.service";
import { WingsTokenService } from "../wings/wings-token.service";
import { AccountMailService } from "./account-mail.service";
import { AuthTokenRepository } from "./auth-token.repository";
import { BillingSsoService } from "./billing-sso.service";
import { BrowserSessionGuard } from "./browser-session.guard";
import { impersonationReturnCookie } from "./impersonation";
import { ImpersonationReadOnlyGuard } from "./impersonation.guard";
import { issueChallenge, readChallenge } from "./login-challenge";
import { PasskeyRepository, type PasskeySummary } from "./passkey.repository";
import { PasskeyService } from "./passkey.service";
import {
  attemptOrigin,
  type ConfirmedUser,
  PasswordConfirmationService,
  pause,
  type WithoutLocalPassword,
} from "./password-confirmation.service";
import { passkeyScope, relyingPartyFor } from "./relying-party";
import type { CredentialChange } from "./security-alert.messages";
import { type FailureStage, SecurityAlertService } from "./security-alert.service";
import { authCookieOptions, SessionGuard, sessionCookie } from "./session.guard";
import {
  SESSION_TTL_MS,
  SessionRepository,
  type SessionSummary,
  type SessionUser,
} from "./session.repository";
import { SessionIssuerService } from "./session-issuer.service";
import { trustedCountry, trustedProxiesSetting } from "./sign-in-origin";
import { SshKeyRepository, type SshKeySummary } from "./ssh-key.repository";
import {
  SsoDisabledError,
  SsoExchangeError,
  SsoNoAccountError,
  type SsoProvider,
  type SsoResolution,
  SsoService,
} from "./sso.service";
import { TurnstileService } from "./turnstile.service";
import { TwoFactorRepository, type TwoFactorStatus } from "./two-factor.repository";
import { UserRepository } from "./user.repository";

const Credentials = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

/** Nom affiché par les applications d'authentification. */
const TOTP_ISSUER = "GameDashboard";

/**
 * Second facteur : un code TOTP **ou** un code de secours, jamais les deux.
 *
 * Un `refine` plutôt que deux routes : le parcours est le même, seule la
 * preuve change, et deux routes se seraient écartées sur le ralentissement ou
 * le journal.
 */
const SecondFactor = z
  .object({
    challenge: z.string().min(1),
    code: z.string().optional(),
    recoveryCode: z.string().optional(),
  })
  .refine((v) => Boolean(v.code) !== Boolean(v.recoveryCode), {
    message: "Fournissez un code TOTP ou un code de secours.",
  });

const TotpCode = z.object({ code: z.string().min(1) });

const ChallengeOnly = z.object({ challenge: z.string().min(1) });

const SsoStartInput = z.object({ redirectUri: z.string().url() });

const SsoCallbackInput = z.object({
  code: z.string().min(1),
  codeVerifier: z.string().min(1),
  redirectUri: z.string().url(),
});

/** Nom donné à une clé quand on n'en propose aucun. */
const DEFAULT_PASSKEY_LABEL = "Clé d'accès";

/**
 * Réponse d'authentifiant, laissée en `unknown`.
 *
 * Sa forme est celle de la spécification WebAuthn, et c'est
 * `@simplewebauthn/server` qui la valide — la redécrire ici en zod créerait
 * une seconde définition à maintenir, qui divergerait à la première évolution
 * du standard et refuserait des réponses parfaitement valides.
 */
const PasskeyRegistration = z.object({
  challenge: z.string().min(1),
  label: z.string().max(100).default(""),
  response: z.unknown(),
});

const PasskeyAssertion = z.object({
  challenge: z.string().min(1),
  response: z.unknown(),
});

/**
 * Ajout d'une clé publique SSH.
 *
 * Le nom est facultatif : une ligne `authorized_keys` porte déjà un
 * commentaire — « matheo@codiax » — qui fait un nom parfaitement utilisable.
 * L'exiger ferait inventer une étiquette à quelqu'un qui vient de coller sa
 * clé et qui n'a rien à ajouter.
 *
 * Aucune borne sur la clé ici : c'est `parseSshPublicKey` qui tranche, et la
 * redire ferait diverger les deux.
 */
const SshKeyInput = z.object({
  name: z.string().max(100).default(""),
  publicKey: z.string().min(1),
});

/**
 * Inscription publique.
 *
 * Aucune borne sur le mot de passe : c'est `checkPassword` qui tranche, et
 * dupliquer la règle ici la ferait diverger le jour où elle change. Les noms
 * sont bornés parce que la colonne l'est — un nom de trois cents caractères
 * ferait échouer l'insertion avec une erreur SQL illisible.
 */
const Registration = z.object({
  email: z.string().email(),
  nameFirst: z.string().min(1).max(100),
  nameLast: z.string().min(1).max(100),
  password: z.string().min(1),
});

/**
 * Changement de mot de passe.
 *
 * Aucune borne de longueur sur le nouveau : c'est `checkPassword` qui tranche,
 * et dupliquer la règle ici ferait diverger les deux le jour où elle change.
 * Le minimum à 1 ne sert qu'à distinguer « champ absent » de « champ vide ».
 */
const PasswordChange = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(1),
});

/**
 * Traduit les manquements en une phrase, pour les clients qui ne lisent que
 * `message` — un script, ou un écran qui ne connaîtrait pas encore `problems`.
 */
function describeProblem(problem: PasswordProblem): string {
  switch (problem.kind) {
    case "too-short":
      return `Le mot de passe doit faire au moins ${problem.minimum} caractères.`;
    case "too-long":
      return `Le mot de passe ne peut pas dépasser ${problem.maximum} caractères.`;
    case "contains-identity":
      return "Le mot de passe ne doit pas contenir votre nom ni votre adresse e-mail.";
    case "pwned":
      return "Ce mot de passe figure dans des fuites de données connues.";
  }
}

function describeProblems(problems: readonly PasswordProblem[]): string {
  return problems.map(describeProblem).join(" ");
}

interface Reply {
  setCookie(name: string, value: string, options: Record<string, unknown>): Reply;
  clearCookie(name: string, options?: Record<string, unknown>): Reply;
  status(code: number): Reply;
  header(name: string, value: string): Reply;
  send(body: unknown): void;
}

interface ClientRequest {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
  /**
   * Interlocuteur direct de l'API — nginx ou le serveur de rendu, pas le
   * navigateur. Sert à décider si l'en-tête de pays est digne de foi.
   */
  socket?: { remoteAddress?: string };
  user?: SessionUser;
  sessionToken?: string;
}

@Controller("api/v1/auth")
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    @Inject(UserRepository) private readonly users: UserRepository,
    @Inject(SessionRepository) private readonly sessions: SessionRepository,
    @Inject(ActivityService) private readonly activity: ActivityService,
    @Inject(TwoFactorRepository) private readonly twoFactor: TwoFactorRepository,
    @Inject(PasskeyRepository) private readonly passkeys: PasskeyRepository,
    @Inject(PasskeyService) private readonly passkeyService: PasskeyService,
    @Inject(SsoService) private readonly sso: SsoService,
    @Inject(BillingSsoService) private readonly billingSso: BillingSsoService,
    @Inject(SessionIssuerService) private readonly issuer: SessionIssuerService,
    @Inject(AuthTokenRepository) private readonly tokens: AuthTokenRepository,
    @Inject(MailerService) private readonly mail: MailerService,
    @Inject(PlatformSettingsService) private readonly platform: PlatformSettingsService,
    @Inject(SshKeyRepository) private readonly sshKeys: SshKeyRepository,
    @Inject(TurnstileService) private readonly turnstile: TurnstileService,
    @Inject(SecurityAlertService) private readonly alerts: SecurityAlertService,
    @Inject(AccountMailService) private readonly accountMail: AccountMailService,
    // Les consoles ouvertes par une session se ferment avec elle (NC-43).
    @Inject(WingsTokenService) private readonly wingsTokens: WingsTokenService,
    @Inject(WingsClientService) private readonly wings: WingsClientService,
    @Inject(PasswordConfirmationService)
    private readonly confirmation: PasswordConfirmationService,
    // Le domaine relais des clés d'accès suit le domaine vérifié d'arrivée.
    @Inject(BrandingService) private readonly branding: BrandingService,
  ) {}

  /**
   * Domaine relais d'une cérémonie WebAuthn : celui du revendeur quand on
   * arrive par son domaine vérifié, celui de la plateforme sinon. Voir
   * `relyingPartyFor` pour ce qui rend l'en-tête d'arrivée sans danger ici.
   */
  private async relyingParty(request: ClientRequest) {
    const host = arrivalHost(request);
    return relyingPartyFor(host, await this.branding.forHost(host));
  }

  /**
   * L'adresse de retour SSO ne peut viser que le panel : son origine
   * (`PANEL_ORIGIN`) ou le domaine **vérifié** d'un revendeur, servi par lui.
   *
   * C'est le fournisseur qui fait le contrôle exact, mais l'API n'a aucune
   * raison de lancer une cérémonie vers une adresse étrangère : celle-ci
   * recevrait le code d'autorisation. Le domaine d'un revendeur n'est admis
   * qu'en `https://`, sans port : c'est ainsi qu'il est servi.
   */
  private async isPanelRedirect(redirectUri: string): Promise<boolean> {
    let url: URL;
    try {
      url = new URL(redirectUri);
    } catch {
      return false;
    }
    try {
      const expected = new URL(process.env.PANEL_ORIGIN ?? "http://localhost:3000");
      if (url.origin === expected.origin) return true;
    } catch {
      // Origine du panel illisible : seul un domaine de revendeur peut passer.
    }
    if (url.protocol !== "https:" || url.port !== "") return false;
    return (await this.branding.forHost(url.hostname)).resellerId !== null;
  }

  /** Des clés utilisables sur ce domaine ? L'écran de connexion ne propose que celles-là. */
  private async passkeysHere(userId: string, request: ClientRequest): Promise<boolean> {
    const host = arrivalHost(request);
    const scope = passkeyScope(host, await this.branding.forHost(host));
    return (await this.passkeys.countInScope(userId, scope)) > 0;
  }

  /**
   * Refuse une entrée quand la preuve anti-automate manque ou ne vaut rien.
   *
   * Rend `true` quand la requête a été refusée, pour que l'appelant s'arrête.
   * Le même message pour « absente » et « invalide » : distinguer les deux
   * apprendrait à qui essaie si son jeton est périmé, déjà employé ou
   * fabriqué.
   */
  private async captchaRefused(body: unknown, request: ClientRequest, reply: Reply) {
    const token = (body as { captchaToken?: unknown })?.captchaToken;
    const accepted = await this.turnstile.accepts(
      typeof token === "string" ? token : null,
      request.ip ?? null,
    );

    if (accepted) return false;
    reply.status(403).send({ message: "Le contrôle anti-automate n'a pas abouti. Réessayez." });
    return true;
  }

  @Post("login")
  async login(
    @Body() body: unknown,
    @Req() request: ClientRequest,
    @Res() reply: Reply,
  ): Promise<void> {
    // Avant toute lecture de compte : le contrôle anti-automate protège
    // précisément contre celui qui essaie des adresses à la chaîne, et le
    // placer après le hachage lui ferait payer le prix tout en le renseignant.
    if (await this.captchaRefused(body, request, reply)) return;

    const parsed = Credentials.safeParse(body);
    if (!parsed.success) {
      reply.status(422).send({ message: publicFailureMessage() });
      return;
    }

    /**
     * L'authentification unique, quand elle est active, est le **seul** chemin.
     *
     * Le contrôle est ici et non à l'écran : masquer le formulaire suffirait à
     * qui poste directement sur cette route. Refuser avant même de regarder le
     * mot de passe évite aussi de confirmer, par le temps de réponse, qu'une
     * adresse est connue.
     */
    if (await this.sso.configuration()) {
      reply.status(403).send({
        message: "La connexion par mot de passe est désactivée sur ce panel.",
        ssoRequired: true,
      });
      return;
    }

    // Le verrou se consulte **avant** de vérifier quoi que ce soit : c'est le
    // seul ordre où un compte verrouillé ne coûte plus une vérification.
    const throttle = await this.throttle(parsed.data.email, request.ip ?? null, reply);
    if (throttle === null) return;

    const user = await this.users.findByEmail(parsed.data.email);

    /**
     * Un compte inexistant coûte le même temps qu'un mot de passe faux.
     *
     * Sans ce hachage à vide, la réponse serait immédiate pour une adresse
     * inconnue et lente pour une adresse connue : le formulaire deviendrait un
     * outil d'énumération des clients, et savoir qu'une adresse est cliente est
     * déjà une fuite.
     */
    const digest = user?.passwordHash ?? (await emptyDigest());
    const valid = await verifyPassword(digest, parsed.data.password);

    if (!user || !valid) {
      await this.recordFailure(parsed.data.email, request, user, "password");
      // Délai progressif : gênant pour une énumération automatisée, invisible
      // pour quelqu'un qui se trompe deux fois. Le verrou, lui, est plus haut.
      await pause(throttle.delayMs);
      reply.status(401).send({ message: publicFailureMessage() });
      return;
    }

    // Rehachage progressif : c'est le seul moment où le mot de passe est en
    // clair. Une hausse des paramètres Argon2 se propage ainsi compte par
    // compte, à la connexion suivante, sans réinitialisation générale.
    if (needsRehash(digest)) {
      await this.users.rehashPassword(user.id, await hashPassword(parsed.data.password));
    }

    /*
     * Un mot de passe provisoire expiré ne vaut plus rien (ASVS 2.3.1).
     *
     * Tiré au sort par un script et affiché une fois dans un terminal, il ne
     * doit pas devenir le mot de passe durable du compte. Le refus ne vient
     * qu'après la preuve : seul qui tient déjà le bon mot de passe apprend
     * qu'il a expiré, et ce n'est pas compté comme un échec — le secret était
     * juste.
     */
    const standing = passwordStanding(user.passwordExpiresAt);
    if (standing === "expired") {
      reply.status(403).send({
        message:
          "Ce mot de passe provisoire a expiré. Demandez-en un nouveau à l'exploitant du panel.",
        passwordExpired: true,
      });
      return;
    }

    /**
     * Le mot de passe est juste, mais il ne suffit pas.
     *
     * Aucune session n'est ouverte ici, et c'est tout l'enjeu : poser le cookie
     * puis « demander » un code laisserait le compte accessible à qui sait
     * ignorer un écran. Le défi ne donne accès à rien, il nomme seulement le
     * compte dont le second facteur est attendu.
     */
    const status = await this.twoFactor.status(user.id);
    if (status.enabled) {
      reply.status(200).send({
        twoFactorRequired: true,
        challenge: issueChallenge("login", user.id, { method: "password" }),
        // Les preuves réellement disponibles : proposer « utiliser ma clé
        // d'accès » à quelqu'un qui n'en a pas mènerait à une boîte de dialogue
        // du navigateur vouée à échouer.
        methods: { totp: status.totp, passkeys: await this.passkeysHere(user.id, request) },
        // Le dire évite d'avoir à retrouver son papier pour découvrir qu'il ne
        // reste rien, une fois le téléphone déjà perdu.
        remainingRecoveryCodes: status.remainingRecoveryCodes,
      });
      return;
    }

    /*
     * La réussite n'est consignée qu'ici, une fois **toutes** les preuves
     * données, et plus dès le mot de passe accepté.
     *
     * Elle fait de l'adresse une adresse connue du compte, que le verrou
     * n'arrête plus (`throttleDecision`). Posée avant le second facteur, elle
     * aurait exempté du verrou quiconque connaît le mot de passe, au moment
     * précis où il lui reste six chiffres à deviner.
     */
    await this.users.recordAttempt(parsed.data.email, request.ip ?? null, true);
    await this.issueSession(user.id, request, reply, "password", standing === "provisional");
  }

  /**
   * Second facteur, après un mot de passe accepté.
   *
   * Route distincte de `login` plutôt qu'un champ optionnel : les deux étapes
   * n'ont ni les mêmes entrées, ni le même rythme d'échec, ni la même chose à
   * protéger. Les mêler ferait un contrôleur où l'on ne verrait plus quel
   * chemin ouvre une session.
   */
  @Post("login/2fa")
  async loginTwoFactor(
    @Body() body: unknown,
    @Req() request: ClientRequest,
    @Res() reply: Reply,
  ): Promise<void> {
    const parsed = SecondFactor.safeParse(body);
    if (!parsed.success) {
      reply.status(422).send({ message: publicFailureMessage() });
      return;
    }

    const sealed = readChallenge("login", parsed.data.challenge);
    // Expiré, tronqué, forgé ou déjà servi : la distinction n'intéresse que
    // celui qui cherche à deviner le format. Le défi rejoué est refusé ici,
    // avant tout code : il ne doit ni brûler un code de secours ni compter
    // comme un échec du titulaire.
    if (!sealed || (await this.tokens.challengeClaimed(sealed.jti))) {
      reply.status(401).send({ message: "Demande de connexion expirée. Recommencez." });
      return;
    }

    const user = await this.users.findById(sealed.userId);
    if (!user) {
      reply.status(401).send({ message: "Demande de connexion expirée. Recommencez." });
      return;
    }

    /**
     * Le décompte des échecs est celui du compte, partagé avec le mot de passe.
     *
     * Six chiffres font un million de combinaisons, dont trois sont valides à
     * un instant donné : un défi en main suffirait à les parcourir en quelques
     * minutes. Un délai seul n'y suffit pas — il s'attend en parallèle — d'où
     * le verrou, consulté avant de vérifier le code.
     */
    const throttle = await this.throttle(user.email, request.ip ?? null, reply);
    if (throttle === null) return;

    const accepted = parsed.data.recoveryCode
      ? await this.twoFactor.consumeRecoveryCode(sealed.userId, parsed.data.recoveryCode)
      : await this.twoFactor.verifyCode(sealed.userId, parsed.data.code ?? "");

    if (!accepted) {
      await this.recordFailure(user.email, request, user, "second_factor");
      await pause(throttle.delayMs);
      reply.status(401).send({ message: publicFailureMessage() });
      return;
    }

    if (parsed.data.recoveryCode) {
      // Un code de secours consommé est un événement, pas une simple connexion :
      // il signale un téléphone perdu, ou quelqu'un d'autre au bout du fil.
      await this.activity.record({
        event: "account.recovery_code_used",
        serverId: null,
        actorId: user.id,
        actorType: "user",
        actorLabel: user.email,
        ip: request.ip ?? null,
        userAgent: headerValue(request.headers["user-agent"]),
        properties: { remaining: (await this.twoFactor.status(user.id)).remainingRecoveryCodes },
      });
    }

    // Le défi a servi : le même ne doit pas rouvrir une session cinq minutes
    // durant, depuis un autre onglet, un autre poste ou une autre instance de
    // l'API. Consommé en base, atomiquement : de deux demandes simultanées,
    // une seule ouvre la session.
    if (!(await this.tokens.claimChallenge(sealed))) {
      reply.status(401).send({ message: "Demande de connexion expirée. Recommencez." });
      return;
    }
    // Toutes les preuves sont données : l'adresse devient connue du compte.
    await this.users.recordAttempt(user.email, request.ip ?? null, true);
    await this.issueSession(
      user.id,
      request,
      reply,
      sealed.method ?? "password",
      (sealed.method ?? "password") === "password" &&
        passwordStanding(user.passwordExpiresAt) === "provisional",
    );
  }

  /**
   * Consigne un échec, et prévient le titulaire au cinquième d'affilée (§5.1).
   * La règle vit dans `PasswordConfirmationService.recordFailure`.
   */
  private async recordFailure(
    email: string,
    request: ClientRequest,
    account: { id: string; email: string } | null,
    stage: FailureStage,
  ): Promise<void> {
    await this.confirmation.recordFailure(email, attemptOrigin(request), account, stage);
  }

  /**
   * Verrou anti-bruteforce (§5.1), par compte et par adresse.
   *
   * Rend le délai à appliquer en cas d'échec, ou `null` après avoir répondu
   * 429 : au-delà de `MAX_ATTEMPTS_PER_ACCOUNT` échecs sur le compte ou de
   * `MAX_ATTEMPTS_PER_IP` depuis l'adresse dans la fenêtre glissante, plus
   * rien n'est vérifié. Le verrou du compte épargne les adresses d'où il a
   * déjà été ouvert : sans cela, dix échecs volontaires d'un inconnu
   * enfermaient dehors le titulaire. Un délai seul ne suffisait pas : il s'attend en
   * parallèle, et un million de codes TOTP se parcourt ainsi en une heure.
   *
   * La tentative refusée n'est pas enregistrée : la compter prolongerait le
   * verrou tant que l'attaquant insiste, au détriment du vrai titulaire.
   */
  private async throttle(
    email: string,
    ip: string | null,
    reply: Reply,
  ): Promise<{ delayMs: number } | null> {
    const decision = await this.confirmation.throttle(email, ip);
    if (decision.action === "allow") return { delayMs: decision.delayMs };

    reply
      .status(429)
      .header("Retry-After", String(Math.ceil(decision.retryAfterMs / 1000)))
      .send({ message: "Trop de tentatives. Réessayez dans quelques minutes." });
    return null;
  }

  /**
   * Ouvre la session et pose le cookie.
   *
   * Délègue au service : la fabrication d'une session a quitté ce contrôleur
   * quand un second — celui des invitations — a eu besoin d'en ouvrir une. La
   * recopier là-bas aurait créé le deuxième fabricant qu'on veut précisément
   * éviter, et c'est toujours le chemin le moins fréquenté qui diverge.
   */
  private async issueSession(
    userId: string,
    request: ClientRequest,
    reply: Reply,
    authMethod: string,
    /**
     * Entré avec un mot de passe provisoire : l'écran doit mener au
     * changement. Le dire dans la réponse, et non dans la session, laisse la
     * session telle que toutes les autres.
     */
    passwordChangeRequired = false,
  ): Promise<void> {
    const payload = await this.issuer.issue(
      userId,
      {
        ip: request.ip ?? null,
        userAgent: headerValue(request.headers["user-agent"]),
        // Le pays n'est cru que s'il arrive d'un intermédiaire de
        // `TRUSTED_PROXIES` ; il n'y a pas de base GeoIP pour le deviner.
        country: trustedCountry(
          request.headers,
          request.socket?.remoteAddress,
          trustedProxiesSetting(),
        ),
        host: arrivalHost(request),
      },
      reply,
      authMethod,
    );
    reply.send(passwordChangeRequired ? { ...payload, passwordChangeRequired } : payload);
  }

  /**
   * Rend la main : ferme la prise en main et rouvre la session de l'agent.
   *
   * Vit ici et non dans l'administration parce qu'à ce moment la session est
   * **celle du client** : les routes d'administration lui sont fermées, comme
   * elles le sont à lui. Y placer le retour rendrait la sortie impossible.
   *
   * La session empruntée est révoquée, jamais simplement oubliée : un cookie
   * effacé côté navigateur laisserait en base une session vivante chez le
   * client pendant une demi-heure.
   */
  @Post("impersonation/stop")
  @UseGuards(SessionGuard)
  async stopImpersonation(@Req() request: ClientRequest, @Res() reply: Reply): Promise<void> {
    const user = requireUser(request);
    if (!user.impersonator) {
      reply.status(400).send({ message: "Cette session n'est pas une prise en main." });
      return;
    }

    if (request.sessionToken) {
      await this.sessions.revoke(request.sessionToken);
      // Une console ouverte pendant la visite ne lui survit pas.
      await this.closeConsoles(request.sessionToken);
    }

    // Des deux côtés, comme au départ : un client qui lit « untel est entré »
    // sans jamais lire « untel est sorti » ne saurait pas si la visite dure
    // encore.
    for (const entry of [
      { actorId: user.impersonator.id, label: user.impersonator.email },
      { actorId: user.id, label: user.email },
    ]) {
      await this.activity.record({
        event: "account.impersonation_ended",
        serverId: null,
        actorId: entry.actorId,
        actorType: "user",
        actorLabel: entry.label,
        ip: request.ip ?? null,
        userAgent: headerValue(request.headers["user-agent"]),
        properties: { staff: user.impersonator.email, account: user.email },
      });
    }

    /*
     * Le jeton de retour est **relu et vérifié**, jamais recopié de confiance.
     *
     * Il vient d'un cookie, donc du navigateur. Le reposer sans le résoudre
     * ferait de ce cookie un moyen d'ouvrir la session de son choix : il
     * suffirait d'y écrire un jeton volé et de passer par ici.
     */
    const returning = headerCookie(request, impersonationReturnCookie());
    const staff = returning ? await this.sessions.resolve(returning) : null;

    reply.clearCookie(impersonationReturnCookie(), authCookieOptions());

    if (!staff || staff.id !== user.impersonator.id) {
      // Session de l'agent expirée ou fermée entre-temps : on le déconnecte
      // proprement plutôt que de le laisser sur un compte qui n'est pas le sien.
      reply.clearCookie(sessionCookie(), authCookieOptions()).status(204).send(null);
      return;
    }

    reply
      .setCookie(sessionCookie(), returning ?? "", {
        ...authCookieOptions(),
        maxAge: SESSION_TTL_MS / 1000,
      })
      .status(204)
      .send(null);
  }

  @Post("logout")
  @UseGuards(SessionGuard)
  async logout(@Req() request: ClientRequest, @Res() reply: Reply): Promise<void> {
    if (request.sessionToken) {
      await this.sessions.revoke(request.sessionToken);
      await this.closeConsoles(request.sessionToken);
    }
    reply.clearCookie(sessionCookie(), authCookieOptions()).status(204).send(null);
  }

  /**
   * Ferme les consoles ouvertes par une session qui se termine (NC-43).
   *
   * Le jeton d'une console vit dix minutes et Wings ne revérifie rien en cours
   * de route : sans cet appel, une console restait ouverte — lecture et
   * commandes — après la déconnexion. Seules celles de **cette** session :
   * les autres appareils du compte gardent les leurs.
   *
   * Un node injoignable n'empêche pas de partir : la session est fermée en
   * base, et le jeton expirera de lui-même. Les nodes sont prévenus en
   * parallèle, pour qu'un seul muet ne fasse pas attendre la déconnexion de
   * son délai multiplié par le nombre de consoles.
   */
  private async closeConsoles(sessionToken: string): Promise<void> {
    await Promise.all(
      [...this.wingsTokens.revocableForSession(sessionToken)].map(([serverId, jtis]) =>
        this.wings.denyWebsocketTokens(serverId, jtis).catch(() => undefined),
      ),
    );
  }

  @Get("me")
  @UseGuards(SessionGuard)
  me(@Req() request: ClientRequest): { user: SessionUser | undefined } {
    return { user: request.user };
  }

  /**
   * Change le mot de passe du compte appelant.
   *
   * L'ancien est redemandé bien que la session soit déjà authentifiée : sans
   * lui, un poste laissé déverrouillé une minute suffirait à verrouiller son
   * propriétaire hors de son compte. C'est la seule barrière entre « accès
   * momentané » et « prise de contrôle ».
   */
  @Post("password")
  @UseGuards(SessionGuard, BrowserSessionGuard, ImpersonationReadOnlyGuard)
  async changePassword(
    @Body() body: unknown,
    @Req() request: ClientRequest,
    @Res() reply: Reply,
  ): Promise<void> {
    const parsed = PasswordChange.safeParse(body);
    if (!parsed.success) {
      reply.status(422).send({ message: "Requête invalide.", problems: [] });
      return;
    }

    const session = requireUser(request);
    const user = await this.users.findById(session.id);
    if (!user?.passwordHash) {
      // Compte sans mot de passe local — créé par SSO. Lui en faire « changer »
      // un qu'il n'a pas n'aurait pas de sens ; il faudra un parcours « définir
      // un mot de passe », qui n'est pas celui-ci.
      reply.status(409).send({
        message: "Ce compte n'a pas de mot de passe local.",
        problems: [],
      });
      return;
    }

    /*
     * Même verrou qu'à la connexion. L'appelant est authentifié, mais une
     * session volée ne vaut qu'un accès temporaire : deviner ici le mot de
     * passe sans limite en ferait un changement de mot de passe, donc une
     * prise de contrôle durable.
     */
    const throttle = await this.throttle(user.email, request.ip ?? null, reply);
    if (throttle === null) return;

    if (!(await verifyPassword(user.passwordHash, parsed.data.currentPassword))) {
      await this.recordFailure(user.email, request, user, "reauthentication");
      await pause(throttle.delayMs);
      reply.status(403).send({ message: "Mot de passe actuel incorrect.", problems: [] });
      return;
    }

    /**
     * La politique est appliquée **ici**, pas dans le navigateur.
     *
     * Un contrôle côté écran est un confort ; celui-ci est la règle. Le
     * formulaire peut être contourné, la route non.
     */
    const { problems, pwnedCheckFailed } = await checkPassword(parsed.data.newPassword, {
      identity: identityFragments(user.email, user.nameFirst, user.nameLast),
      fetchImpl: globalThis.fetch as never,
    });

    if (problems.length > 0) {
      reply.status(422).send({ message: describeProblems(problems), problems });
      return;
    }

    await this.users.updatePassword(user.id, await hashPassword(parsed.data.newPassword));

    /**
     * Les autres sessions tombent avec l'ancien mot de passe.
     *
     * C'est le geste qu'on attend de ce formulaire : on change son mot de passe
     * parce qu'on le croit connu d'un autre, et le laisser connecté viderait
     * l'opération de son sens. La session courante survit, sinon on se
     * déconnecterait soi-même en se protégeant.
     */
    const revoked = await this.sessions.revokeOthers(user.id, request.sessionToken);

    /*
     * Les liens de réinitialisation en attente meurent avec l'ancien mot de
     * passe, pour la même raison que les sessions : celui qui a demandé un
     * lien « au cas où », ou qui l'a fait demander par un autre, garderait une
     * heure durant de quoi reprendre le compte qu'on vient de lui fermer.
     */
    await this.tokens.revokePending(user.id, ["password_reset"]);

    await this.activity.record({
      event: "account.password",
      serverId: null,
      actorId: user.id,
      actorType: "user",
      actorLabel: user.email,
      ip: request.ip ?? null,
      userAgent: headerValue(request.headers["user-agent"]),
      // Jamais le mot de passe, ni son condensat, ni sa longueur : un journal
      // d'audit se lit par des gens qui n'ont pas à en apprendre autant.
      properties: { revokedSessions: revoked, pwnedCheckFailed },
    });
    this.noticeCredentialChange(user.id, "passwordChanged", request);

    reply.status(200).send({ data: { revokedSessions: revoked, pwnedCheckFailed } });
  }

  /**
   * Prévient le titulaire d'un changement d'authentifiant (ASVS 2.2.3, 2.5.5).
   *
   * Sans rien attendre : l'avis part en tâche détachée, et une panne de
   * courrier ne défait pas un geste déjà accompli.
   */
  private noticeCredentialChange(
    userId: string,
    kind: CredentialChange,
    request: ClientRequest,
  ): void {
    this.alerts.afterCredentialChange({
      userId,
      kind,
      ip: request.ip ?? null,
      host: arrivalHost(request),
    });
  }

  /* --- Mot de passe oublié ------------------------------------------------ */

  /**
   * Demande un lien de réinitialisation.
   *
   * **Répond toujours 204**, que l'adresse existe ou non. C'est la règle
   * centrale de ce parcours : un formulaire qui répondrait « compte inconnu »
   * deviendrait un outil pour savoir qui est client, et un formulaire qui
   * répondrait « courriel envoyé » seulement dans un cas le dirait tout aussi
   * bien par son temps de réponse.
   *
   * Le courrier part sans qu'on attende son sort : un SMTP en panne ne doit pas
   * enfermer dehors quelqu'un qui a déjà perdu son mot de passe — il réessaiera
   * quand le service sera rétabli, et l'écran lui dit la même chose dans tous
   * les cas.
   */
  @Post("password/forgot")
  @HttpCode(204)
  async forgotPassword(@Body() body: unknown, @Req() request: ClientRequest): Promise<void> {
    /*
     * Le refus du captcha est **explicite**, là où le reste de cette route se
     * tait.
     *
     * Les deux silences n'ont pas le même objet : taire l'existence d'un compte
     * protège son titulaire, taire l'échec d'un contrôle anti-automate ne
     * protège personne et laisse quelqu'un attendre un courriel qui ne partira
     * jamais. Ce refus ne dit rien de l'adresse saisie.
     */
    const captcha = (body as { captchaToken?: unknown })?.captchaToken;
    if (
      !(await this.turnstile.accepts(
        typeof captcha === "string" ? captcha : null,
        request.ip ?? null,
      ))
    ) {
      throw new ForbiddenException("Le contrôle anti-automate n'a pas abouti. Réessayez.");
    }

    const email = (body as { email?: unknown })?.email;
    if (typeof email !== "string" || email.trim() === "") return;

    const user = await this.users.findByEmail(email.trim());
    // Compte inconnu, ou compte sans mot de passe local — créé par SSO : dans
    // les deux cas il n'y a rien à réinitialiser, et dans les deux cas on se
    // tait. Dire « ce compte passe par le SSO » renseignerait sur son existence.
    if (!user?.passwordHash) return;

    /*
     * La suite ne s'attend pas (doute D-3 de l'audit ASVS).
     *
     * Le corps de la réponse ne dit rien de l'adresse ; le temps le disait :
     * pour un compte existant, la route attendait l'émission du jeton, le
     * rendu du courrier et l'écriture au journal — de quoi trier une liste
     * d'adresses sous charge. Détachée, la réponse part au même instant dans
     * tous les cas ; seule la lecture du compte, commune aux deux, la précède.
     */
    void this.requestPasswordReset(user, request).catch((error: unknown) => {
      this.logger.error(
        `Demande de réinitialisation non aboutie : ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  /** Émet le lien de réinitialisation d'un compte existant, et le consigne. */
  private async requestPasswordReset(
    user: { id: string; email: string },
    request: ClientRequest,
  ): Promise<void> {
    /*
     * Sans courrier, on n'émet **rien**, et plafond atteint vaut le même
     * silence qu'un compte inconnu (voir `AccountMailService`).
     *
     * Le silence rendu à l'appelant reste le même dans tous les cas — il ne
     * doit rien apprendre sur l'adresse saisie — mais l'exploitant, lui,
     * trouve la raison dans son journal au lieu de chercher pourquoi « le
     * courriel n'arrive pas ». L'écran ne propose plus ce parcours sans SMTP ;
     * cette garde est là pour la requête qui arrive quand même.
     */
    const outcome = await this.accountMail.sendPasswordReset(
      user,
      arrivalHost(request),
      request.ip ?? null,
    );
    if (outcome === "mail_disabled") {
      this.logger.warn(
        "Réinitialisation de mot de passe demandée alors que le SMTP n'est pas configuré : aucun jeton émis.",
      );
      return;
    }
    if (outcome !== "sent") return;

    await this.activity.record({
      event: "account.password_reset_requested",
      serverId: null,
      actorId: user.id,
      actorType: "user",
      actorLabel: user.email,
      ip: request.ip ?? null,
      userAgent: headerValue(request.headers["user-agent"]),
      // Ni le jeton ni son condensat : un journal d'audit se lit par des gens
      // qui n'ont pas à pouvoir s'en servir.
      properties: {},
    });
  }

  /**
   * Repose un mot de passe à partir d'un jeton.
   *
   * Le jeton est consommé **avant** toute vérification du nouveau mot de passe,
   * et c'est délibéré : sinon, un mot de passe refusé par la politique rendrait
   * le lien réutilisable, et l'on pourrait éprouver la politique autant de fois
   * qu'on veut avec le même courriel. Un jeton brûlé pour un mot de passe trop
   * faible coûte un clic de plus ; l'inverse coûte une faille.
   */
  @Post("password/reset")
  async resetPassword(@Body() body: unknown, @Req() request: ClientRequest, @Res() reply: Reply) {
    const payload = (body ?? {}) as { token?: unknown; password?: unknown };
    if (typeof payload.token !== "string" || typeof payload.password !== "string") {
      reply.status(422).send({ message: "Requête invalide.", problems: [] });
      return;
    }

    const consumed = await this.tokens.consume(payload.token, "password_reset");
    if (!consumed) {
      // Inconnu, expiré, déjà servi : la distinction n'intéresse que celui qui
      // cherche à deviner le format.
      reply.status(400).send({
        message: "Ce lien n'est plus valable. Demandez-en un nouveau.",
        problems: [],
      });
      return;
    }

    const user = await this.users.findById(consumed.userId);
    if (!user) {
      reply.status(400).send({ message: "Ce lien n'est plus valable.", problems: [] });
      return;
    }

    const { problems, pwnedCheckFailed } = await checkPassword(payload.password, {
      identity: identityFragments(user.email, user.nameFirst, user.nameLast),
      fetchImpl: globalThis.fetch as never,
    });

    if (problems.length > 0) {
      reply.status(422).send({ message: describeProblems(problems), problems });
      return;
    }

    await this.users.updatePassword(user.id, await hashPassword(payload.password));

    /**
     * **Toutes** les sessions tombent, sans exception.
     *
     * Contrairement au changement de mot de passe depuis son compte, où la
     * session courante survit : ici, on ne sait pas qui tenait les sessions
     * ouvertes. Le parcours existe précisément pour le cas où quelqu'un d'autre
     * a pris la main, et en épargner une reviendrait à le laisser dedans.
     */
    const revoked = await this.sessions.revokeOthers(user.id, null);

    await this.activity.record({
      event: "account.password_reset",
      serverId: null,
      actorId: user.id,
      actorType: "user",
      actorLabel: user.email,
      ip: request.ip ?? null,
      userAgent: headerValue(request.headers["user-agent"]),
      properties: { revokedSessions: revoked, pwnedCheckFailed },
    });
    this.noticeCredentialChange(user.id, "passwordReset", request);

    reply.status(200).send({ data: { revokedSessions: revoked, pwnedCheckFailed } });
  }

  /* --- Inscription --------------------------------------------------------- */

  /**
   * L'inscription est-elle ouverte ?
   *
   * Route publique, lue par la page de connexion pour décider si elle propose
   * « créer un compte ». Le lien existait et menait à une page absente, parce
   * que ni la page ni la route n'avaient jamais été écrites.
   */
  @Get("registration")
  async registrationStatus(): Promise<{
    data: {
      open: boolean;
      captchaSiteKey: string | null;
      passwordResetByEmail: boolean;
      billing: { provider: string; clientUrl: string | null };
    };
  }> {
    return {
      data: {
        open: await this.isRegistrationOpen(),
        /*
         * Où vont les clients.
         *
         * La page de connexion en a besoin pour dire la vérité : quand un
         * système de facturation est en service, le client n'a **pas** de mot
         * de passe ici, et lui présenter un formulaire comme chemin principal
         * l'envoie essayer des identifiants qui n'existent pas. Il doit repartir
         * vers son espace client, d'où le lien de connexion est fabriqué.
         *
         * Rien de sensible : le nom du facturier et l'adresse de son espace
         * client sont affichés sur la page d'accueil de n'importe quel
         * hébergeur. Ni l'API, ni ses identifiants ne sortent d'ici.
         */
        billing: {
          provider: await this.platform.text("billing.provider"),
          clientUrl: (await this.platform.text("billing.clientUrl")) || null,
        },
        // Servie ici plutôt que sur une route à elle : les écrans publics la
        // lisent au même moment, et une seconde route ferait un second
        // aller-retour pour deux champs.
        captchaSiteKey: await this.turnstile.siteKey(),
        /*
         * La réinitialisation par courrier fonctionne-t-elle ?
         *
         * Sans SMTP, le parcours entier tourne à vide : l'écran remercie, un
         * jeton est émis, et personne ne reçoit rien. L'écran de connexion a
         * besoin de le savoir **avant** de proposer le lien — c'est
         * exactement la question que `MailerService.isConfigured` existait
         * pour répondre, et que personne ne lui posait.
         *
         * Ce n'est pas un renseignement sensible : il dit qu'une plateforme
         * n'envoie pas de courrier, pas qui y a un compte.
         */
        passwordResetByEmail: await this.mail.isConfigured(),
      },
    };
  }

  /**
   * Crée un compte depuis la page publique.
   *
   * **Fermée par défaut**, et c'est le bon défaut : un panel d'hébergement
   * n'accueille pas n'importe qui, ses comptes viennent de la boutique. Le
   * réglage existe pour les plateformes qui en décident autrement.
   *
   * Trois refus avant toute écriture, dans cet ordre : inscription fermée,
   * authentification unique obligatoire — les comptes naissent alors chez le
   * fournisseur — et politique de mot de passe.
   *
   * **Un compromis assumé sur l'énumération.** Répondre « cette adresse est
   * déjà utilisée » dit à un inconnu qu'un compte existe, ce que la connexion
   * et le mot de passe oublié refusent tous deux de faire. L'alternative — un
   * acquittement identique dans tous les cas, suivi d'un courriel — suppose un
   * SMTP configuré pour que quiconque puisse s'inscrire, et laisse sans réponse
   * celui qui a simplement oublié qu'il avait un compte. Le formulaire étant
   * fermé par défaut, la fuite ne concerne que les plateformes qui l'ouvrent
   * délibérément, et le dire vaut mieux que le masquer à demi.
   */
  @Post("register")
  async register(@Body() body: unknown, @Req() request: ClientRequest, @Res() reply: Reply) {
    if (await this.captchaRefused(body, request, reply)) return;

    if (!(await this.isRegistrationOpen())) {
      reply.status(403).send({ message: "Les inscriptions sont fermées sur ce panel." });
      return;
    }

    if (await this.sso.configuration()) {
      reply.status(403).send({
        message: "Les comptes de ce panel sont créés par le fournisseur d'identité.",
        ssoRequired: true,
      });
      return;
    }

    const parsed = Registration.safeParse(body);
    if (!parsed.success) {
      reply.status(422).send({ message: "Requête invalide.", problems: [] });
      return;
    }

    const email = parsed.data.email.trim();
    const nameFirst = parsed.data.nameFirst.trim();
    const nameLast = parsed.data.nameLast.trim();

    const { problems, pwnedCheckFailed } = await checkPassword(parsed.data.password, {
      identity: identityFragments(email, nameFirst, nameLast),
      fetchImpl: globalThis.fetch as never,
    });

    if (problems.length > 0) {
      reply.status(422).send({ message: describeProblems(problems), problems });
      return;
    }

    if (await this.users.findByEmail(email)) {
      reply.status(409).send({
        message: "Un compte existe déjà avec cette adresse. Utilisez « mot de passe oublié ».",
        problems: [],
      });
      return;
    }

    const user = await this.users.register({
      email,
      nameFirst,
      nameLast,
      passwordHash: await hashPassword(parsed.data.password),
    });

    await this.activity.record({
      event: "account.registered",
      serverId: null,
      actorId: user.id,
      actorType: "user",
      actorLabel: user.email,
      ip: request.ip ?? null,
      userAgent: headerValue(request.headers["user-agent"]),
      properties: { pwnedCheckFailed },
    });

    /*
     * L'adresse est **non vérifiée** à la création, et le courrier part tout de
     * suite. Ouvrir la session sans attendre le clic est délibéré : la
     * vérification n'ouvre aucun droit, elle atteste seulement que la boîte est
     * lue. Faire patienter devant un écran blanc le temps qu'un courriel
     * arrive ferait perdre la moitié des inscrits pour rien.
     */
    await this.accountMail.sendEmailVerification(user, arrivalHost(request), request.ip ?? null);

    await this.issueSession(user.id, request, reply, "password");
  }

  /** Lecture du réglage, au même endroit pour les deux routes. */
  private isRegistrationOpen(): Promise<boolean> {
    return this.platform.boolean("security.registrationOpen");
  }

  /* --- Vérification d'adresse --------------------------------------------- */

  /**
   * Valide une adresse à partir du jeton reçu par courrier.
   *
   * Route **publique**, et volontairement : on clique sur ce lien depuis sa
   * boîte, souvent sur un autre appareil que celui où l'on était connecté.
   * Exiger une session ferait échouer le geste le plus naturel du parcours.
   *
   * Cela ne donne aucun accès : le jeton dit seulement que la personne qui l'a
   * reçu lit bien cette boîte, ce qui est exactement ce qu'on cherche à
   * établir.
   */
  @Post("email/verify")
  async verifyEmail(@Body() body: unknown, @Req() request: ClientRequest, @Res() reply: Reply) {
    const token = (body as { token?: unknown })?.token;
    if (typeof token !== "string" || token === "") {
      reply.status(422).send({ message: "Requête invalide." });
      return;
    }

    const consumed = await this.tokens.consume(token, "email_verify");
    if (!consumed) {
      reply.status(400).send({ message: "Ce lien n'est plus valable. Demandez-en un nouveau." });
      return;
    }

    const user = await this.users.markEmailVerified(consumed.userId);
    if (!user) {
      reply.status(400).send({ message: "Ce lien n'est plus valable." });
      return;
    }

    await this.activity.record({
      event: "account.email_verified",
      serverId: null,
      actorId: user.id,
      actorType: "user",
      actorLabel: user.email,
      ip: request.ip ?? null,
      userAgent: headerValue(request.headers["user-agent"]),
      properties: {},
    });

    reply.status(200).send({ data: { verified: true } });
  }

  /**
   * Renvoie le courrier de vérification au compte connecté.
   *
   * Sous session : on demande à vérifier **son** adresse, pas celle d'un autre.
   * Sans cela, la route deviendrait un moyen d'envoyer des courriels à n'importe
   * qui depuis notre domaine.
   *
   * Répond 204 même quand l'adresse est déjà vérifiée : l'écran n'a pas à
   * distinguer, et le dire renseignerait sur l'état d'un compte auquel on vient
   * peut-être d'accéder.
   */
  @Post("email/verify/send")
  @UseGuards(SessionGuard, ImpersonationReadOnlyGuard)
  @HttpCode(204)
  async sendEmailVerification(@Req() request: ClientRequest): Promise<void> {
    const session = requireUser(request);
    const user = await this.users.findById(session.id);
    if (!user || user.emailVerifiedAt !== null) return;

    // Plafond d'envoi atteint : la route répond comme si le courriel partait.
    await this.accountMail.sendEmailVerification(user, arrivalHost(request), request.ip ?? null);
  }

  /* --- Double authentification ------------------------------------------- */

  @Get("2fa")
  @UseGuards(SessionGuard, BrowserSessionGuard, ImpersonationReadOnlyGuard)
  async twoFactorStatus(
    @Req() request: ClientRequest,
  ): Promise<{ data: TwoFactorStatus & { required: boolean; localPassword: boolean } }> {
    const user = requireUser(request);
    const [status, account] = await Promise.all([
      this.twoFactor.status(user.id),
      this.users.findById(user.id),
    ]);

    /*
     * La plateforme exige-t-elle une seconde preuve de **ce** compte ?
     *
     * Rendu ici et non déduit ailleurs : le réglage vit dans l'espace
     * d'administration, dont l'accès est précisément ce que cette exigence
     * conditionne. Un écran qui irait le lire se heurterait au refus qu'il
     * cherche à expliquer.
     *
     * Faux pour un compte ordinaire, quelle que soit la valeur du réglage : il
     * ne porte que sur le personnel et les revendeurs — les rôles dont
     * `StaffTwoFactorGuard` garde l'espace.
     */
    const required =
      requiresStaffSecondFactor(user.role) &&
      (await this.platform.boolean("security.staffRequires2fa"));

    /*
     * Le compte a-t-il un mot de passe local à redonner ?
     *
     * Les gestes sensibles le redemandent ; un compte venu d'un fournisseur
     * d'identité ou de la facturation n'en a pas, et l'écran ne doit pas lui
     * présenter un champ qu'il ne saurait pas remplir.
     */
    const localPassword = Boolean(account?.passwordHash);

    return { data: { ...status, required, localPassword } };
  }

  /**
   * Prépare un secret et le rend, avec l'URI du QR code.
   *
   * Rien n'est exigé à la connexion tant que le code de confirmation n'est pas
   * fourni : une préparation abandonnée à mi-chemin — onglet fermé, téléphone à
   * plat — ne doit pas laisser un compte protégé par un secret que personne
   * n'a.
   *
   * Le mot de passe est redemandé (ASVS 3.7.1) : sans lui, une session volée
   * enrôlait son propre TOTP, et le titulaire se retrouvait devant un code
   * qu'il n'a jamais eu. Un compte sans mot de passe local passe, faute de
   * secret à redonner (voir `WithoutLocalPassword`).
   */
  @Post("2fa/setup")
  @UseGuards(SessionGuard, BrowserSessionGuard, ImpersonationReadOnlyGuard)
  async twoFactorSetup(
    @Body() body: unknown,
    @Req() request: ClientRequest,
    @Res() reply: Reply,
  ): Promise<void> {
    const user = await this.confirmedUser(body, request, reply, "allow");
    if (!user) return;

    const status = await this.twoFactor.status(user.id);
    if (status.enabled) {
      // Repartir d'un secret neuf effacerait celui qui fonctionne, sur une
      // requête qui pourrait n'être qu'un double-clic.
      reply.status(409).send({ message: "La double authentification est déjà active." });
      return;
    }

    const secret = await this.twoFactor.beginSetup(user.id);
    reply.status(201).send({
      data: {
        secret,
        uri: otpauthUri({ issuer: TOTP_ISSUER, account: user.email, secret }),
      },
    });
  }

  /**
   * Confirme la préparation et rend les codes de secours.
   *
   * C'est la seule fois où ils sortent en clair : seul leur condensat est
   * conservé. L'écran doit donc les montrer maintenant, ou jamais.
   */
  @Post("2fa/enable")
  @UseGuards(SessionGuard, BrowserSessionGuard, ImpersonationReadOnlyGuard)
  async twoFactorEnable(
    @Body() body: unknown,
    @Req() request: ClientRequest,
    @Res() reply: Reply,
  ): Promise<void> {
    const parsed = TotpCode.safeParse(body);
    if (!parsed.success) {
      reply.status(422).send({ message: "Code à six chiffres attendu." });
      return;
    }

    const user = requireUser(request);
    if (!(await this.twoFactor.confirmSetup(user.id, parsed.data.code))) {
      reply.status(403).send({
        message: "Code incorrect. Vérifiez l'heure de votre téléphone, puis réessayez.",
      });
      return;
    }

    const recoveryCodes = await this.twoFactor.resetRecoveryCodes(user.id);

    await this.activity.record({
      event: "account.2fa_enabled",
      serverId: null,
      actorId: user.id,
      actorType: "user",
      actorLabel: user.email,
      ip: request.ip ?? null,
      userAgent: headerValue(request.headers["user-agent"]),
      properties: {},
    });
    this.noticeCredentialChange(user.id, "twoFactorEnabled", request);

    reply.status(200).send({ data: { recoveryCodes } });
  }

  /**
   * Régénère les codes de secours.
   *
   * Le mot de passe est redemandé : ces codes contournent le second facteur,
   * les rendre à qui passe devant un écran déverrouillé annulerait la
   * protection qu'on croit avoir mise.
   */
  @Post("2fa/recovery-codes")
  @UseGuards(SessionGuard, BrowserSessionGuard, ImpersonationReadOnlyGuard)
  async twoFactorRecoveryCodes(
    @Body() body: unknown,
    @Req() request: ClientRequest,
    @Res() reply: Reply,
  ): Promise<void> {
    const user = await this.confirmedUser(body, request, reply);
    if (!user) return;

    if (!(await this.twoFactor.status(user.id)).enabled) {
      reply.status(409).send({ message: "La double authentification n'est pas active." });
      return;
    }

    const recoveryCodes = await this.twoFactor.resetRecoveryCodes(user.id);
    reply.status(200).send({ data: { recoveryCodes } });
  }

  /**
   * Désactive la double authentification.
   *
   * Le mot de passe est redemandé pour la même raison qu'au changement de mot
   * de passe : sans lui, un poste laissé déverrouillé une minute suffirait à
   * retirer la protection sans que son propriétaire s'en aperçoive.
   */
  @Delete("2fa")
  @UseGuards(SessionGuard, BrowserSessionGuard, ImpersonationReadOnlyGuard)
  async twoFactorDisable(
    @Body() body: unknown,
    @Req() request: ClientRequest,
    @Res() reply: Reply,
  ): Promise<void> {
    const user = await this.confirmedUser(body, request, reply);
    if (!user) return;

    /**
     * Seul le TOTP est retiré ; les clés d'accès restent.
     *
     * Ce sont deux preuves indépendantes, et faire tomber l'une avec l'autre
     * retirerait à quelqu'un une protection qu'il n'a pas demandé à perdre.
     * Les codes de secours ne s'effacent que si plus rien ne les rend utiles.
     */
    const remaining = await this.passkeys.listForUser(user.id);
    await this.twoFactor.disableTotp(user.id, remaining.length === 0);

    await this.activity.record({
      event: "account.2fa_disabled",
      serverId: null,
      actorId: user.id,
      actorType: "user",
      actorLabel: user.email,
      ip: request.ip ?? null,
      userAgent: headerValue(request.headers["user-agent"]),
      properties: { remainingPasskeys: remaining.length },
    });
    this.noticeCredentialChange(user.id, "twoFactorDisabled", request);

    reply.status(204).send(null);
  }

  /* --- Authentification unique -------------------------------------------- */

  /**
   * État de l'authentification unique, pour la page de connexion.
   *
   * Publique, et volontairement avare : uniquement « est-ce actif » et le nom
   * à écrire sur le bouton. Les URL et l'identifiant client sont de la
   * configuration, pas un renseignement à distribuer avant toute connexion.
   */
  /**
   * Ouvre la session d'un client arrivé depuis son espace de facturation.
   *
   * **À ne pas confondre avec les routes `sso/*` voisines**, et c'est pour
   * cela qu'elle ne porte pas ce préfixe : celles-là envoient l'utilisateur
   * s'authentifier **ailleurs**, chez un fournisseur d'identité externe.
   * Celle-ci reçoit quelqu'un que le facturier a **déjà** authentifié, et à
   * qui il a remis un jeton par l'API applicative. Les deux vont en sens
   * contraire, et les ranger sous le même nom est ce qui rendait le sujet
   * illisible.
   *
   * Le jeton est consommé ici et la session ouverte par le chemin commun à
   * toutes les connexions — c'est ce qui garantit le même cookie durci, la
   * même trace de dernière connexion, et une méthode d'authentification
   * consignée.
   *
   * Aucun message ne distingue le jeton inconnu, expiré ou déjà employé : la
   * distinction n'intéresse que celui qui cherche à en deviner un.
   */
  @Post("billing/consume")
  async billingConsume(
    @Body() body: unknown,
    @Req() request: ClientRequest,
    @Res() reply: Reply,
  ): Promise<void> {
    const token = (body as { token?: unknown })?.token;
    const consumed = typeof token === "string" ? await this.billingSso.consume(token) : null;

    if (!consumed) {
      reply.status(401).send({
        message: "Ce lien de connexion n'est plus valable. Reprenez depuis votre espace client.",
      });
      return;
    }

    /*
     * Le second facteur du panel s'applique aussi à ce chemin (NC-05).
     *
     * Le facturier atteste une identité, comme l'annuaire ou Google : il ne
     * prouve pas la possession de la clé enregistrée ici. Sans ce contrôle,
     * qui tenait l'espace client — ou une clé applicative — entrait dans un
     * compte protégé comme dans un autre. Le défi scelle la méthode : la
     * session ouverte au second facteur se dit venue de la facturation.
     */
    const status = await this.twoFactor.status(consumed.userId);
    if (status.enabled) {
      reply.status(200).send({
        twoFactorRequired: true,
        challenge: issueChallenge("login", consumed.userId, { method: "billing_sso" }),
        methods: { totp: status.totp, passkeys: await this.passkeysHere(consumed.userId, request) },
        remainingRecoveryCodes: status.remainingRecoveryCodes,
      });
      return;
    }

    await this.issueSession(consumed.userId, request, reply, "billing_sso");
  }

  @Get("sso")
  async ssoStatus(): Promise<{ data: { enabled: boolean; label: string | null } }> {
    const config = await this.sso.configuration();
    return { data: { enabled: config !== null, label: config?.label ?? null } };
  }

  /**
   * Ouvre une cérémonie et rend l'URL du fournisseur.
   *
   * L'état et le vérificateur PKCE repartent avec : c'est l'appelant — la
   * couche web — qui les conserve dans un cookie le temps de l'aller-retour.
   * Les garder ici supposerait une seule instance d'API, ce que la première
   * mise à l'échelle démentirait.
   */
  @Post("sso/start")
  ssoStart(@Body() body: unknown, @Res() reply: Reply): Promise<void> {
    return this.startCeremony("oidc", body, reply);
  }

  /**
   * Termine la cérémonie : échange le code, reconnaît le compte, ouvre la session.
   *
   * L'état n'est **pas** vérifié ici mais par la couche web, seule à détenir
   * le cookie qui le contient. L'API ne saurait pas le faire : elle ne voit
   * pas le navigateur.
   */
  @Post("sso/callback")
  ssoCallback(
    @Body() body: unknown,
    @Req() request: ClientRequest,
    @Res() reply: Reply,
  ): Promise<void> {
    return this.finishCeremony("oidc", body, request, reply);
  }

  /**
   * Le bouton « Se connecter avec Google » est-il proposé ? (PLAN §12.4,
   * décision 4.)
   *
   * Une porte de plus, à côté du mot de passe : jamais quand l'annuaire est
   * obligatoire, qui est alors le seul chemin.
   */
  @Get("google")
  async googleStatus(): Promise<{ data: { enabled: boolean } }> {
    return { data: { enabled: await this.sso.googleAvailable() } };
  }

  /** La même cérémonie que `sso/start`, chez Google. */
  @Post("google/start")
  googleStart(@Body() body: unknown, @Res() reply: Reply): Promise<void> {
    return this.startCeremony("google", body, reply);
  }

  /**
   * La même cérémonie que `sso/callback`, chez Google, à une différence près :
   * elle ne crée un compte que si les inscriptions sont ouvertes. Google
   * atteste une identité ; il n'ouvre pas le panel à qui n'y a pas de compte.
   */
  @Post("google/callback")
  googleCallback(
    @Body() body: unknown,
    @Req() request: ClientRequest,
    @Res() reply: Reply,
  ): Promise<void> {
    return this.finishCeremony("google", body, request, reply);
  }

  private async startCeremony(provider: SsoProvider, body: unknown, reply: Reply): Promise<void> {
    const parsed = SsoStartInput.safeParse(body);
    if (!parsed.success) {
      reply.status(422).send({ message: "Adresse de retour attendue." });
      return;
    }

    if (!(await this.isPanelRedirect(parsed.data.redirectUri))) {
      reply.status(422).send({ message: "Adresse de retour hors du panel." });
      return;
    }

    try {
      reply.status(200).send({ data: await this.sso.start(parsed.data.redirectUri, provider) });
    } catch (error) {
      reply.status(error instanceof SsoDisabledError ? 409 : 502).send({
        message: error instanceof Error ? error.message : "Cérémonie impossible.",
      });
    }
  }

  private async finishCeremony(
    provider: SsoProvider,
    body: unknown,
    request: ClientRequest,
    reply: Reply,
  ): Promise<void> {
    const parsed = SsoCallbackInput.safeParse(body);
    if (!parsed.success) {
      reply.status(422).send({ message: "Requête de retour incomplète." });
      return;
    }

    if (!(await this.isPanelRedirect(parsed.data.redirectUri))) {
      reply.status(422).send({ message: "Adresse de retour hors du panel." });
      return;
    }

    let profile: Awaited<ReturnType<typeof this.sso.profileFromCode>>;
    try {
      profile = await this.sso.profileFromCode(
        parsed.data.code,
        parsed.data.codeVerifier,
        parsed.data.redirectUri,
        provider,
      );
    } catch (error) {
      reply.status(error instanceof SsoDisabledError ? 409 : 502).send({
        message: error instanceof Error ? error.message : "Le fournisseur a refusé la connexion.",
      });
      return;
    }

    let resolved: SsoResolution;
    try {
      resolved = await this.sso.resolveUser(profile, {
        provider,
        // L'annuaire crée ses comptes : il est la source de vérité de
        // l'équipe. Le bouton Google suit la règle de la page d'inscription.
        mayCreate: provider === "oidc" || (await this.isRegistrationOpen()),
      });
    } catch (error) {
      /**
       * Seuls les refus que le service a rédigés sont répétés au navigateur.
       *
       * Tout le reste — panne de base, contrainte violée — reçoit une phrase
       * générique : un message d'erreur SQL affiché sur la page de connexion
       * décrit les colonnes de la table `users` à qui passait par là.
       */
      const redige = error instanceof SsoExchangeError || error instanceof SsoNoAccountError;
      if (!redige) {
        this.logger.error(
          `Rapprochement SSO impossible : ${error instanceof Error ? error.message : "erreur inconnue"}`,
        );
      }

      // Un 409 plutôt qu'un 502 : rien n'est en panne, c'est la situation qui
      // ne permet pas de conclure. `noAccount` laisse la page de connexion
      // dire ce qu'il faut faire, plutôt qu'un refus sans raison.
      reply.status(409).send({
        message: redige
          ? error.message
          : "Ce compte n'a pas pu être ouvert. Contactez l'administrateur du panel.",
        ...(error instanceof SsoNoAccountError ? { noAccount: true } : {}),
      });
      return;
    }

    /*
     * Le profil du fournisseur a remplacé l'adresse du compte : l'ancienne
     * boîte est prévenue (ASVS 2.5.5), et les liens qui y sont partis
     * s'éteignent, comme pour un changement fait par l'administration.
     */
    if (resolved.previousEmail) {
      await this.tokens.revokePending(resolved.id, ["password_reset", "email_verify"]);
      this.alerts.afterCredentialChange({
        userId: resolved.id,
        kind: "emailChanged",
        ip: request.ip ?? null,
        host: arrivalHost(request),
        previousEmail: resolved.previousEmail,
      });
    }

    await this.activity.record({
      event:
        provider === "google"
          ? resolved.created
            ? "account.google_created"
            : "account.google_login"
          : resolved.created
            ? "account.sso_created"
            : "account.sso_login",
      serverId: null,
      actorId: resolved.id,
      actorType: "user",
      actorLabel: profile.email ?? profile.subject,
      ip: request.ip ?? null,
      userAgent: headerValue(request.headers["user-agent"]),
      // Ni jeton ni profil complet : le journal dit qui est entré et par où,
      // il n'a pas à conserver ce que le fournisseur a répondu.
      properties: { subject: profile.subject },
    });

    // Le moyen d'entrée tel que la liste des sessions le nomme.
    const method = provider === "google" ? "google" : "sso";

    /**
     * Le second facteur du panel s'applique aussi aux comptes SSO.
     *
     * Le fournisseur atteste d'une identité, pas de la possession d'une clé
     * enregistrée ici. Quelqu'un qui a activé une clé d'accès sur ce panel
     * s'attend à ce qu'elle soit demandée, quel que soit le chemin d'entrée.
     */
    const status = await this.twoFactor.status(resolved.id);
    if (status.enabled) {
      reply.status(200).send({
        twoFactorRequired: true,
        challenge: issueChallenge("login", resolved.id, { method }),
        methods: { totp: status.totp, passkeys: await this.passkeysHere(resolved.id, request) },
        remainingRecoveryCodes: status.remainingRecoveryCodes,
      });
      return;
    }

    await this.issueSession(resolved.id, request, reply, method);
  }

  /* --- Clés SSH ------------------------------------------------------------ */

  /**
   * Clés publiques SSH du compte, pour le SFTP.
   *
   * Sous `BrowserSessionGuard` comme le reste de la sécurité du compte : une
   * clé d'API ne doit pas pouvoir s'ajouter une clé SSH. Ce serait convertir
   * un jeton volé, limité à ce que ses portées permettent, en un accès
   * permanent aux fichiers de tous les serveurs du compte.
   */
  @Get("ssh-keys")
  @UseGuards(SessionGuard, BrowserSessionGuard, ImpersonationReadOnlyGuard)
  async listSshKeys(@Req() request: ClientRequest): Promise<{ data: SshKeySummary[] }> {
    return { data: await this.sshKeys.listForUser(requireUser(request).id) };
  }

  @Post("ssh-keys")
  @UseGuards(SessionGuard, BrowserSessionGuard, ImpersonationReadOnlyGuard)
  async addSshKey(
    @Body() body: unknown,
    @Req() request: ClientRequest,
    @Res() reply: Reply,
  ): Promise<void> {
    const parsed = SshKeyInput.safeParse(body);
    if (!parsed.success) {
      reply.status(422).send({ message: "Clé publique attendue." });
      return;
    }

    // Une clé SSH ouvre les fichiers de tous les serveurs du compte, et survit
    // à la session qui l'a posée : le mot de passe est redemandé.
    const user = await this.confirmedUser(body, request, reply, "allow");
    if (!user) return;

    const key = await this.sshKeys.add(user.id, parsed.data.name, parsed.data.publicKey);

    await this.activity.record({
      event: "account.ssh_key_added",
      serverId: null,
      actorId: user.id,
      actorType: "user",
      actorLabel: user.email,
      ip: request.ip ?? null,
      userAgent: headerValue(request.headers["user-agent"]),
      // L'empreinte, pas la clé : elle suffit à reconnaître laquelle, et une
      // clé publique entière dans un journal n'apprend rien de plus.
      properties: { fingerprint: key.fingerprint },
    });

    reply.status(201).send({ data: key });
  }

  @Delete("ssh-keys/:id")
  @UseGuards(SessionGuard, BrowserSessionGuard, ImpersonationReadOnlyGuard)
  @HttpCode(204)
  async removeSshKey(@Param("id") id: string, @Req() request: ClientRequest): Promise<void> {
    const user = requireUser(request);
    // Répondre 204 même quand rien n'a été retiré : l'écran n'a pas à
    // distinguer, et le dire renseignerait sur les clés d'un autre compte.
    if (!(await this.sshKeys.remove(user.id, id))) return;

    await this.activity.record({
      event: "account.ssh_key_removed",
      serverId: null,
      actorId: user.id,
      actorType: "user",
      actorLabel: user.email,
      ip: request.ip ?? null,
      userAgent: headerValue(request.headers["user-agent"]),
      properties: {},
    });
  }

  /* --- Clés d'accès ------------------------------------------------------- */

  @Get("2fa/passkeys")
  @UseGuards(SessionGuard, BrowserSessionGuard, ImpersonationReadOnlyGuard)
  async listPasskeys(@Req() request: ClientRequest): Promise<{ data: PasskeySummary[] }> {
    return { data: await this.passkeys.listForUser(requireUser(request).id) };
  }

  /**
   * Options d'enregistrement, avec le défi scellé à renvoyer ensuite.
   *
   * Le défi aléatoire ne part pas seul : il revient dans un jeton chiffré que
   * l'API pourra relire. Le garder en mémoire côté serveur supposerait une
   * seule instance d'API, ce que la première mise à l'échelle démentirait.
   *
   * Le mot de passe est redemandé ici, au début de la cérémonie : c'est le
   * seul moment où l'écran peut encore le demander, avant que la boîte de
   * dialogue du navigateur ne prenne la main. Le défi scellé qui en sort vaut
   * ensuite confirmation pour l'enregistrement.
   */
  @Post("2fa/passkeys/options")
  @UseGuards(SessionGuard, BrowserSessionGuard, ImpersonationReadOnlyGuard)
  async passkeyRegistrationOptions(
    @Body() body: unknown,
    @Req() request: ClientRequest,
    @Res() reply: Reply,
  ): Promise<void> {
    const user = await this.confirmedUser(body, request, reply, "allow");
    if (!user) return;

    const rp = await this.relyingParty(request);
    const options = await this.passkeyService.registrationOptions(rp, {
      id: user.id,
      email: user.email,
      name: `${user.nameFirst} ${user.nameLast}`.trim(),
    });

    reply.status(200).send({
      data: {
        options,
        challenge: issueChallenge("passkey-register", user.id, { webauthn: options.challenge }),
      },
    });
  }

  /** Vérifie l'enregistrement et range la clé. */
  @Post("2fa/passkeys")
  @UseGuards(SessionGuard, BrowserSessionGuard, ImpersonationReadOnlyGuard)
  async registerPasskey(
    @Body() body: unknown,
    @Req() request: ClientRequest,
    @Res() reply: Reply,
  ): Promise<void> {
    const parsed = PasskeyRegistration.safeParse(body);
    if (!parsed.success) {
      reply.status(422).send({ message: "Réponse d'authentifiant attendue." });
      return;
    }

    const user = requireUser(request);
    const sealed = readChallenge("passkey-register", parsed.data.challenge);
    // Consommé à la lecture, en base : une réponse WebAuthn est valide ou à
    // refaire, et le défi qu'elle signe ne doit resservir nulle part.
    if (
      !sealed ||
      sealed.userId !== user.id ||
      !sealed.webauthn ||
      !(await this.tokens.claimChallenge(sealed))
    ) {
      reply.status(401).send({ message: "Demande expirée. Recommencez." });
      return;
    }

    const registered = await this.passkeyService.verifyRegistration(
      await this.relyingParty(request),
      user.id,
      sealed.webauthn,
      parsed.data.response as never,
      parsed.data.label.trim() || DEFAULT_PASSKEY_LABEL,
    );

    if (!registered) {
      reply.status(403).send({ message: "La clé n'a pas pu être vérifiée. Recommencez." });
      return;
    }

    await this.twoFactor.setFlag(user.id, true);

    /**
     * Première preuve posée : il faut des codes de secours.
     *
     * Sans eux, protéger son compte par une seule clé revient à parier son
     * accès sur un objet qui se perd. Ils ne sont rendus que s'ils viennent
     * d'être créés — ceux d'un TOTP déjà en place restent valables et ne sont
     * de toute façon pas relisibles.
     */
    const recoveryCodes = await this.twoFactor.ensureRecoveryCodes(user.id);

    await this.activity.record({
      event: "account.passkey_added",
      serverId: null,
      actorId: user.id,
      actorType: "user",
      actorLabel: user.email,
      ip: request.ip ?? null,
      userAgent: headerValue(request.headers["user-agent"]),
      properties: { label: parsed.data.label.trim() || DEFAULT_PASSKEY_LABEL },
    });
    this.noticeCredentialChange(user.id, "passkeyAdded", request);

    reply.status(201).send({ data: { recoveryCodes } });
  }

  /**
   * Supprime une clé d'accès.
   *
   * Le mot de passe est redemandé : retirer une seconde preuve est de la même
   * nature que désactiver la double authentification, et un écran laissé
   * déverrouillé ne doit pas suffire.
   */
  @Delete("2fa/passkeys/:id")
  @UseGuards(SessionGuard, BrowserSessionGuard, ImpersonationReadOnlyGuard)
  async removePasskey(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: ClientRequest,
    @Res() reply: Reply,
  ): Promise<void> {
    const user = await this.confirmedUser(body, request, reply);
    if (!user) return;

    if (!(await this.passkeys.remove(user.id, id))) {
      reply.status(404).send({ message: "Clé introuvable." });
      return;
    }

    /**
     * Plus aucune preuve : les codes de secours n'ont plus rien à secourir.
     *
     * Les garder laisserait des clés d'accès valables sur un compte qui ne
     * demande plus que son mot de passe — un contournement silencieux de la
     * protection qu'on vient précisément de retirer.
     */
    const status = await this.twoFactor.status(user.id);
    if (!status.enabled) {
      await this.twoFactor.dropRecoveryCodes(user.id);
      await this.twoFactor.setFlag(user.id, false);
    }

    await this.activity.record({
      event: "account.passkey_removed",
      serverId: null,
      actorId: user.id,
      actorType: "user",
      actorLabel: user.email,
      ip: request.ip ?? null,
      userAgent: headerValue(request.headers["user-agent"]),
      properties: { remaining: status.passkeys },
    });
    this.noticeCredentialChange(user.id, "passkeyRemoved", request);

    reply.status(204).send(null);
  }

  /**
   * Options d'authentification, à partir du défi de connexion.
   *
   * Le mot de passe a déjà nommé le compte : le navigateur peut donc désigner
   * directement la bonne clé plutôt que de demander laquelle employer.
   */
  @Post("login/2fa/passkey/options")
  async passkeyAuthenticationOptions(
    @Body() body: unknown,
    @Req() request: ClientRequest,
    @Res() reply: Reply,
  ): Promise<void> {
    const parsed = ChallengeOnly.safeParse(body);
    if (!parsed.success) {
      reply.status(422).send({ message: publicFailureMessage() });
      return;
    }

    const sealed = readChallenge("login", parsed.data.challenge);
    // Un défi déjà servi n'ouvre pas non plus de cérémonie.
    if (!sealed || (await this.tokens.challengeClaimed(sealed.jti))) {
      reply.status(401).send({ message: "Demande de connexion expirée. Recommencez." });
      return;
    }

    const rp = await this.relyingParty(request);
    const options = await this.passkeyService.authenticationOptions(rp, sealed.userId);

    reply.status(200).send({
      data: {
        options,
        // Nouveau jeton, de nature « passkey-login » : celui de la connexion ne
        // porte pas le défi aléatoire, et l'un ne doit pas valoir pour l'autre.
        // Il emporte l'identité du défi de connexion, consommé avec lui quand
        // la clé ouvre la session (NC-32).
        challenge: issueChallenge("passkey-login", sealed.userId, {
          webauthn: options.challenge,
          parent: { jti: sealed.jti, expiresAt: sealed.expiresAt },
        }),
      },
    });
  }

  /** Vérifie l'assertion et ouvre la session. */
  @Post("login/2fa/passkey")
  async loginWithPasskey(
    @Body() body: unknown,
    @Req() request: ClientRequest,
    @Res() reply: Reply,
  ): Promise<void> {
    const parsed = PasskeyAssertion.safeParse(body);
    if (!parsed.success) {
      reply.status(422).send({ message: publicFailureMessage() });
      return;
    }

    const sealed = readChallenge("passkey-login", parsed.data.challenge);
    if (!sealed?.webauthn) {
      reply.status(401).send({ message: "Demande de connexion expirée. Recommencez." });
      return;
    }

    const user = await this.users.findById(sealed.userId);
    // Consommé à la lecture, en base, une fois le compte relu (la trace s'y
    // rattache) : l'assertion est valide ou à refaire, et le défi qu'elle
    // signe ne doit resservir sur aucune instance.
    if (!user || !(await this.tokens.claimChallenge(sealed))) {
      reply.status(401).send({ message: "Demande de connexion expirée. Recommencez." });
      return;
    }

    const verified = await this.passkeyService.verifyAuthentication(
      await this.relyingParty(request),
      sealed.userId,
      sealed.webauthn,
      parsed.data.response as never,
    );

    if (!verified) {
      // Pas de délai progressif : une signature ne se devine pas par essais
      // successifs, contrairement à six chiffres. Le ralentissement viserait
      // un risque qui n'existe pas ici.
      await this.recordFailure(user.email, request, user, "passkey");
      reply.status(401).send({ message: publicFailureMessage() });
      return;
    }

    /*
     * Le défi de connexion d'où vient la cérémonie a servi lui aussi (NC-32).
     *
     * Seul le défi `passkey-login` était consommé : le défi `login` restait
     * valable cinq minutes après la connexion, et rouvrait une session avec un
     * code de secours ou une nouvelle cérémonie. Consommé **après** la
     * signature vérifiée, pas avant : une clé qui échoue laisse l'utilisateur
     * réessayer, ou passer au code, sans retaper son mot de passe. Déjà servi
     * — par un code, dans un autre onglet —, la session n'est pas ouverte une
     * seconde fois.
     */
    if (
      !sealed.parent ||
      !(await this.tokens.claimChallenge({ ...sealed.parent, userId: sealed.userId }))
    ) {
      reply.status(401).send({ message: "Demande de connexion expirée. Recommencez." });
      return;
    }

    // Toutes les preuves sont données : l'adresse devient connue du compte,
    // comme après un code (NC-29).
    await this.users.recordAttempt(user.email, request.ip ?? null, true);
    await this.issueSession(user.id, request, reply, "passkey");
  }

  /**
   * Relit le compte appelant après confirmation de son mot de passe.
   *
   * Répond elle-même en cas de refus et rend `null` : toutes les routes qui
   * l'emploient ont le même contrôle à faire, et le dupliquer ferait qu'un
   * jour l'une d'elles l'oublierait. Le contrôle lui-même vit dans
   * `PasswordConfirmationService`, que la création d'une clé d'API emploie
   * aussi.
   */
  private async confirmedUser(
    body: unknown,
    request: ClientRequest,
    reply: Reply,
    withoutLocalPassword: WithoutLocalPassword = "refuse",
  ): Promise<ConfirmedUser | null> {
    const outcome = await this.confirmation.confirm(
      requireUser(request).id,
      body,
      attemptOrigin(request),
      withoutLocalPassword,
    );
    if (outcome.ok) return outcome.user;

    if (outcome.retryAfterSeconds !== undefined) {
      reply.header("Retry-After", String(outcome.retryAfterSeconds));
    }
    reply.status(outcome.status).send({ message: outcome.message });
    return null;
  }

  /**
   * Sessions encore ouvertes du compte appelant.
   *
   * Aucun paramètre d'utilisateur : le compte est celui que la garde a
   * reconnu. Accepter un identifiant en entrée ferait de cette route un moyen
   * de lire les appareils d'autrui.
   */
  @Get("sessions")
  @UseGuards(SessionGuard, BrowserSessionGuard, ImpersonationReadOnlyGuard)
  async listSessions(@Req() request: ClientRequest): Promise<{ data: SessionSummary[] }> {
    const user = requireUser(request);
    return { data: await this.sessions.listForUser(user.id, request.sessionToken) };
  }

  /**
   * Ferme une session désignée.
   *
   * Répond 404 lorsque rien n'a été fermé, sans distinguer « inconnue », « à
   * quelqu'un d'autre » et « déjà fermée » : séparer ces cas permettrait de
   * tester l'existence des sessions d'autrui un identifiant à la fois.
   */
  @Delete("sessions/:id")
  @UseGuards(SessionGuard, BrowserSessionGuard, ImpersonationReadOnlyGuard)
  async revokeSession(
    @Param("id") id: string,
    @Req() request: ClientRequest,
    @Res() reply: Reply,
  ): Promise<void> {
    const user = requireUser(request);
    const { revoked, wasCurrent } = await this.sessions.revokeById(
      user.id,
      id,
      request.sessionToken,
    );
    if (!revoked) {
      reply.status(404).send({ message: "Session introuvable." });
      return;
    }

    /**
     * Fermer sa propre session depuis cette page est permis — c'est une
     * déconnexion — mais il faut alors retirer le cookie. Le laisser en place
     * renverrait à chaque page un cookie que le serveur refuse, c'est-à-dire
     * une déconnexion qui n'a pas l'air d'en être une.
     */
    if (wasCurrent) reply.clearCookie(sessionCookie(), authCookieOptions());
    reply.status(204).send(null);
  }

  /** Ferme toutes les autres sessions, en gardant celle qui le demande. */
  @Delete("sessions")
  @UseGuards(SessionGuard, BrowserSessionGuard, ImpersonationReadOnlyGuard)
  async revokeOtherSessions(@Req() request: ClientRequest): Promise<{ data: { revoked: number } }> {
    const user = requireUser(request);
    return { data: { revoked: await this.sessions.revokeOthers(user.id, request.sessionToken) } };
  }
}

/**
 * L'utilisateur posé par la garde.
 *
 * `SessionGuard` refuse la requête quand il n'y en a pas ; ce garde-fou ne
 * sert qu'à ce que le type le dise aussi, plutôt que de semer des `?.` dont
 * chacun deviendrait un chemin silencieux le jour où la garde changerait.
 */
function requireUser(request: ClientRequest): SessionUser {
  if (!request.user) throw new UnauthorizedException();
  return request.user;
}

/**
 * Condensat d'une valeur fixe, calculé une fois et réutilisé.
 *
 * Il ne sert qu'à faire travailler `verifyPassword` pendant la même durée que
 * pour un compte réel. Le recalculer à chaque tentative gaspillerait du temps
 * processeur sans rien ajouter.
 */
let cachedDigest: Promise<string> | null = null;
function emptyDigest(): Promise<string> {
  cachedDigest ??= hashPassword("compte-inexistant");
  return cachedDigest;
}

/**
 * Lit un cookie dans l'en-tête brut.
 *
 * Fastify décore la requête d'un `cookies`, mais le type local de ce
 * contrôleur ne le déclare pas : il ne connaît de la requête que ce qu'il en
 * emploie. Relire l'en-tête ici évite d'élargir ce contrat pour un seul usage.
 */
function headerCookie(request: ClientRequest, name: string): string | null {
  const raw = headerValue(request.headers.cookie);
  if (!raw) return null;

  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("=")) || null;
  }
  return null;
}

/**
 * Domaine par lequel la requête est arrivée, tel que la couche web le rapporte.
 *
 * L'API ne voit jamais l'hôte du navigateur : c'est Next qui l'appelle, et son
 * propre `Host` est celui du service interne. L'en-tête est donc la seule
 * source, et la couche web la renseigne à chaque appel.
 *
 * **L'en-tête est forgeable** : il ne choisit la marque du courrier et le
 * domaine du lien que s'il correspond à un domaine revendeur vérifié (voir
 * `AccountMailService.linkDomain`). Les routes qui accordent quelque chose lisent la session,
 * jamais cet en-tête.
 */
function arrivalHost(request: ClientRequest): string | null {
  const value = headerValue(request.headers["x-gd-host"]);
  const host = value?.trim().toLowerCase() ?? "";
  return host === "" ? null : host;
}

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}
