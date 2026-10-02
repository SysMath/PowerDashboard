import { hashPassword, totpCodeAt, totpStep } from "@gamedashboard/auth";
import {
  activityLogs,
  type Database,
  loginAttempts,
  notifications,
  userPasskeys,
  users,
} from "@gamedashboard/db";
import { HttpException, Logger } from "@nestjs/common";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createThrowawayDatabase,
  HAS_DATABASE,
  NO_DATABASE_REASON,
  type ThrowawayDatabase,
} from "../../test/throwaway-database";
import { ActivityService } from "../activity/activity.service";
import type { PlatformSettingsService } from "../admin/platform-settings.service";
import { AccountController } from "../client/account.controller";
import type { MailerService } from "../mail/mailer.service";
import { NotificationPreferencesRepository } from "../notifications/notification-preferences.repository";
import { NotificationsService } from "../notifications/notifications.service";
import { PushOutboxService } from "../push/push-outbox.service";
import type { BrandingService } from "../reseller/branding.service";
import type { ClientWebhookEmitterService } from "../webhooks/client-webhook-emitter.service";
import { AuthController } from "./auth.controller";
import { AuthTokenRepository } from "./auth-token.repository";
import { issueChallenge } from "./login-challenge";
import { PasskeyRepository } from "./passkey.repository";
import { PasswordConfirmationService } from "./password-confirmation.service";
import { SecurityAlertRepository } from "./security-alert.repository";
import { CREDENTIAL_CHANGE_ALERT, SecurityAlertService } from "./security-alert.service";
import { SessionRepository } from "./session.repository";
import { SessionIssuerService } from "./session-issuer.service";
import { TwoFactorRepository } from "./two-factor.repository";
import { UserRepository } from "./user.repository";

/**
 * Ce qui arrive autour d'un authentifiant : son changement, les liens qui
 * l'entourent, les échecs qu'il provoque.
 *
 * Contre une vraie base, comme les alertes de sécurité : les décisions vivent
 * dans des prédicats SQL (jetons « non consommés », échecs « dans la
 * fenêtre »), et une doublure n'éprouverait que son accord avec elle-même.
 * Seuls le transport SMTP, le captcha, la marque et HaveIBeenPwned sont
 * simulés : ils ne décident de rien ici.
 */

const PASSWORD = "cheval-agrafe-batterie-correcte";
const NEW_PASSWORD = "lanterne-fougere-horizon-tiede";
const FIREFOX = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0";

/** Réponse Fastify réduite à ce que le contrôleur emploie. */
function fakeReply() {
  const reply = {
    statusCode: 200,
    body: undefined as unknown,
    cookies: new Map<string, string>(),
    status(code: number) {
      reply.statusCode = code;
      return reply;
    },
    header() {
      return reply;
    },
    setCookie(name: string, value: string) {
      reply.cookies.set(name, value);
      return reply;
    },
    clearCookie() {
      return reply;
    },
    send(body: unknown) {
      reply.body = body;
    },
  };
  return reply;
}

interface Account {
  id: string;
  email: string;
  role: string;
}

describe.skipIf(!HAS_DATABASE)("Authentifiants (intégration)", () => {
  let throwaway: ThrowawayDatabase;
  let db: Database;
  let digest: string;
  let mail: { send: ReturnType<typeof vi.fn>; isConfigured: () => Promise<boolean> };
  let tokens: AuthTokenRepository;
  let alerts: SecurityAlertService;
  let twoFactor: TwoFactorRepository;
  let controller: AuthController;
  let account_: AccountController;
  /** Doublures de ce qui n'est pas en jeu : on vérifie seulement qu'on n'y arrive pas. */
  let sshKeys: { add: ReturnType<typeof vi.fn> };
  let apiKeys: { create: ReturnType<typeof vi.fn> };
  /** Réglages booléens de la plateforme ; absents, ils valent faux. */
  let settings: Record<string, boolean>;

  beforeAll(async () => {
    Logger.overrideLogger(false);
    // Le secret TOTP est chiffré en base, et les clés d'accès sont liées à
    // l'origine du panel.
    process.env.APP_SECRET_KEY ??= "clé-de-test-uniquement-pour-vitest";
    process.env.PANEL_ORIGIN ||= "https://gamedashboard.local";
    throwaway = await createThrowawayDatabase();
    db = throwaway.db;
    digest = await hashPassword(PASSWORD);
    // HaveIBeenPwned : aucune fuite connue, et surtout aucun appel réseau.
    vi.stubGlobal("fetch", async () => ({ ok: true, status: 200, text: async () => "" }));
  }, 60_000);

  /*
   * Les avis et le journal partent en tâches détachées : une tâche encore en
   * vol écrirait pendant le `truncate` du test suivant, qui finirait en
   * interblocage.
   */
  afterEach(async () => {
    await alerts.settled();
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await throwaway?.drop();
  });

  beforeEach(async () => {
    await db.execute(
      sql.raw("truncate table users, login_attempts, activity_logs, auth_tokens cascade"),
    );

    mail = { send: vi.fn(async () => true), isConfigured: async () => true };
    settings = {};
    const mailer = mail as unknown as MailerService;
    const branding = {
      forHost: async () => ({ name: "GameDashboard", resellerId: null }),
    } as unknown as BrandingService;
    const platform = {
      text: async () => "gamedashboard.local",
      boolean: async (key: string) => settings[key] ?? false,
    } as unknown as PlatformSettingsService;

    const userRepository = new UserRepository(db);
    const sessions = new SessionRepository(db);
    const activity = new ActivityService(db);
    tokens = new AuthTokenRepository(db);
    twoFactor = new TwoFactorRepository(db);
    alerts = new SecurityAlertService(
      new SecurityAlertRepository(db),
      new NotificationsService(
        db,
        new NotificationPreferencesRepository(db),
        mailer,
        { emit: async () => {} } as unknown as ClientWebhookEmitterService,
        {
          forReseller: async () => ({ branding: { name: "Panel", replyTo: null }, domain: null }),
        } as unknown as BrandingService,
        new PushOutboxService(db),
      ),
      mailer,
      activity,
      branding,
      platform,
    );

    const confirmation = new PasswordConfirmationService(userRepository, alerts);
    sshKeys = { add: vi.fn(async () => ({ id: "cle", fingerprint: "SHA256:empreinte" })) };
    apiKeys = { create: vi.fn(async () => ({ plaintext: "gd_secret" })) };

    controller = new AuthController(
      userRepository,
      sessions,
      activity,
      twoFactor,
      new PasskeyRepository(db),
      // La cérémonie WebAuthn a ses propres tests : ici, seule compte la suite.
      {
        verifyRegistration: async () => true,
        registrationOptions: async () => ({ challenge: "défi" }),
      } as never,
      { configuration: async () => null } as never,
      {} as never,
      new SessionIssuerService(sessions, userRepository, alerts),
      tokens,
      mailer,
      platform,
      sshKeys as never,
      { accepts: async () => true } as never,
      alerts,
      {} as never,
      // Les consoles de Wings : aucune n'est ouverte ici.
      {} as never,
      {} as never,
      confirmation,
      {
        forHost: async () => ({ name: "GameDashboard", resellerId: null }),
      } as unknown as BrandingService,
    );
    account_ = new AccountController(apiKeys as never, {} as never, confirmation);
  });

  async function seedAccount(
    role: "user" | "admin" | "reseller" = "user",
    passwordHash: string | null = digest,
  ): Promise<Account> {
    const email = `titulaire-${Math.random().toString(16).slice(2, 8)}@gamedashboard.test`;
    const [row] = await db
      .insert(users)
      .values({
        email,
        nameFirst: "Alex",
        nameLast: "Titulaire",
        passwordHash,
        role,
        locale: "fr",
        timezone: "Europe/Paris",
        emailVerifiedAt: new Date().toISOString(),
      })
      .returning({ id: users.id, email: users.email, role: users.role });
    if (!row) throw new Error("compte non créé");
    return row;
  }

  /** Requête d'une session déjà ouverte sur ce compte, telle que la garde la pose. */
  function signedIn(account: Account, ip = "203.0.113.7") {
    return {
      ip,
      headers: { "user-agent": FIREFOX },
      socket: { remoteAddress: "127.0.0.1" },
      user: {
        id: account.id,
        email: account.email,
        nameFirst: "Alex",
        nameLast: "Titulaire",
        role: account.role,
        locale: "fr",
        timezone: "Europe/Paris",
        avatarUrl: null,
        emailVerifiedAt: new Date().toISOString(),
        authMethod: "password",
        impersonatorId: null,
      },
    } as never;
  }

  /** Connexion par mot de passe, depuis une adresse donnée. */
  async function login(email: string, password: string, ip = "203.0.113.7") {
    const reply = fakeReply();
    await controller.login(
      { email, password },
      { ip, headers: { "user-agent": FIREFOX }, socket: { remoteAddress: "127.0.0.1" } } as never,
      reply as never,
    );
    return reply;
  }

  /**
   * Échecs posés directement en base : les rejouer par la route coûterait le
   * délai progressif, jusqu'à cinq secondes par tentative.
   */
  async function seedFailures(email: string, ip: string, count: number): Promise<void> {
    const at = new Date().toISOString();
    await db
      .insert(loginAttempts)
      .values(Array.from({ length: count }, () => ({ email, ip, success: false, at })));
  }

  /** Active le TOTP, confirmé par le code du pas précédent : celui en cours reste libre. */
  async function enableTotp(account: Account): Promise<string> {
    const secret = await twoFactor.beginSetup(account.id);
    if (!(await twoFactor.confirmSetup(account.id, totpCodeAt(secret, totpStep() - 1)))) {
      throw new Error("TOTP non confirmé");
    }
    return secret;
  }

  /** Second facteur, à partir du défi rendu par la connexion. */
  async function secondFactor(challenge: string, code: string, ip: string) {
    const reply = fakeReply();
    await controller.loginTwoFactor(
      { challenge, code },
      { ip, headers: { "user-agent": FIREFOX }, socket: { remoteAddress: "127.0.0.1" } } as never,
      reply as never,
    );
    return reply;
  }

  /** Réussites consignées pour ce compte depuis cette adresse. */
  async function successesFrom(email: string, ip: string): Promise<number> {
    const rows = await db
      .select({ at: loginAttempts.at })
      .from(loginAttempts)
      .where(
        and(
          eq(loginAttempts.email, email),
          eq(loginAttempts.ip, ip),
          eq(loginAttempts.success, true),
        ),
      );
    return rows.length;
  }

  /** Le journal d'audit, dans l'ordre d'écriture. */
  async function journal() {
    return await db
      .select({
        event: activityLogs.event,
        actorId: activityLogs.actorId,
        actorLabel: activityLogs.actorLabel,
        ip: activityLogs.ip,
        properties: activityLogs.properties,
      })
      .from(activityLogs)
      .orderBy(asc(activityLogs.at));
  }

  /** Courriels partis vers cette adresse. */
  function mailsTo(address: string): { subject: string; text: string }[] {
    return mail.send.mock.calls
      .map((call) => call[0] as { to: string; subject: string; text: string })
      .filter((sent) => sent.to === address);
  }

  /** Titres des avis de changement déposés dans la cloche du compte. */
  async function bellOf(userId: string): Promise<string[]> {
    const rows = await db
      .select({ title: notifications.title, type: notifications.type })
      .from(notifications)
      .where(eq(notifications.userId, userId));
    return rows.filter((row) => row.type === CREDENTIAL_CHANGE_ALERT).map((row) => row.title);
  }

  describe("changement de mot de passe", () => {
    it("éteint les liens de réinitialisation encore valables", async () => {
      const account = await seedAccount();
      const issued = await tokens.issue(account.id, "password_reset", null);
      if (!issued) throw new Error("jeton non émis");

      const reply = fakeReply();
      await controller.changePassword(
        { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
        signedIn(account),
        reply as never,
      );
      expect(reply.statusCode).toBe(200);

      // Le lien parti avant le changement ne doit pas rouvrir le compte : on
      // change son mot de passe parce qu'on le croit connu d'un autre, et ce
      // lien dort peut-être dans une boîte que cet autre lit aussi.
      expect(await tokens.consume(issued.token, "password_reset")).toBeNull();
    });
  });

  describe("indicateur « double authentification requise »", () => {
    it("couvre le revendeur, que le garde du personnel retient aussi", async () => {
      settings["security.staffRequires2fa"] = true;

      // L'espace revendeur passe par `StaffTwoFactorGuard` : un indicateur
      // faux laissait l'écran muet devant un refus qu'il devait annoncer.
      const reseller = await seedAccount("reseller");
      expect((await controller.twoFactorStatus(signedIn(reseller))).data.required).toBe(true);

      const admin = await seedAccount("admin");
      expect((await controller.twoFactorStatus(signedIn(admin))).data.required).toBe(true);

      const client = await seedAccount("user");
      expect((await controller.twoFactorStatus(signedIn(client))).data.required).toBe(false);
    });
  });

  describe("avis au titulaire d'un changement d'authentifiant", () => {
    it("prévient d'un mot de passe changé, par courriel et par la cloche", async () => {
      const account = await seedAccount();
      const reply = fakeReply();
      await controller.changePassword(
        { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
        signedIn(account, "198.51.100.23"),
        reply as never,
      );
      expect(reply.statusCode).toBe(200);
      await alerts.settled();

      const [sent] = mailsTo(account.email);
      expect(sent?.subject).toBe("Mot de passe modifié sur votre compte GameDashboard");
      expect(sent?.text).toContain("198.51.100.23");
      expect(sent?.text).toContain("https://gamedashboard.local/account/security");
      expect(await bellOf(account.id)).toEqual(["Mot de passe modifié"]);
    });

    it("prévient d'une réinitialisation aboutie", async () => {
      const account = await seedAccount();
      const issued = await tokens.issue(account.id, "password_reset", null);
      if (!issued) throw new Error("jeton non émis");

      const reply = fakeReply();
      await controller.resetPassword(
        { token: issued.token, password: NEW_PASSWORD },
        { ip: "198.51.100.23", headers: {} } as never,
        reply as never,
      );
      expect(reply.statusCode).toBe(200);
      await alerts.settled();

      expect(mailsTo(account.email).map((sent) => sent.subject)).toEqual([
        "Mot de passe réinitialisé sur votre compte GameDashboard",
      ]);
    });

    it("prévient de l'activation puis de la désactivation du second facteur", async () => {
      const account = await seedAccount();
      const secret = await twoFactor.beginSetup(account.id);

      const enabled = fakeReply();
      await controller.twoFactorEnable(
        { code: totpCodeAt(secret, totpStep()) },
        signedIn(account),
        enabled as never,
      );
      expect(enabled.statusCode).toBe(200);

      const disabled = fakeReply();
      await controller.twoFactorDisable(
        { password: PASSWORD },
        signedIn(account),
        disabled as never,
      );
      expect(disabled.statusCode).toBe(204);
      await alerts.settled();

      expect(mailsTo(account.email).map((sent) => sent.subject)).toEqual([
        "Double authentification activée sur votre compte GameDashboard",
        "Double authentification désactivée sur votre compte GameDashboard",
      ]);
    });

    it("prévient de l'ajout puis du retrait d'une clé d'accès", async () => {
      const account = await seedAccount();

      const added = fakeReply();
      await controller.registerPasskey(
        {
          challenge: issueChallenge("passkey-register", account.id, { webauthn: "défi" }),
          label: "Clé USB",
          response: {},
        },
        signedIn(account),
        added as never,
      );
      expect(added.statusCode).toBe(201);

      const [key] = await db
        .insert(userPasskeys)
        .values({ userId: account.id, credentialId: "cle-1", publicKey: "x", label: "Clé USB" })
        .returning({ id: userPasskeys.id });
      if (!key) throw new Error("clé non posée");
      const removed = fakeReply();
      await controller.removePasskey(
        key.id,
        { password: PASSWORD },
        signedIn(account),
        removed as never,
      );
      expect(removed.statusCode).toBe(204);
      await alerts.settled();

      expect(mailsTo(account.email).map((sent) => sent.subject)).toEqual([
        "Clé d'accès ajoutée sur votre compte GameDashboard",
        "Clé d'accès supprimée sur votre compte GameDashboard",
      ]);
    });

    it("n'échoue pas quand le courrier tombe en panne, et laisse la cloche", async () => {
      const account = await seedAccount();
      mail.send.mockRejectedValue(new Error("535 authentification refusée"));

      const reply = fakeReply();
      await controller.changePassword(
        { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
        signedIn(account),
        reply as never,
      );
      expect(reply.statusCode).toBe(200);
      await alerts.settled();

      expect(mail.send).toHaveBeenCalledTimes(1);
      expect(await bellOf(account.id)).toEqual(["Mot de passe modifié"]);
    });
  });

  describe("ré-authentification avant d'enrôler une preuve ou de créer une clé", () => {
    /** Rejoue une route avec trois corps : sans mot de passe, faux, juste. */
    async function threeTries(
      call: (body: Record<string, unknown>, reply: ReturnType<typeof fakeReply>) => Promise<void>,
      body: Record<string, unknown> = {},
    ): Promise<number[]> {
      const statuses: number[] = [];
      for (const password of [undefined, "pas-le-bon", PASSWORD]) {
        const reply = fakeReply();
        await call(password === undefined ? body : { ...body, password }, reply);
        statuses.push(reply.statusCode);
      }
      return statuses;
    }

    it("ne prépare un secret TOTP que contre le mot de passe", async () => {
      // Une session volée enrôlait son propre TOTP : le titulaire, lui, se
      // retrouvait devant un code qu'il n'a jamais eu.
      const account = await seedAccount();
      const statuses = await threeTries((body, reply) =>
        controller.twoFactorSetup(body, signedIn(account), reply as never),
      );
      expect(statuses).toEqual([422, 403, 201]);
    });

    it("ne rend les options d'une clé d'accès que contre le mot de passe", async () => {
      const account = await seedAccount();
      const statuses = await threeTries((body, reply) =>
        controller.passkeyRegistrationOptions(body, signedIn(account), reply as never),
      );
      expect(statuses).toEqual([422, 403, 200]);
    });

    it("n'ajoute une clé SSH que contre le mot de passe", async () => {
      const account = await seedAccount();
      const statuses = await threeTries(
        (body, reply) => controller.addSshKey(body, signedIn(account), reply as never),
        { name: "portable", publicKey: "ssh-ed25519 AAAA vous@machine" },
      );
      expect(statuses).toEqual([422, 403, 201]);
      expect(sshKeys.add).toHaveBeenCalledTimes(1);
    });

    it("ne crée une clé d'API que contre le mot de passe", async () => {
      // Une clé d'API survit à la session qui l'a créée : c'est le moyen le
      // plus simple de transformer une session volée en accès sans fin.
      const account = await seedAccount();
      const body = { name: "bot", scopes: ["power.start"] };
      const request = { ...(signedIn(account) as object), scopes: null } as never;
      const header = vi.fn();

      const statuses: number[] = [];
      for (const password of [undefined, "pas-le-bon", PASSWORD]) {
        try {
          await account_.create(request, password ? { ...body, password } : body, {
            header,
          } as never);
          statuses.push(200);
        } catch (error) {
          statuses.push(error instanceof HttpException ? error.getStatus() : 500);
        }
      }
      expect(statuses).toEqual([422, 403, 200]);
      expect(apiKeys.create).toHaveBeenCalledTimes(1);
    });

    it("laisse enrôler un compte sans mot de passe local, qui n'a rien à redonner", async () => {
      // Client venu de la facturation : il n'a jamais eu de mot de passe ici.
      // Le lui demander lui fermerait la double authentification et le SFTP
      // par clé, sans rien protéger de plus.
      const account = await seedAccount("user", null);
      const reply = fakeReply();
      await controller.twoFactorSetup({}, signedIn(account), reply as never);
      expect(reply.statusCode).toBe(201);

      // L'écran l'apprend de l'état du second facteur, et ne lui présente pas
      // de champ qu'il ne saurait remplir.
      expect((await controller.twoFactorStatus(signedIn(account))).data.localPassword).toBe(false);
      const other = await seedAccount();
      expect((await controller.twoFactorStatus(signedIn(other))).data.localPassword).toBe(true);
    });
  });

  describe("mot de passe provisoire des scripts d'exploitation", () => {
    async function withExpiry(expiresAt: Date): Promise<Account> {
      const account = await seedAccount("admin");
      await db
        .update(users)
        .set({ passwordExpiresAt: expiresAt.toISOString() })
        .where(eq(users.id, account.id));
      return account;
    }

    it("refuse un mot de passe provisoire expiré, sans ouvrir de session", async () => {
      // Un secret tiré au sort par `create-admin` ou `reset-password`, affiché
      // une fois dans un terminal, ne doit pas devenir le mot de passe durable.
      const account = await withExpiry(new Date(Date.now() - 60_000));
      const reply = await login(account.email, PASSWORD);

      expect(reply.statusCode).toBe(403);
      expect(reply.cookies.size).toBe(0);
      expect(reply.body).toMatchObject({ passwordExpired: true });
    });

    it("ouvre la session d'un mot de passe provisoire encore valable, et demande de le changer", async () => {
      const account = await withExpiry(new Date(Date.now() + 3600_000));
      const reply = await login(account.email, PASSWORD);

      expect(reply.statusCode).toBe(200);
      expect(reply.cookies.size).toBe(1);
      expect(reply.body).toMatchObject({ passwordChangeRequired: true });
    });

    it("le demande aussi après le second facteur", async () => {
      const account = await withExpiry(new Date(Date.now() + 3600_000));
      const secret = await enableTotp(account);
      const step = await login(account.email, PASSWORD);
      const reply = await secondFactor(
        (step.body as { challenge: string }).challenge,
        totpCodeAt(secret, totpStep()),
        "203.0.113.7",
      );

      expect(reply.statusCode).toBe(200);
      expect(reply.body).toMatchObject({ passwordChangeRequired: true });
    });

    it("lève l'échéance quand le titulaire choisit son mot de passe", async () => {
      const account = await withExpiry(new Date(Date.now() + 3600_000));
      const changed = fakeReply();
      await controller.changePassword(
        { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
        signedIn(account),
        changed as never,
      );
      expect(changed.statusCode).toBe(200);

      const [row] = await db
        .select({ passwordExpiresAt: users.passwordExpiresAt })
        .from(users)
        .where(eq(users.id, account.id));
      expect(row?.passwordExpiresAt).toBeNull();
      expect((await login(account.email, NEW_PASSWORD)).body).not.toHaveProperty(
        "passwordChangeRequired",
      );
    });

    it("ne demande rien à un mot de passe ordinaire", async () => {
      const account = await seedAccount();
      expect((await login(account.email, PASSWORD)).body).not.toHaveProperty(
        "passwordChangeRequired",
      );
    });
  });

  describe("verrou par compte", () => {
    const HOME = "203.0.113.7";
    const OUTSIDER = "198.51.100.66";

    it("n'enferme pas dehors une adresse d'où le titulaire est déjà entré", async () => {
      const account = await seedAccount();
      const lastWeek = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
      await db
        .insert(loginAttempts)
        .values({ email: account.email, ip: HOME, success: true, at: lastWeek });

      // Un tiers épuise le verrou du compte depuis ailleurs.
      await seedFailures(account.email, OUTSIDER, 10);

      expect((await login(account.email, PASSWORD, OUTSIDER)).statusCode).toBe(429);
      expect((await login(account.email, PASSWORD, "192.0.2.10")).statusCode).toBe(429);

      // Le titulaire, lui, entre de chez lui : c'était tout l'objet du verrou.
      const reply = await login(account.email, PASSWORD, HOME);
      expect(reply.statusCode).toBe(200);
      expect(reply.cookies.size).toBe(1);
    });

    it("ne tient pour connue qu'une adresse passée par toutes les preuves", async () => {
      const account = await seedAccount();
      await enableTotp(account);

      // Le mot de passe seul ne compte pas comme une connexion réussie : sinon,
      // qui le connaît déjà se ferait exempter du verrou en le tapant une fois,
      // puis essaierait les codes à six chiffres sans limite de compte.
      const first = await login(account.email, PASSWORD, OUTSIDER);
      const { challenge } = first.body as { challenge: string };
      expect(challenge).toBeTruthy();
      expect(await successesFrom(account.email, OUTSIDER)).toBe(0);

      await seedFailures(account.email, "192.0.2.10", 10);
      expect((await secondFactor(challenge, "000000", OUTSIDER)).statusCode).toBe(429);

      // Le second facteur accepté, lui, fait de l'adresse une adresse connue.
      const other = await seedAccount();
      const otherSecret = await enableTotp(other);
      const step = await login(other.email, PASSWORD, HOME);
      const accepted = await secondFactor(
        (step.body as { challenge: string }).challenge,
        totpCodeAt(otherSecret, totpStep()),
        HOME,
      );
      expect(accepted.statusCode).toBe(200);
      expect(await successesFrom(other.email, HOME)).toBe(1);
    });
  });

  describe("journal d'audit des échecs", () => {
    it("consigne l'échec sur le compte visé, sans le secret essayé", async () => {
      const account = await seedAccount();
      const reply = await login(account.email, "pas-le-bon-mot-de-passe", "198.51.100.4");
      expect(reply.statusCode).toBe(401);
      await alerts.settled();

      const rows = (await journal()).filter((row) => row.event === "account.login_failed");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorId: account.id,
        actorLabel: account.email,
        ip: "198.51.100.4",
        properties: { stage: "password" },
      });
      expect(JSON.stringify(rows)).not.toContain("pas-le-bon-mot-de-passe");
    });

    it("ne consigne rien pour une adresse inconnue : l'identifiant saisi peut être un secret", async () => {
      // Un mot de passe tapé dans le champ de l'adresse est une erreur
      // ordinaire ; le journal, lu par tout le personnel, ne doit pas le garder.
      await login("cheval-agrafe@inconnu.test", "faux");
      await alerts.settled();
      expect(await journal()).toEqual([]);
    });

    it("consigne le verrouillage une fois, au franchissement du seuil", async () => {
      const account = await seedAccount();
      await seedFailures(account.email, "198.51.100.4", 9);

      expect((await login(account.email, "faux", "198.51.100.4")).statusCode).toBe(401);
      await alerts.settled();
      // Verrouillé : la tentative suivante n'est ni vérifiée ni comptée.
      expect((await login(account.email, "faux", "198.51.100.4")).statusCode).toBe(429);
      await alerts.settled();

      const locked = (await journal()).filter((row) => row.event === "account.locked");
      expect(locked).toHaveLength(1);
      expect(locked[0]).toMatchObject({
        actorId: account.id,
        ip: "198.51.100.4",
        properties: { failures: 10 },
      });
    }, 30_000);
  });
});

// Vitest n'affiche pas la raison d'un `skipIf` : on la dit une fois.
if (!HAS_DATABASE) console.info(NO_DATABASE_REASON);
