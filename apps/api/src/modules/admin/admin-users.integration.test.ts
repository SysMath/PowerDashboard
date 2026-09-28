import { randomBytes } from "node:crypto";
import { generateApiKey, hashPassword } from "@gamedashboard/auth";
import {
  apiKeys,
  applicationKeys,
  authTokens,
  type Database,
  notifications,
  servers,
  sessions,
  users,
} from "@gamedashboard/db";
import { ConflictException, ForbiddenException, ServiceUnavailableException } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { seedLocation, seedNode, seedServer } from "../../test/fixtures";
import { sousDomainesInertes } from "../../test/sous-domaines";
import {
  createThrowawayDatabase,
  HAS_DATABASE,
  type ThrowawayDatabase,
} from "../../test/throwaway-database";
import { ActivityService } from "../activity/activity.service";
import { ApplicationKeyRepository } from "../application/application-key.repository";
import { AccountMailService } from "../auth/account-mail.service";
import { ApiKeyRepository } from "../auth/api-key.repository";
import { AuthTokenRepository } from "../auth/auth-token.repository";
import { BillingSsoService } from "../auth/billing-sso.service";
import { SecurityAlertRepository } from "../auth/security-alert.repository";
import { CREDENTIAL_CHANGE_ALERT, SecurityAlertService } from "../auth/security-alert.service";
import { SessionRepository } from "../auth/session.repository";
import { SessionIssuerService } from "../auth/session-issuer.service";
import { SshKeyRepository } from "../auth/ssh-key.repository";
import { UserRepository } from "../auth/user.repository";
import type { MailerService } from "../mail/mailer.service";
import { NotificationPreferencesRepository } from "../notifications/notification-preferences.repository";
import { NotificationsService } from "../notifications/notifications.service";
import { SftpAuthService } from "../remote/sftp-auth.service";
import type { BrandingService } from "../reseller/branding.service";
import type { S3Service } from "../storage/s3.service";
import type { ClientWebhookEmitterService } from "../webhooks/client-webhook-emitter.service";
import type { WebhookEmitterService } from "../webhooks/webhook-emitter.service";
import type { WingsClientService } from "../wings/wings-client.service";
import { WingsTokenService } from "../wings/wings-token.service";
import { AdminActionsService } from "./admin-actions.service";
import { AdminUsersService } from "./admin-users.service";
import type { PlatformSettingsService } from "./platform-settings.service";

/**
 * Suspension et modification d'un compte, contre une vraie base.
 *
 * **La suspension doit fermer chaque porte.** Ce fichier les essaie toutes,
 * une par une, avec la vraie logique de chacune : ouverture de session (quel
 * que soit le chemin), session déjà ouverte, clé d'API personnelle, clé de
 * boutique d'un revendeur, SFTP, lien de connexion de la facturation, prise
 * en main par le support, lien de réinitialisation déjà envoyé. Un contrôle
 * oublié sur une seule d'entre elles suffit à rendre la suspension décorative.
 */
describe.skipIf(!HAS_DATABASE)("suspension et modification d'un compte (intégration)", () => {
  let throwaway: ThrowawayDatabase;
  let db: Database;
  let sessionsRepo: SessionRepository;
  let tokens: AuthTokenRepository;
  let accounts: AdminUsersService;
  let alerts: SecurityAlertService;
  let issuer: SessionIssuerService;
  const wings = { denyWebsocketTokens: vi.fn(async () => undefined) };
  const mailer = { isConfigured: vi.fn(async () => true), send: vi.fn(async () => true) };
  const noCookie = { setCookie: () => undefined };
  const origin = { ip: "203.0.113.7", userAgent: "vitest" };

  beforeAll(async () => {
    throwaway = await createThrowawayDatabase();
    db = throwaway.db;
    sessionsRepo = new SessionRepository(db);
    tokens = new AuthTokenRepository(db);
    const accountMail = new AccountMailService(
      tokens,
      mailer as unknown as MailerService,
      { text: async () => "panel.test" } as unknown as PlatformSettingsService,
      { forHost: async () => ({ name: "Panel", resellerId: null }) } as unknown as BrandingService,
    );
    const platform = { text: async () => "panel.test" } as unknown as PlatformSettingsService;
    const branding = {
      forHost: async () => ({ name: "Panel", resellerId: null }),
    } as unknown as BrandingService;
    alerts = new SecurityAlertService(
      new SecurityAlertRepository(db),
      new NotificationsService(
        db,
        new NotificationPreferencesRepository(db),
        mailer as unknown as MailerService,
        { emit: async () => {} } as unknown as ClientWebhookEmitterService,
        {
          forReseller: async () => ({ branding: { name: "Panel", replyTo: null }, domain: null }),
        } as unknown as BrandingService,
      ),
      mailer as unknown as MailerService,
      new ActivityService(db),
      branding,
      platform,
    );
    accounts = new AdminUsersService(
      db,
      sessionsRepo,
      tokens,
      accountMail,
      new WingsTokenService(db),
      wings as unknown as WingsClientService,
      alerts,
    );
    // Les alertes de connexion ont leur propre test : ici, seule compte la
    // porte refermée sur un compte suspendu.
    issuer = new SessionIssuerService(sessionsRepo, new UserRepository(db), {
      afterSignIn: () => undefined,
    } as never);
  }, 60_000);

  // L'avis d'un changement d'adresse part en tâche détachée : il ne doit pas
  // écrire pendant le `truncate` du test suivant.
  afterEach(async () => {
    await alerts.settled();
  });

  afterAll(async () => {
    await throwaway?.drop();
  });

  beforeEach(async () => {
    await db.execute(
      sql.raw(
        "truncate table servers, allocations, eggs, nests, nodes, locations, users, application_keys cascade",
      ),
    );
    mailer.isConfigured.mockResolvedValue(true);
    mailer.send.mockClear();
  });

  async function account(
    input: { role?: "admin" | "support" | "user" | "reseller"; password?: string } = {},
  ) {
    const [row] = await db
      .insert(users)
      .values({
        email: `compte-${randomBytes(4).toString("hex")}@gamedashboard.test`,
        nameFirst: "Camille",
        nameLast: "Martin",
        role: input.role ?? "user",
        passwordHash: input.password ? await hashPassword(input.password) : null,
        emailVerifiedAt: new Date().toISOString(),
      })
      .returning({ id: users.id, email: users.email });
    if (!row) throw new Error("compte non créé");
    return row;
  }

  const suspend = (actorId: string, userId: string) =>
    accounts.setSuspended(actorId, userId, { suspended: true, reason: "Impayé" });
  const reactivate = (actorId: string, userId: string) =>
    accounts.setSuspended(actorId, userId, { suspended: false });

  /* --- Protections -------------------------------------------------------- */

  it("refuse qu'un administrateur suspende son propre compte", async () => {
    const admin = await account({ role: "admin" });
    await expect(suspend(admin.id, admin.id)).rejects.toBeInstanceOf(ConflictException);
  });

  it("refuse de suspendre le dernier administrateur actif", async () => {
    const admin = await account({ role: "admin" });
    const other = await account({ role: "admin" });
    await suspend(admin.id, other.id);

    // Plus qu'un administrateur actif : le suspendre ne laisserait personne.
    await expect(suspend(other.id, admin.id)).rejects.toThrow(/dernier administrateur/);
    const [row] = await db.select().from(users).where(eq(users.id, admin.id));
    expect(row?.suspendedAt).toBeNull();
  });

  it("ne laisse pas deux administrateurs se suspendre l'un l'autre en même temps", async () => {
    // Sans verrou, chacun passerait le décompte « il en reste un autre » et la
    // plateforme finirait sans personne pour réactiver qui que ce soit.
    const a = await account({ role: "admin" });
    const b = await account({ role: "admin" });

    const results = await Promise.allSettled([suspend(a.id, b.id), suspend(b.id, a.id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    const [active] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(users)
      .where(sql`${users.role} = 'admin' and ${users.suspendedAt} is null`);
    expect(active?.n).toBe(1);
  });

  it("garde le début de la suspension quand on en change le motif", async () => {
    const admin = await account({ role: "admin" });
    const client = await account();
    await suspend(admin.id, client.id);
    const [before] = await db.select().from(users).where(eq(users.id, client.id));

    await accounts.setSuspended(admin.id, client.id, { suspended: true, reason: "Fraude" });
    const [after] = await db.select().from(users).where(eq(users.id, client.id));
    expect(after?.suspendedAt).toBe(before?.suspendedAt);
    expect(after?.suspensionReason).toBe("Fraude");
  });

  /* --- Chaque porte ------------------------------------------------------- */

  it("révoque les sessions ouvertes, et refuse une session vivante de toute façon", async () => {
    const admin = await account({ role: "admin" });
    const client = await account();
    const token = await sessionsRepo.create(client.id, { authMethod: "password" });
    expect(await sessionsRepo.resolve(token)).not.toBeNull();

    const outcome = await suspend(admin.id, client.id);
    expect(outcome.revokedSessions).toBe(1);
    expect(await sessionsRepo.resolve(token)).toBeNull();

    // Seconde ceinture : une session créée malgré tout — par un chemin qu'on
    // n'aurait pas prévu — ne passe pas davantage.
    const sneaked = await sessionsRepo.create(client.id, { authMethod: "password" });
    expect(await sessionsRepo.resolve(sneaked)).toBeNull();
  });

  it.each(["password", "passkey", "sso", "billing_sso", "invitation"])(
    "n'ouvre aucune session par le chemin « %s »",
    async (method) => {
      const admin = await account({ role: "admin" });
      const client = await account();
      await suspend(admin.id, client.id);

      await expect(issuer.issue(client.id, origin, noCookie, method)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      const opened = await db.select().from(sessions).where(eq(sessions.userId, client.id));
      expect(opened).toHaveLength(0);
    },
  );

  it("rouvre toutes les portes à la réactivation", async () => {
    const admin = await account({ role: "admin" });
    const client = await account();
    await suspend(admin.id, client.id);
    await reactivate(admin.id, client.id);

    const { user } = await issuer.issue(client.id, origin, noCookie, "password");
    expect(user).toMatchObject({ id: client.id });
    const [row] = await db.select().from(users).where(eq(users.id, client.id));
    expect(row?.suspensionReason).toBeNull();
  });

  it("refuse les clés d'API du compte, sans les révoquer", async () => {
    const admin = await account({ role: "admin" });
    const client = await account();
    const key = generateApiKey();
    await db.insert(apiKeys).values({
      userId: client.id,
      name: "Script",
      prefix: key.prefix,
      keyHash: key.hash,
      scopes: ["servers.read"],
    });
    const repo = new ApiKeyRepository(db);
    expect(await repo.resolve(key.plaintext, undefined)).not.toBeNull();

    await suspend(admin.id, client.id);
    expect(await repo.resolve(key.plaintext, undefined)).toBeNull();

    await reactivate(admin.id, client.id);
    expect(await repo.resolve(key.plaintext, undefined)).not.toBeNull();
  });

  it("refuse les clés de boutique d'un revendeur suspendu", async () => {
    const admin = await account({ role: "admin" });
    const reseller = await account({ role: "reseller" });
    const key = generateApiKey();
    await db.insert(applicationKeys).values({
      name: "Boutique",
      prefix: key.prefix,
      keyHash: key.hash,
      scopes: ["servers.read"],
      resellerId: reseller.id,
    });
    const platformKey = generateApiKey();
    await db.insert(applicationKeys).values({
      name: "Plateforme",
      prefix: platformKey.prefix,
      keyHash: platformKey.hash,
      scopes: ["servers.read"],
    });
    const repo = new ApplicationKeyRepository(db);

    await suspend(admin.id, reseller.id);
    expect(await repo.resolve(key.plaintext, undefined)).toBeNull();
    // Une clé de la plateforme, sans revendeur, n'est pas concernée.
    expect(await repo.resolve(platformKey.plaintext, undefined)).not.toBeNull();
  });

  it("refuse le SFTP, même avec le bon mot de passe", async () => {
    const admin = await account({ role: "admin" });
    const client = await account({ password: "phrase-de-passe-solide-42" });
    const nodeId = await seedNode(db, { locationId: await seedLocation(db) });
    const serverId = await seedServer(db, { nodeId, ownerId: client.id });
    const [server] = await db
      .select({ shortId: servers.uuidShort })
      .from(servers)
      .where(eq(servers.id, serverId));
    const sftp = new SftpAuthService(db, new SshKeyRepository(db));
    const attempt = () =>
      sftp.authenticate(nodeId, {
        type: "password",
        username: `${client.email}.${server?.shortId}`,
        password: "phrase-de-passe-solide-42",
        ip: `198.51.100.${Math.floor(Math.random() * 200)}`,
      });

    expect(await attempt()).not.toBeNull();
    await suspend(admin.id, client.id);
    expect(await attempt()).toBeNull();
  });

  it("n'émet pas de lien de connexion de facturation", async () => {
    const admin = await account({ role: "admin" });
    const client = await account();
    await suspend(admin.id, client.id);

    const billing = new BillingSsoService(db, tokens, {
      text: async () => "panel.test",
    } as unknown as PlatformSettingsService);
    await expect(billing.issue({ userId: client.id })).rejects.toThrow(/suspendu/);
  });

  it("refuse la prise en main d'un compte suspendu", async () => {
    const admin = await account({ role: "admin" });
    const client = await account();
    await suspend(admin.id, client.id);

    const actions = new AdminActionsService(
      db,
      wings as unknown as WingsClientService,
      sessionsRepo,
      { emit: async () => undefined } as unknown as WebhookEmitterService,
      new WingsTokenService(db),
      {} as S3Service,
      sousDomainesInertes(),
    );
    await expect(actions.impersonationTarget(admin.id, client.id)).rejects.toThrow(/suspendu/);
  });

  it("refuse la prise en main d'un revendeur", async () => {
    // NC-06 : l'agent agissait sous le nom du revendeur — consentement de
    // provisionnement, clés, suppression de serveurs —, imputé au revendeur.
    const admin = await account({ role: "admin" });
    const reseller = await account({ role: "reseller" });

    const actions = new AdminActionsService(
      db,
      wings as unknown as WingsClientService,
      sessionsRepo,
      { emit: async () => undefined } as unknown as WebhookEmitterService,
      new WingsTokenService(db),
      {} as S3Service,
      sousDomainesInertes(),
    );
    await expect(actions.impersonationTarget(admin.id, reseller.id)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("éteint les liens de réinitialisation déjà envoyés", async () => {
    const admin = await account({ role: "admin" });
    const client = await account({ password: "phrase-de-passe-solide-42" });
    const issued = await tokens.issue(client.id, "password_reset", null);
    if (!issued) throw new Error("jeton non émis");

    await suspend(admin.id, client.id);
    expect(await tokens.consume(issued.token, "password_reset")).toBeNull();
  });

  it("ne touche pas aux serveurs du compte", async () => {
    // Choix écrit : la suspension de compte ferme les accès, pas les serveurs.
    // Couper les joueurs est un autre geste, la suspension de serveur.
    const admin = await account({ role: "admin" });
    const client = await account();
    const nodeId = await seedNode(db, { locationId: await seedLocation(db) });
    const serverId = await seedServer(db, { nodeId, ownerId: client.id });

    await suspend(admin.id, client.id);
    const [server] = await db.select().from(servers).where(eq(servers.id, serverId));
    expect(server?.state).toBeNull();
  });

  /* --- Modification ------------------------------------------------------- */

  it("refuse une adresse déjà prise, quelle que soit la casse", async () => {
    const admin = await account({ role: "admin" });
    const client = await account();
    const other = await account();
    // Une ligne ancienne peut porter des majuscules : la reprise les a gardées.
    await db.update(users).set({ email: other.email.toUpperCase() }).where(eq(users.id, other.id));

    await expect(
      accounts.update(
        admin.id,
        client.id,
        { email: other.email, nameFirst: "A", nameLast: "B", locale: "fr" },
        null,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("repasse une adresse changée en « non vérifiée » et éteint les liens de l'ancienne", async () => {
    const admin = await account({ role: "admin" });
    const client = await account({ password: "phrase-de-passe-solide-42" });
    const oldLink = await tokens.issue(client.id, "password_reset", null);
    if (!oldLink) throw new Error("jeton non émis");

    const outcome = await accounts.update(
      admin.id,
      client.id,
      {
        email: "nouvelle@gamedashboard.test",
        nameFirst: "Camille",
        nameLast: "Martin",
        locale: "en",
      },
      null,
    );

    expect(outcome).toEqual({ emailChanged: true, verification: "sent" });
    const [row] = await db.select().from(users).where(eq(users.id, client.id));
    expect(row?.emailVerifiedAt).toBeNull();
    expect(row?.locale).toBe("en");
    expect(await tokens.consume(oldLink.token, "password_reset")).toBeNull();
    expect(mailer.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: "nouvelle@gamedashboard.test" }),
    );
  });

  it("prévient l'ancienne adresse que le compte en a changé", async () => {
    const client = await account({ password: "phrase-de-passe-solide-42" });
    const admin = await account({ role: "admin" });

    await accounts.update(
      admin.id,
      client.id,
      {
        email: "remplacante@gamedashboard.test",
        nameFirst: "Camille",
        nameLast: "Martin",
        locale: "fr",
      },
      "198.51.100.23",
    );
    await alerts.settled();

    // L'ancienne boîte est la seule où le titulaire lira qu'on lui a pris son
    // adresse : la nouvelle n'apprend rien à qui la contrôle déjà.
    const notice = mailer.send.mock.calls
      .map((call) => (call as unknown[])[0] as { to: string; subject: string; text: string })
      .find((sent) => sent.to === client.email);
    expect(notice?.subject).toBe("Adresse e-mail modifiée sur votre compte Panel");
    // L'adresse IP est celle de l'administrateur : elle n'a pas à sortir.
    expect(notice?.text).not.toContain("198.51.100.23");

    const bell = await db
      .select({ title: notifications.title })
      .from(notifications)
      .where(
        and(eq(notifications.userId, client.id), eq(notifications.type, CREDENTIAL_CHANGE_ALERT)),
      );
    expect(bell).toEqual([{ title: "Adresse e-mail modifiée" }]);
  });

  it("garde la vérification quand l'adresse ne change pas", async () => {
    const admin = await account({ role: "admin" });
    const client = await account();
    const outcome = await accounts.update(
      admin.id,
      client.id,
      { email: client.email, nameFirst: "Dominique", nameLast: "Martin", locale: "fr" },
      null,
    );
    expect(outcome.emailChanged).toBe(false);
    const [row] = await db.select().from(users).where(eq(users.id, client.id));
    expect(row?.emailVerifiedAt).not.toBeNull();
    expect(row?.nameFirst).toBe("Dominique");
  });

  it.each(["admin", "support"] as const)(
    "refuse de changer l'adresse d'un autre membre du personnel (%s)",
    async (role) => {
      // NC-59 : réécrire l'adresse d'un confrère, puis lui envoyer une
      // réinitialisation, c'était prendre son compte en deux clics.
      const admin = await account({ role: "admin" });
      const staff = await account({ role, password: "phrase-de-passe-solide-42" });

      await expect(
        accounts.update(
          admin.id,
          staff.id,
          { email: "detournee@gamedashboard.test", nameFirst: "A", nameLast: "B", locale: "fr" },
          null,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      const [row] = await db.select().from(users).where(eq(users.id, staff.id));
      expect(row?.email).toBe(staff.email);
      expect(mailer.send).not.toHaveBeenCalled();

      // Le reste de sa fiche se corrige toujours, et chacun garde la main sur
      // sa propre adresse.
      await accounts.update(
        admin.id,
        staff.id,
        { email: staff.email, nameFirst: "Dominique", nameLast: "B", locale: "fr" },
        null,
      );
      const self = await accounts.update(
        admin.id,
        admin.id,
        { email: "moi@gamedashboard.test", nameFirst: "A", nameLast: "B", locale: "fr" },
        null,
      );
      expect(self.emailChanged).toBe(true);
    },
  );

  /* --- Réinitialisation --------------------------------------------------- */

  it("envoie un lien au titulaire sans jamais le rendre à l'administrateur", async () => {
    const client = await account({ password: "phrase-de-passe-solide-42" });
    const sent = await accounts.requestPasswordReset(client.id, null);

    expect(sent).toEqual({ sentTo: client.email });
    const pending = await db.select().from(authTokens).where(eq(authTokens.userId, client.id));
    expect(pending.map((t) => t.purpose)).toEqual(["password_reset"]);
    expect(mailer.send).toHaveBeenCalledWith(expect.objectContaining({ to: client.email }));
  });

  it("dit pourquoi rien ne part : compte suspendu, sans mot de passe local, sans SMTP", async () => {
    const admin = await account({ role: "admin" });
    const suspended = await account({ password: "phrase-de-passe-solide-42" });
    await suspend(admin.id, suspended.id);
    await expect(accounts.requestPasswordReset(suspended.id, null)).rejects.toThrow(/suspendu/);

    const ssoOnly = await account();
    await expect(accounts.requestPasswordReset(ssoOnly.id, null)).rejects.toThrow(
      /pas de mot de passe local/,
    );

    mailer.isConfigured.mockResolvedValue(false);
    const client = await account({ password: "phrase-de-passe-solide-42" });
    await expect(accounts.requestPasswordReset(client.id, null)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
