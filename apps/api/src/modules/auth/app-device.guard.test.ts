import type { ExecutionContext } from "@nestjs/common";
import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { ApiKeyRepository } from "./api-key.repository";
import type { AppDeviceRepository } from "./app-device.repository";
import { BrowserSessionGuard } from "./browser-session.guard";
import { isBrowserSession, SessionGuard } from "./session.guard";
import type { SessionRepository, SessionUser } from "./session.repository";

/**
 * Le jeton d'un appareil mobile devant `SessionGuard` (ADR 0010).
 *
 * Il porte les droits du compte, mais seulement sur les routes que
 * l'application emploie : jamais l'administration ni l'espace revendeur
 * (`APP_STAFF_ROUTES` est vide), jamais la sécurité du compte, et un geste
 * lourd exige la confirmation de présence.
 */

const personnel = { id: "u-1", email: "admin@exemple.fr", role: "admin" } as unknown as SessionUser;

function garde(options: { presence?: boolean } = {}) {
  const devices = {
    resolveAccess: vi.fn(async (token: string) =>
      token === "gd_mob_valide" ? { user: personnel, deviceId: "d-1" } : null,
    ),
    consumePresence: vi.fn(async () => options.presence ?? false),
  };
  const keys = { resolve: vi.fn(async () => null) };
  const guard = new SessionGuard(
    { resolve: vi.fn() } as unknown as SessionRepository,
    keys as unknown as ApiKeyRepository,
    devices as unknown as AppDeviceRepository,
  );
  return { guard, devices, keys };
}

function requete(method: string, route: string, extra: Record<string, string> = {}) {
  const req: Record<string, unknown> = {
    method,
    url: route.replace(":id", "abc").replace(":backupId", "def"),
    routeOptions: { url: route },
    headers: { authorization: "Bearer gd_mob_valide", ...extra },
    cookies: {},
  };
  const ctx = { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
  return { ctx, req };
}

describe("SessionGuard — appareil mobile", () => {
  it("ouvre l'espace client avec les droits du compte, marqué comme appareil", async () => {
    const { guard, keys } = garde();
    const { ctx, req } = requete("GET", "/api/v1/client/servers");

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.scopes).toBeNull();
    expect(req.appDeviceId).toBe("d-1");
    expect(isBrowserSession(req)).toBe(false);
    // Un jeton `gd_mob_` ne part jamais vers les clés d'API.
    expect(keys.resolve).not.toHaveBeenCalled();
  });

  it("refuse un jeton inconnu ou retiré", async () => {
    const { guard } = garde();
    const { ctx } = requete("GET", "/api/v1/client/servers", {
      authorization: "Bearer gd_mob_retire",
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(false);
  });

  it("ferme l'administration et l'espace revendeur, même au personnel", async () => {
    const { guard } = garde();
    for (const route of ["/api/v1/admin/users", "/api/v1/reseller/servers"]) {
      const { ctx } = requete("GET", route);
      await expect(guard.canActivate(ctx), route).rejects.toThrow(ForbiddenException);
    }
  });

  it("ferme ce qui n'est pas l'espace client, la liaison ou le profil", async () => {
    const { guard } = garde();
    for (const route of ["/api/v1/invitations/:token/accept", "/api/v1/admin/updates/check"]) {
      const { ctx } = requete("POST", route);
      await expect(guard.canActivate(ctx), route).rejects.toThrow(ForbiddenException);
    }
    const { ctx } = requete("GET", "/api/v1/auth/me");
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it("exige la confirmation de présence pour restaurer une sauvegarde", async () => {
    const route = "/api/v1/client/servers/:id/backups/:backupId/restore";
    const refuse = garde({ presence: false });
    await expect(refuse.guard.canActivate(requete("POST", route).ctx)).rejects.toMatchObject({
      response: { code: "presence_required" },
    });

    const accepte = garde({ presence: true });
    const { ctx } = requete("POST", route, { "x-gd-presence": "defi.signature" });
    await expect(accepte.guard.canActivate(ctx)).resolves.toBe(true);
    expect(accepte.devices.consumePresence).toHaveBeenCalledWith("d-1", "defi.signature", {
      method: "POST",
      path: "/api/v1/client/servers/abc/backups/def/restore",
    });
  });

  it("ne demande rien de plus pour un geste ordinaire", async () => {
    const { guard, devices } = garde();
    await expect(
      guard.canActivate(requete("POST", "/api/v1/client/servers/:id/power").ctx),
    ).resolves.toBe(true);
    expect(devices.consumePresence).not.toHaveBeenCalled();
  });
});

describe("BrowserSessionGuard — appareil mobile", () => {
  it("garde la sécurité du compte au navigateur", () => {
    const ctx = {
      switchToHttp: () => ({ getRequest: () => ({ scopes: null, appDeviceId: "d-1" }) }),
    } as unknown as ExecutionContext;
    expect(() => new BrowserSessionGuard().canActivate(ctx)).toThrow(ForbiddenException);
  });
});
