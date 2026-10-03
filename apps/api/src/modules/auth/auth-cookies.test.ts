import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { ExecutionContext } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiKeyRepository } from "./api-key.repository";
import type { AppDeviceRepository } from "./app-device.repository";
import type { SecurityAlertService } from "./security-alert.service";
import { SessionGuard } from "./session.guard";
import type { SessionRepository, SessionUser } from "./session.repository";
import { SessionIssuerService } from "./session-issuer.service";
import type { UserRepository } from "./user.repository";

/**
 * `Secure` et `__Host-` suivent l'origine publique du panel (NC-51).
 *
 * Ils dépendaient de `NODE_ENV` seul : `deploy.sh` le pose, mais ni les
 * unités systemd ni `app.sh` ne le font, et un panel servi en HTTPS posait
 * alors un cookie de session sans `Secure` ni `__Host-`.
 *
 * L'environnement est modifié **après** l'import des modules, exprès : l'API
 * charge son `.env` par `ConfigModule`, une fois les modules évalués. Une
 * constante calculée à l'import y aurait vu une origine absente et nommé le
 * cookie autrement que l'interface, qui lit la sienne avant tout.
 */

const USER: SessionUser = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "alex@gamedashboard.test",
  nameFirst: "Alex",
  nameLast: "Martin",
  role: "client",
  locale: "fr",
  timezone: "Europe/Paris",
  avatarUrl: null,
  emailVerifiedAt: null,
  authMethod: "password",
  impersonator: null,
};

function issuer() {
  const sessions = {
    create: async () => "jeton-de-session",
    resolve: async () => USER,
  } as unknown as SessionRepository;
  const users = {
    isSuspended: async () => false,
    noteLogin: async () => undefined,
  } as unknown as UserRepository;
  const alerts = { afterSignIn: () => undefined } as unknown as SecurityAlertService;
  return new SessionIssuerService(sessions, users, alerts);
}

function capturedCookies() {
  const set: { name: string; value: string; options: Record<string, unknown> }[] = [];
  return {
    set,
    sink: {
      setCookie(name: string, value: string, options: Record<string, unknown>) {
        set.push({ name, value, options });
      },
    },
  };
}

describe("cookies d'authentification de l'API", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("PANEL_ORIGIN", "https://panel.gamedashboard.test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("pose __Host- et Secure dès que le panel est servi en HTTPS", async () => {
    const { set, sink } = capturedCookies();
    await issuer().issue(USER.id, { ip: null, userAgent: null }, sink, "password");

    expect(set).toHaveLength(1);
    expect(set[0]?.name).toBe("__Host-gd_session");
    expect(set[0]?.options).toMatchObject({
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: true,
    });
  });

  it("relit le cookie sous le même nom que celui qu'elle pose", async () => {
    const resolve = vi.fn(async () => USER);
    const guard = new SessionGuard(
      { resolve } as unknown as SessionRepository,
      { resolve: async () => null } as unknown as ApiKeyRepository,
      {} as AppDeviceRepository,
    );
    const request = { cookies: { "__Host-gd_session": "jeton-de-session" }, headers: {} };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;

    expect(await guard.canActivate(context)).toBe(true);
    expect(resolve).toHaveBeenCalledWith("jeton-de-session");
  });

  /**
   * Le cookie ne survit pas à la session (NC-03) : douze heures, et non plus
   * sept jours. Un navigateur qui garderait un jeton que l'API refuse ferait
   * voir un 401 à chaque page, sans passer par l'écran de connexion.
   */
  it("pose le cookie pour douze heures au plus", async () => {
    const { set, sink } = capturedCookies();
    await issuer().issue(USER.id, { ip: null, userAgent: null }, sink, "password");
    expect(set[0]?.options.maxAge).toBe(12 * 3600);
  });

  it("reste en clair sur une origine HTTP hors production", async () => {
    vi.stubEnv("PANEL_ORIGIN", "http://localhost:3000");
    const { set, sink } = capturedCookies();
    await issuer().issue(USER.id, { ip: null, userAgent: null }, sink, "password");

    expect(set[0]?.name).toBe("gd_session");
    expect(set[0]?.options.secure).toBe(false);
  });
});

/**
 * La même règle des deux côtés, lue dans le texte.
 *
 * L'interface pose ce que l'API lit : si l'une décide encore de `Secure` ou du
 * nom du cookie par `NODE_ENV` seul, les deux divergent sur un panel servi en
 * HTTPS sans `NODE_ENV`, et la connexion échoue sans rien dire. Le paquet web
 * n'exécute aucun test : ce contrôle vit donc ici, comme les autres contrôles
 * de couverture.
 */
const RACINE = join(import.meta.dirname, "..", "..", "..", "..", "..");
const SOURCES = [join(RACINE, "apps", "api", "src"), join(RACINE, "apps", "web", "src")];

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) return sources(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

function offenders(pattern: RegExp): string[] {
  return SOURCES.flatMap(sources)
    .filter((file) => pattern.test(readFileSync(file, "utf8")))
    .map((file) => relative(RACINE, file));
}

describe("règle des cookies, partagée par l'API et l'interface", () => {
  it("ne décide jamais de Secure par NODE_ENV seul", () => {
    expect(offenders(/secure:\s*process\.env\.NODE_ENV/)).toEqual([]);
  });

  /**
   * L'interface recopie le cookie de session vers le navigateur à trois
   * endroits (connexion, inscription, retour des cérémonies OAuth) : chacun
   * portait `7 * 24 * 60 * 60` en dur (NC-03). Ils lisent la durée commune.
   */
  it("ne pose jamais le cookie de session pour sept jours", () => {
    expect(offenders(/maxAge:\s*7\s*\*\s*24\s*\*/)).toEqual([]);
  });

  it("ne nomme jamais le cookie de session hors de la règle commune", () => {
    expect(offenders(/["']__Host-gd_session/)).toEqual([]);
  });

  /**
   * Le cookie de retour d'une prise en main (NC-25) : l'interface le recopiait
   * sous un nom écrit en dur, que le préfixe `__Host-` aurait fait diverger de
   * celui de l'API.
   */
  it("ne nomme jamais le cookie de retour hors de la règle commune", () => {
    expect(offenders(/["'](__Host-)?gd_return["']/)).toEqual([]);
  });

  /**
   * Un `Set-Cookie` d'effacement sans `Secure` est **ignoré** par le
   * navigateur pour un nom en `__Host-` : la déconnexion laissait le cookie en
   * place. Tout effacement passe donc les mêmes attributs que la pose.
   */
  it("n'efface jamais un cookie d'authentification sans ses attributs", () => {
    expect(offenders(/\.delete\(\s*SESSION_COOKIE\s*\)/)).toEqual([]);
    expect(offenders(/clearCookie\([^)]*\{\s*path:\s*"\/"\s*\}\s*\)/)).toEqual([]);
  });
});
