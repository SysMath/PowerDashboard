import type { ExecutionContext } from "@nestjs/common";
import { ForbiddenException } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiKeyRepository } from "./api-key.repository";
import type { AppDeviceRepository } from "./app-device.repository";
import { SessionGuard, sessionCookie } from "./session.guard";
import type { SessionRepository, SessionUser } from "./session.repository";

/**
 * Contrôle d'origine des écritures par cookie (NC-02, ASVS 4.2.2, 13.2.3).
 *
 * Le défaut : l'API ne lisait ni `Origin`, ni `Sec-Fetch-Site`, ni aucun
 * jeton. La documentation affirmait le contraire (« Origin + double
 * soumission ») et justifiait par là une exception du scan ZAP. La protection
 * tenait à `SameSite=Lax` et au fait que nginx ne publie pas l'API cliente ;
 * un `<form>` d'un autre site qui atteindrait l'API — sous-domaine voisin,
 * proxy mal réglé — écrivait au nom du visiteur connecté.
 *
 * Désormais `SessionGuard` refuse une requête **mutante**, authentifiée **par
 * cookie**, que le navigateur dit venue d'ailleurs : directement (`origin`,
 * `sec-fetch-site`), ou par Next qui relaie ce que le navigateur lui a dit
 * (`x-gd-origin`, `x-gd-fetch-site`).
 */

const utilisateur = { id: "u-1", email: "ada@exemple.fr" } as unknown as SessionUser;
const principalDeCle = { user: utilisateur, scopes: ["power.start"] };

function garde() {
  const sessions = { resolve: vi.fn(async () => utilisateur) };
  const keys = { resolve: vi.fn(async () => principalDeCle) };
  const devices = { resolveAccess: vi.fn(async () => null) };
  const guard = new SessionGuard(
    sessions as unknown as SessionRepository,
    keys as unknown as ApiKeyRepository,
    devices as unknown as AppDeviceRepository,
  );
  return { guard, sessions, keys, devices };
}

function contexte(requete: {
  method: string;
  headers?: Record<string, string>;
  cookie?: boolean;
}): { ctx: ExecutionContext; req: Record<string, unknown> } {
  const req: Record<string, unknown> = {
    method: requete.method,
    headers: requete.headers ?? {},
    cookies: requete.cookie === false ? {} : { [sessionCookie()]: "jeton-de-session" },
  };
  const ctx = { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
  return { ctx, req };
}

describe("SessionGuard — écritures par cookie venues d'un autre site", () => {
  beforeEach(() => {
    vi.stubEnv("PANEL_ORIGIN", "https://panel.example.fr");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("laisse passer l'action serveur que Next relaie pour le panel", async () => {
    const { guard } = garde();
    const { ctx, req } = contexte({
      method: "POST",
      headers: {
        "x-gd-host": "panel.example.fr",
        "x-gd-origin": "https://panel.example.fr",
        "x-gd-fetch-site": "same-origin",
      },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.user).toBe(utilisateur);
  });

  it("laisse passer le domaine d'un revendeur, arrivé par x-gd-host", async () => {
    const { guard } = garde();
    const { ctx } = contexte({
      method: "DELETE",
      headers: {
        "x-gd-host": "panel.revendeur.fr",
        "x-gd-origin": "https://panel.revendeur.fr",
        "x-gd-fetch-site": "same-origin",
      },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it("refuse l'écriture qu'un autre site fait relayer par Next", async () => {
    const { guard, sessions } = garde();
    const { ctx } = contexte({
      method: "POST",
      headers: { "x-gd-host": "panel.example.fr", "x-gd-fetch-site": "cross-site" },
    });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    // Refusée avant même de lire la session : elle ne compte pas comme une
    // activité du titulaire.
    expect(sessions.resolve).not.toHaveBeenCalled();
  });

  it("refuse une origine relayée qui n'est ni le panel ni l'hôte d'arrivée", async () => {
    const { guard } = garde();
    const { ctx } = contexte({
      method: "PATCH",
      headers: { "x-gd-host": "panel.example.fr", "x-gd-origin": "https://evil.example" },
    });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it("refuse un navigateur qui atteindrait l'API directement depuis un autre site", async () => {
    const { guard } = garde();
    const refusees: Record<string, string>[] = [
      { origin: "https://evil.example" },
      { "sec-fetch-site": "cross-site" },
      { origin: "null" },
    ];
    for (const headers of refusees) {
      const { ctx } = contexte({ method: "POST", headers });
      await expect(guard.canActivate(ctx), JSON.stringify(headers)).rejects.toThrow(
        ForbiddenException,
      );
    }
  });

  it("dit pourquoi elle refuse", async () => {
    const { guard } = garde();
    const { ctx } = contexte({ method: "POST", headers: { origin: "https://evil.example" } });
    await expect(guard.canActivate(ctx)).rejects.toThrow(/autre site/);
  });

  it("laisse passer un client sans en-tête d'origine, qui n'est pas un navigateur", async () => {
    const { guard } = garde();
    const { ctx } = contexte({ method: "POST" });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it("laisse passer les lectures, même venues d'un autre site", async () => {
    // Un lien suivi depuis un courriel arrive en `cross-site` : le rendu de la
    // page ne fait que lire, et doit s'afficher.
    const { guard } = garde();
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      const { ctx } = contexte({
        method,
        headers: { "x-gd-fetch-site": "cross-site", origin: "https://evil.example" },
      });
      await expect(guard.canActivate(ctx), method).resolves.toBe(true);
    }
  });

  it("ne s'applique pas à une clé d'API, qu'aucun navigateur ne joint de lui-même", async () => {
    const { guard, keys } = garde();
    const { ctx, req } = contexte({
      method: "POST",
      cookie: false,
      headers: { authorization: "Bearer gd_live_cle", origin: "https://integration.example" },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(keys.resolve).toHaveBeenCalled();
    expect(req.scopes).toEqual(["power.start"]);
  });
});
