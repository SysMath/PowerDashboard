import { encryptSecret, generateTotpSecret } from "@gamedashboard/auth";
import {
  activityLogs,
  type Database,
  sessions as sessionsTable,
  userOauthAccounts,
  users,
  userTotpCredentials,
} from "@gamedashboard/db";
import { Logger } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createThrowawayDatabase,
  HAS_DATABASE,
  type ThrowawayDatabase,
} from "../../test/throwaway-database";
import { ActivityService } from "../activity/activity.service";
import type { PlatformSettingsService, SsoConfiguration } from "../admin/platform-settings.service";
import type { BrandingService } from "../reseller/branding.service";
import { AuthController } from "./auth.controller";
import { AuthTokenRepository } from "./auth-token.repository";
import { readChallenge } from "./login-challenge";
import { PasskeyRepository } from "./passkey.repository";
import type { SecurityAlertService } from "./security-alert.service";
import { SessionRepository } from "./session.repository";
import { SessionIssuerService } from "./session-issuer.service";
import { SsoService } from "./sso.service";
import { TwoFactorRepository } from "./two-factor.repository";
import { UserRepository } from "./user.repository";

process.env.APP_SECRET_KEY ??= "clé de test des défis de connexion";

/**
 * Le bouton « Se connecter avec Google » (PLAN §12.4, décision 4), de la
 * route jusqu'à la session, contre une vraie base.
 *
 * Seul Google est simulé : ses deux adresses répondent ce qu'il répondrait.
 * Ce qui compte se joue en base — liaison, création, moyen d'entrée de la
 * session — et une doublure n'éprouverait que son accord avec elle-même.
 */

const PANEL = "https://panel.gamedashboard.test";
const RETOUR = `${PANEL}/auth/google/callback`;
const ANNUAIRE: SsoConfiguration = {
  label: "Annuaire",
  authorizeUrl: "https://annuaire.test/authorize",
  tokenUrl: "https://annuaire.test/token",
  userinfoUrl: "https://annuaire.test/userinfo",
  clientId: "annuaire",
  clientSecret: "secret",
  scopes: "openid email profile",
};

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

const requete = {
  ip: "203.0.113.7",
  headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Firefox/131.0" },
  socket: { remoteAddress: "127.0.0.1" },
};

describe.skipIf(!HAS_DATABASE)("Connexion avec Google (intégration)", () => {
  let throwaway: ThrowawayDatabase;
  let db: Database;
  let controller: AuthController;
  let annuaire: SsoConfiguration | null;
  let inscriptionsOuvertes: boolean;
  let profilGoogle: Record<string, unknown>;
  let jetons: AuthTokenRepository;
  const avis = vi.fn();
  const panelAvant = process.env.PANEL_ORIGIN;

  beforeAll(async () => {
    Logger.overrideLogger(false);
    process.env.PANEL_ORIGIN = PANEL;
    throwaway = await createThrowawayDatabase();
    db = throwaway.db;
  }, 60_000);

  afterAll(async () => {
    process.env.PANEL_ORIGIN = panelAvant;
    await throwaway?.drop();
  });

  beforeEach(async () => {
    await db.execute(sql.raw("truncate table users, activity_logs cascade"));
    annuaire = null;
    inscriptionsOuvertes = false;
    profilGoogle = {
      sub: "109876543210",
      email: "alex@gmail.com",
      email_verified: true,
      given_name: "Alex",
      family_name: "Martin",
    };

    // Google, et lui seul : l'échange du code, puis le profil.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (adresse: string | URL) => {
        const url = String(adresse);
        if (url === "https://oauth2.googleapis.com/token") {
          return Response.json({ access_token: "jeton-google", token_type: "Bearer" });
        }
        if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
          return Response.json(profilGoogle);
        }
        return new Response("inattendu", { status: 500 });
      }),
    );

    const reglages = {
      ssoConfiguration: async () => annuaire,
      googleConfiguration: async () => ({
        clientId: "client.apps.googleusercontent.com",
        clientSecret: "s",
      }),
      boolean: async (cle: string) => cle === "security.registrationOpen" && inscriptionsOuvertes,
      text: async () => "gamedashboard.local",
    } as unknown as PlatformSettingsService;

    jetons = new AuthTokenRepository(db);
    avis.mockClear();
    const usersRepo = new UserRepository(db);
    const sessions = new SessionRepository(db);
    const issuer = new SessionIssuerService(sessions, usersRepo, {
      afterSignIn: () => undefined,
    } as unknown as SecurityAlertService);

    controller = new AuthController(
      usersRepo,
      sessions,
      new ActivityService(db),
      new TwoFactorRepository(db),
      // Les clés d'accès : l'écran du second facteur demande s'il y en a ici.
      new PasskeyRepository(db),
      {} as never,
      new SsoService(db, reglages),
      {} as never,
      issuer,
      jetons,
      {} as never,
      reglages,
      {} as never,
      {} as never,
      // Les alertes de sécurité : seul l'avis de changement d'adresse sert ici.
      { afterCredentialChange: avis } as unknown as SecurityAlertService,
      {} as never,
      // Les consoles de Wings : aucune n'est ouverte ici.
      {} as never,
      {} as never,
      // La confirmation du mot de passe : Google n'en demande pas.
      {} as never,
      {
        // Un seul domaine de revendeur vérifié : `panel.revendeur.fr`.
        forHost: async (host: string | null) =>
          host === "panel.revendeur.fr"
            ? { name: "Revendeur", resellerId: "revendeur" }
            : { name: "GameDashboard", resellerId: null },
      } as unknown as BrandingService,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function retour() {
    const reply = fakeReply();
    await controller.googleCallback(
      { code: "code-google", codeVerifier: "verificateur", redirectUri: RETOUR },
      requete as never,
      reply as never,
    );
    return reply;
  }

  async function compte(email: string) {
    const [row] = await db
      .insert(users)
      .values({ email, nameFirst: "Alex", nameLast: "Martin", passwordHash: null })
      .returning({ id: users.id });
    if (!row) throw new Error("compte non créé");
    return row.id;
  }

  /**
   * Le retour revient sur le domaine d'où la cérémonie est partie.
   *
   * Seule l'origine du panel était admise : depuis le domaine d'un revendeur,
   * le retour tombait sur celui de la plateforme, où le cookie de la
   * cérémonie n'existe pas, et la connexion échouait en « demande expirée ».
   */
  it("admet le retour sur le domaine vérifié d'un revendeur, pas sur un autre", async () => {
    const accepte = fakeReply();
    await controller.googleStart(
      { redirectUri: "https://panel.revendeur.fr/auth/google/callback" },
      accepte as never,
    );
    expect(accepte.statusCode).toBe(200);

    for (const ailleurs of [
      "https://evil.example/auth/google/callback",
      "http://panel.revendeur.fr/auth/google/callback",
      "https://panel.revendeur.fr:8443/auth/google/callback",
    ]) {
      const refuse = fakeReply();
      await controller.googleStart({ redirectUri: ailleurs }, refuse as never);
      expect(refuse.statusCode, ailleurs).toBe(422);
    }
  });

  it("part chez Google avec PKCE, et laisse choisir le compte", async () => {
    const reply = fakeReply();
    await controller.googleStart({ redirectUri: RETOUR }, reply as never);

    expect(reply.statusCode).toBe(200);
    const { url } = (reply.body as { data: { url: string } }).data;
    const adresse = new URL(url);
    expect(`${adresse.origin}${adresse.pathname}`).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(adresse.searchParams.get("redirect_uri")).toBe(RETOUR);
    expect(adresse.searchParams.get("scope")).toBe("openid email profile");
    expect(adresse.searchParams.get("code_challenge_method")).toBe("S256");
    expect(adresse.searchParams.get("prompt")).toBe("select_account");
  });

  it("entre dans le compte qui porte l'adresse vérifiée, et le lie", async () => {
    const id = await compte("alex@gmail.com");

    const reply = await retour();
    expect(reply.statusCode).toBe(200);
    expect(reply.cookies.size).toBe(1);

    const [liaison] = await db
      .select()
      .from(userOauthAccounts)
      .where(eq(userOauthAccounts.userId, id));
    expect(liaison?.provider).toBe("google");
    expect(liaison?.providerUserId).toBe("109876543210");

    const [session] = await db.select().from(sessionsTable).where(eq(sessionsTable.userId, id));
    expect(session?.authMethod).toBe("google");
    const [trace] = await db.select().from(activityLogs).where(eq(activityLogs.actorId, id));
    expect(trace?.event).toBe("account.google_login");
  });

  /**
   * L'adresse du compte suit celle de Google ; le titulaire en est prévenu.
   *
   * Le changement se faisait sans un mot (reste signalé du rapport ASVS) : qui
   * prenait la main sur le compte Google déplaçait vers une autre boîte la
   * réinitialisation et les alertes du panel, et les liens déjà partis vers
   * l'ancienne restaient valables.
   */
  it("prévient l'ancienne adresse quand Google en rend une autre, et éteint ses liens", async () => {
    const id = await compte("alex@gmail.com");
    await db
      .update(users)
      .set({ emailVerifiedAt: new Date().toISOString() })
      .where(eq(users.id, id));
    expect((await retour()).statusCode).toBe(200);
    const lien = await jetons.issue(id, "password_reset", null);
    if (!lien) throw new Error("jeton non émis");

    profilGoogle.email = "Alex.Nouvelle@gmail.com";
    const reply = await retour();

    expect(reply.statusCode).toBe(200);
    const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, id));
    expect(row?.email).toBe("alex.nouvelle@gmail.com");
    expect(avis).toHaveBeenCalledTimes(1);
    expect(avis).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: id,
        kind: "emailChanged",
        previousEmail: { address: "alex@gmail.com", verified: true },
      }),
    );
    expect(await jetons.consume(lien.token, "password_reset")).toBeNull();
  });

  it("ne prévient personne quand l'adresse ne change que de casse", async () => {
    await compte("alex@gmail.com");
    profilGoogle.email = "Alex@Gmail.com";

    expect((await retour()).statusCode).toBe(200);
    expect((await retour()).statusCode).toBe(200);
    expect(avis).not.toHaveBeenCalled();
  });

  it("ne crée aucun compte quand les inscriptions sont fermées", async () => {
    const reply = await retour();

    expect(reply.statusCode).toBe(409);
    expect(reply.body).toMatchObject({ noAccount: true });
    expect(await db.select().from(users)).toEqual([]);
  });

  it("crée le compte quand les inscriptions sont ouvertes", async () => {
    inscriptionsOuvertes = true;

    const reply = await retour();
    expect(reply.statusCode).toBe(200);

    const [cree] = await db.select().from(users).where(eq(users.email, "alex@gmail.com"));
    expect(cree?.passwordHash).toBeNull();
    expect(cree?.emailVerifiedAt).not.toBeNull();
    const [trace] = await db
      .select()
      .from(activityLogs)
      .where(eq(activityLogs.actorId, cree?.id ?? ""));
    expect(trace?.event).toBe("account.google_created");
  });

  it("ne rapproche pas une adresse que Google n'a pas vérifiée", async () => {
    await compte("alex@gmail.com");
    profilGoogle.email_verified = false;
    inscriptionsOuvertes = true;

    const reply = await retour();
    expect(reply.statusCode).toBe(409);
    expect(await db.select().from(userOauthAccounts)).toEqual([]);
  });

  /*
   * NC-58, décision de Matheo : le bouton rapproche aussi les comptes du
   * personnel par adresse vérifiée — parité avec la réinitialisation par
   * courriel —, et c'est le second facteur du panel qui les garde. Ce test
   * fige cette garde : un compte Google détourné ne doit jamais suffire à
   * ouvrir une session d'administration.
   */
  it.each(["admin", "support"] as const)(
    "mène un compte %s doté d'un second facteur au défi, sans ouvrir de session",
    async (role) => {
      const id = await compte("alex@gmail.com");
      await db.update(users).set({ role }).where(eq(users.id, id));
      await db.insert(userTotpCredentials).values({
        userId: id,
        secretEnc: encryptSecret(generateTotpSecret()),
        verifiedAt: new Date().toISOString(),
      });

      const reply = await retour();
      expect(reply.statusCode).toBe(200);
      expect(reply.body).toMatchObject({ twoFactorRequired: true, challenge: expect.any(String) });
      expect(reply.cookies.size).toBe(0);
      expect(await db.select().from(sessionsTable).where(eq(sessionsTable.userId, id))).toEqual([]);

      // Le défi nomme ce compte, et la session qu'il ouvrira se dira « google ».
      const defi = readChallenge("login", (reply.body as { challenge: string }).challenge);
      expect(defi).toMatchObject({ userId: id, method: "google" });
    },
  );

  it("s'efface quand l'annuaire est obligatoire : il est alors le seul chemin", async () => {
    annuaire = ANNUAIRE;
    await compte("alex@gmail.com");

    expect(await controller.googleStatus()).toEqual({ data: { enabled: false } });

    const depart = fakeReply();
    await controller.googleStart({ redirectUri: RETOUR }, depart as never);
    expect(depart.statusCode).toBe(409);

    const reply = await retour();
    expect(reply.statusCode).toBe(409);
    expect(reply.cookies.size).toBe(0);
  });
});
