import { hashPassword } from "@gamedashboard/auth";
import { activityLogs, type Database, notifications, users } from "@gamedashboard/db";
import { Logger } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createThrowawayDatabase,
  HAS_DATABASE,
  NO_DATABASE_REASON,
  type ThrowawayDatabase,
} from "../../test/throwaway-database";
import { ActivityService } from "../activity/activity.service";
import type { PlatformSettingsService } from "../admin/platform-settings.service";
import type { MailerService } from "../mail/mailer.service";
import { NotificationPreferencesRepository } from "../notifications/notification-preferences.repository";
import { NotificationsService } from "../notifications/notifications.service";
import { PushOutboxService } from "../push/push-outbox.service";
import type { BrandingService } from "../reseller/branding.service";
import type { ClientWebhookEmitterService } from "../webhooks/client-webhook-emitter.service";
import { AuthController } from "./auth.controller";
import { PasswordConfirmationService } from "./password-confirmation.service";
import { SecurityAlertRepository } from "./security-alert.repository";
import { FAILURE_ALERT, NEW_DEVICE_ALERT, SecurityAlertService } from "./security-alert.service";
import { SessionRepository } from "./session.repository";
import { SessionIssuerService } from "./session-issuer.service";
import { TwoFactorRepository } from "./two-factor.repository";
import { UserRepository } from "./user.repository";

/**
 * Alertes de sécurité (§5.1), de la route de connexion jusqu'au courrier.
 *
 * Contre une vraie base : la décision vit dans des prédicats SQL — échecs
 * « depuis la dernière réussite », sessions « sauf celle-ci », alerte « déjà
 * partie dans la fenêtre » — et une doublure n'éprouverait que son accord
 * avec elle-même. Seuls le transport SMTP, le captcha et la marque sont
 * simulés : ils ne décident de rien ici.
 */

const PASSWORD = "cheval-agrafe-batterie-correcte";
const FIREFOX = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0";
const CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36";

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

interface Origin {
  ip: string;
  userAgent?: string;
  /** En-tête `CF-IPCountry`. */
  country?: string;
  /** Interlocuteur direct de l'API : la boucle locale, sauf mention contraire. */
  peer?: string;
}

describe.skipIf(!HAS_DATABASE)("Alertes de sécurité (intégration)", () => {
  let throwaway: ThrowawayDatabase;
  let db: Database;
  let digest: string;
  let mail: { send: ReturnType<typeof vi.fn>; isConfigured: () => Promise<boolean> };
  let alerts: SecurityAlertService;
  let controller: AuthController;

  beforeAll(async () => {
    Logger.overrideLogger(false);
    throwaway = await createThrowawayDatabase();
    db = throwaway.db;
    digest = await hashPassword(PASSWORD);
  }, 60_000);

  afterAll(async () => {
    await throwaway?.drop();
  });

  beforeEach(async () => {
    await db.execute(sql.raw("truncate table users, login_attempts, activity_logs cascade"));

    mail = { send: vi.fn(async () => true), isConfigured: async () => true };
    const mailer = mail as unknown as MailerService;
    const branding = {
      forHost: async () => ({ name: "GameDashboard", resellerId: null }),
    } as unknown as BrandingService;
    const platform = {
      text: async () => "gamedashboard.local",
    } as unknown as PlatformSettingsService;

    const users = new UserRepository(db);
    const sessions = new SessionRepository(db);
    const activity = new ActivityService(db);
    // Le vrai service de notifications : c'est lui qui décide qu'un type hors
    // catalogue ne part pas par courriel, et donc qu'il n'y a pas de doublon.
    const notificationsService = new NotificationsService(
      db,
      new NotificationPreferencesRepository(db),
      mailer,
      { emit: async () => {} } as unknown as ClientWebhookEmitterService,
      {
        forReseller: async () => ({ branding: { name: "Panel", replyTo: null }, domain: null }),
      } as unknown as BrandingService,
      new PushOutboxService(db),
    );
    alerts = new SecurityAlertService(
      new SecurityAlertRepository(db),
      notificationsService,
      mailer,
      activity,
      branding,
      platform,
    );
    const issuer = new SessionIssuerService(sessions, users, alerts);

    controller = new AuthController(
      users,
      sessions,
      activity,
      new TwoFactorRepository(db),
      {} as never,
      {} as never,
      { configuration: async () => null } as never,
      {} as never,
      issuer,
      {} as never,
      mailer,
      platform,
      {} as never,
      { accepts: async () => true } as never,
      alerts,
      // Le courrier de compte (réinitialisation, vérification) n'est pas en
      // jeu ici : la connexion n'y touche pas.
      {} as never,
      // Les consoles de Wings non plus.
      {} as never,
      {} as never,
      // Le verrou et la trace des échecs, que la connexion emploie.
      new PasswordConfirmationService(users, alerts),
      {
        forHost: async () => ({ name: "GameDashboard", resellerId: null }),
      } as unknown as BrandingService,
    );
  });

  async function seedAccount(locale = "fr"): Promise<{ id: string; email: string }> {
    const email = `titulaire-${Math.random().toString(16).slice(2, 8)}@gamedashboard.test`;
    const [row] = await db
      .insert(users)
      .values({
        email,
        nameFirst: "Alex",
        nameLast: "Titulaire",
        passwordHash: digest,
        locale,
        timezone: "Europe/Paris",
        emailVerifiedAt: new Date().toISOString(),
      })
      .returning({ id: users.id, email: users.email });
    if (!row) throw new Error("compte non créé");
    return row;
  }

  function request(origin: Origin) {
    return {
      ip: origin.ip,
      headers: {
        "user-agent": origin.userAgent ?? FIREFOX,
        ...(origin.country ? { "cf-ipcountry": origin.country } : {}),
      },
      socket: { remoteAddress: origin.peer ?? "127.0.0.1" },
    };
  }

  async function login(email: string, password: string, origin: Origin) {
    const reply = fakeReply();
    await controller.login({ email, password }, request(origin) as never, reply as never);
    return reply;
  }

  async function alertsOf(userId: string, type: string) {
    return await db
      .select({ title: notifications.title, data: notifications.data })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.type, type)));
  }

  const HOME: Origin = { ip: "203.0.113.7", userAgent: FIREFOX };

  describe("cinquième échec", () => {
    it("rien à quatre, une alerte à cinq, pas de seconde à six", async () => {
      const account = await seedAccount();

      for (let attempt = 1; attempt <= 4; attempt++) {
        expect((await login(account.email, "faux", HOME)).statusCode).toBe(401);
      }
      await alerts.settled();
      expect(mail.send).not.toHaveBeenCalled();
      expect(await alertsOf(account.id, FAILURE_ALERT)).toHaveLength(0);

      expect((await login(account.email, "faux", HOME)).statusCode).toBe(401);
      await alerts.settled();
      expect(mail.send).toHaveBeenCalledTimes(1);
      const sent = mail.send.mock.calls[0]?.[0] as { to: string; subject: string; text: string };
      expect(sent.to).toBe(account.email);
      expect(sent.subject).toContain("Tentatives de connexion échouées");
      expect(sent.text).toContain("5 tentatives");
      expect(sent.text).toContain("203.0.113.7");
      expect(sent.text).toContain("https://gamedashboard.local/account/security");
      const bell = await alertsOf(account.id, FAILURE_ALERT);
      expect(bell).toHaveLength(1);
      expect((bell[0]?.data as { href?: string } | undefined)?.href).toBe("/account/security");

      expect((await login(account.email, "faux", HOME)).statusCode).toBe(401);
      await alerts.settled();
      expect(mail.send).toHaveBeenCalledTimes(1);
      expect(await alertsOf(account.id, FAILURE_ALERT)).toHaveLength(1);
    }, 30_000);

    it("ne compte que les échecs qui suivent la dernière réussite", async () => {
      const account = await seedAccount();
      for (let attempt = 1; attempt <= 3; attempt++) await login(account.email, "faux", HOME);
      expect((await login(account.email, PASSWORD, HOME)).statusCode).toBe(200);
      for (let attempt = 1; attempt <= 3; attempt++) await login(account.email, "faux", HOME);
      await alerts.settled();

      expect(await alertsOf(account.id, FAILURE_ALERT)).toHaveLength(0);
    }, 30_000);

    it("n'alerte personne pour une adresse inconnue, et répond exactement pareil", async () => {
      const account = await seedAccount();
      const known = await login(account.email, "faux", { ip: "198.51.100.1" });
      const unknown = await login("personne@gamedashboard.test", "faux", { ip: "198.51.100.2" });

      expect(unknown.statusCode).toBe(known.statusCode);
      expect(unknown.body).toEqual(known.body);

      for (let attempt = 2; attempt <= 6; attempt++) {
        await login("personne@gamedashboard.test", "faux", { ip: "198.51.100.2" });
      }
      await alerts.settled();
      expect(mail.send).not.toHaveBeenCalled();
      expect(await db.select().from(notifications)).toHaveLength(0);
    }, 30_000);
  });

  describe("nouvel appareil", () => {
    it("se tait à la première connexion, puis sur un appareil connu", async () => {
      const account = await seedAccount();

      expect((await login(account.email, PASSWORD, HOME)).statusCode).toBe(200);
      await alerts.settled();
      expect(mail.send).not.toHaveBeenCalled();

      // Même navigateur, même /24, autre adresse : c'est toujours la maison.
      expect(
        (await login(account.email, PASSWORD, { ...HOME, ip: "203.0.113.42" })).statusCode,
      ).toBe(200);
      await alerts.settled();
      expect(mail.send).not.toHaveBeenCalled();
      expect(await alertsOf(account.id, NEW_DEVICE_ALERT)).toHaveLength(0);
    });

    it("prévient par courriel et par la cloche d'un appareil inconnu", async () => {
      const account = await seedAccount();
      await login(account.email, PASSWORD, HOME);
      await alerts.settled();

      const reply = await login(account.email, PASSWORD, {
        ip: "198.51.100.9",
        userAgent: CHROME_ANDROID,
      });
      expect(reply.statusCode).toBe(200);
      await alerts.settled();

      expect(mail.send).toHaveBeenCalledTimes(1);
      const sent = mail.send.mock.calls[0]?.[0] as { subject: string; text: string };
      expect(sent.subject).toBe("Nouvelle connexion à votre compte GameDashboard");
      expect(sent.text).toContain("Chrome sur Android");
      expect(sent.text).toContain("198.51.100.9");
      expect(sent.text).toContain("https://gamedashboard.local/account/security");
      // Sans en-tête de pays, aucune ligne de pays : on ne prétend pas savoir.
      expect(sent.text).not.toContain("Pays");

      const bell = await alertsOf(account.id, NEW_DEVICE_ALERT);
      expect(bell).toHaveLength(1);
      expect((bell[0]?.data as { href?: string } | undefined)?.href).toBe("/account/security");
    });

    it("écrit dans la langue du compte", async () => {
      const account = await seedAccount("en");
      await login(account.email, PASSWORD, HOME);
      await login(account.email, PASSWORD, { ip: "198.51.100.9", userAgent: CHROME_ANDROID });
      await alerts.settled();

      const sent = mail.send.mock.calls[0]?.[0] as { subject: string; text: string };
      expect(sent.subject).toBe("New sign-in to your GameDashboard account");
      expect(sent.text).toContain("Chrome on Android");
    });

    it("lit le pays derrière un intermédiaire de confiance, et traite un nouveau pays comme nouveau", async () => {
      const account = await seedAccount();
      await login(account.email, PASSWORD, { ...HOME, country: "FR" });
      await alerts.settled();

      await login(account.email, PASSWORD, { ...HOME, country: "DE" });
      await alerts.settled();

      expect(mail.send).toHaveBeenCalledTimes(1);
      const sent = mail.send.mock.calls[0]?.[0] as { text: string };
      expect(sent.text).toContain("Pays : Allemagne");

      const countries = await db
        .select({ country: sql<string>`${activityLogs.properties}->>'country'` })
        .from(activityLogs)
        .where(and(eq(activityLogs.actorId, account.id), eq(activityLogs.event, "account.login")));
      expect(countries.map((row) => row.country)).toEqual(["FR", "DE"]);
    });

    it("ignore l'en-tête de pays quand l'API n'est pas jointe par un intermédiaire de confiance", async () => {
      const account = await seedAccount();
      await login(account.email, PASSWORD, { ...HOME, country: "FR" });
      await alerts.settled();

      // Jointe en direct, l'API reçoit le pays que l'appelant a choisi.
      await login(account.email, PASSWORD, {
        ip: "198.51.100.9",
        userAgent: CHROME_ANDROID,
        country: "DE",
        peer: "198.51.100.9",
      });
      await alerts.settled();

      const sent = mail.send.mock.calls[0]?.[0] as { text: string };
      expect(sent.text).not.toContain("Pays");
      expect(sent.text).not.toContain("Allemagne");
    });
  });

  describe("panne de courrier", () => {
    it("n'empêche ni ne retarde la connexion", async () => {
      const account = await seedAccount();
      await login(account.email, PASSWORD, HOME);
      await alerts.settled();

      // Un serveur SMTP qui ne répond pas : la connexion ne doit pas l'attendre.
      let liberer: (() => void) | undefined;
      mail.send.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            liberer = resolve;
          }),
      );
      const started = Date.now();
      const reply = await login(account.email, PASSWORD, {
        ip: "198.51.100.9",
        userAgent: CHROME_ANDROID,
      });
      expect(reply.statusCode).toBe(200);
      expect(reply.cookies.size).toBe(1);
      expect(Date.now() - started).toBeLessThan(5_000);

      /*
       * L'envoi est libéré, puis attendu, **avant** de rendre la main.
       *
       * Un envoi laissé pendant pour toujours gardait sa tâche en vol : elle
       * écrivait encore en base pendant que le test suivant vidait les tables,
       * et le `truncate` finissait une fois sur trois en interblocage.
       */
      /*
       * L'envoi est libéré **une fois parti**. L'alerte le lance après la
       * réponse, puisque la connexion ne l'attend pas : libérer aussitôt ne
       * libérait rien — l'envoi, parti ensuite, pendait pour toujours, et
       * `settled()` avec lui. Le test dépassait son délai une fois sur deux,
       * sans rien dire de la connexion, qui avait répondu en quelques
       * dizaines de millisecondes.
       */
      await vi.waitFor(() => expect(liberer).toBeDefined());
      liberer?.();
      await alerts.settled();
    });

    it("un envoi qui échoue n'abat rien et laisse la cloche", async () => {
      const account = await seedAccount();
      await login(account.email, PASSWORD, HOME);
      await alerts.settled();

      mail.send.mockRejectedValue(new Error("535 authentification refusée"));
      const reply = await login(account.email, PASSWORD, {
        ip: "198.51.100.9",
        userAgent: CHROME_ANDROID,
      });
      expect(reply.statusCode).toBe(200);
      await alerts.settled();

      expect(mail.send).toHaveBeenCalledTimes(1);
      expect(await alertsOf(account.id, NEW_DEVICE_ALERT)).toHaveLength(1);
    });
  });
});

// Vitest n'affiche pas la raison d'un `skipIf` : on la dit une fois.
if (!HAS_DATABASE) console.info(NO_DATABASE_REASON);
