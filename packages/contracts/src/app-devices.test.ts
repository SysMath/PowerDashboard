import { describe, expect, it } from "vitest";
import {
  APP_REDIRECT_URI,
  appAuthorizeQuerySchema,
  appLinkCookieName,
  appMayReach,
  appNeedsPresence,
  appPresenceMessage,
  appRefreshMessage,
} from "./app-devices";

/** Contrat de liaison de l'application mobile (ADR 0010). */

const demande = {
  code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  code_challenge_method: "S256",
  state: "etat-de-la-liaison-1234",
  device_name: "Pixel de Léa",
  platform: "android",
  redirect_uri: APP_REDIRECT_URI,
};

describe("demande de liaison", () => {
  it("accepte une demande complète", () => {
    expect(appAuthorizeQuerySchema.safeParse(demande).success).toBe(true);
  });

  it("refuse une autre adresse de retour, un défi plain, un nom piégé", () => {
    for (const piege of [
      { redirect_uri: "https://evil.example/cb" },
      { code_challenge_method: "plain" },
      { code_challenge: "court" },
      { device_name: "Pixel\u0000" },
      { platform: "windows" },
      { state: "x" },
    ]) {
      expect(
        appAuthorizeQuerySchema.safeParse({ ...demande, ...piege }).success,
        JSON.stringify(piege),
      ).toBe(false);
    }
  });

  it("nomme son cookie comme la session, __Host- sous HTTPS", () => {
    expect(appLinkCookieName({ NODE_ENV: "production" })).toBe("__Host-gd_app_link");
    expect(
      appLinkCookieName({ NODE_ENV: "development", PANEL_ORIGIN: "http://localhost:3000" }),
    ).toBe("gd_app_link");
  });
});

describe("routes de l'application", () => {
  it("ouvre l'espace client et ferme le reste", () => {
    expect(appMayReach("GET", "/api/v1/client/servers")).toBe(true);
    expect(appMayReach("POST", "/api/v1/client/servers/:id/power")).toBe(true);
    expect(appMayReach("GET", "/api/v1/admin/users")).toBe(false);
    expect(appMayReach("GET", "/api/v1/reseller/servers")).toBe(false);
    expect(appMayReach("POST", "/api/v1/auth/password")).toBe(false);
    expect(appMayReach("GET", "/api/v1/auth/sessions")).toBe(false);
    expect(appMayReach("GET", "")).toBe(false);
  });

  it("demande la présence pour les gestes lourds seulement", () => {
    expect(appNeedsPresence("POST", "/api/v1/client/servers/:id/backups/:backupId/restore")).toBe(
      true,
    );
    expect(appNeedsPresence("post", "/api/v1/client/servers/:id/files/delete")).toBe(true);
    expect(appNeedsPresence("POST", "/api/v1/client/servers/:id/power")).toBe(false);
    expect(appNeedsPresence("GET", "/api/v1/client/servers/:id/backups")).toBe(false);
  });
});

describe("messages signés", () => {
  it("séparent les usages : une signature ne vaut que pour le sien", () => {
    const presence = appPresenceMessage({
      deviceId: "d",
      challenge: "c",
      method: "post",
      path: "/x",
    });
    const refresh = appRefreshMessage({ deviceId: "d", secretSha256: "c", signedAt: 1 });
    expect(presence.split("\n")[0]).toBe("gamedashboard-app-presence-v1");
    expect(presence.endsWith("POST /x")).toBe(true);
    expect(refresh.split("\n")[0]).toBe("gamedashboard-app-refresh-v1");
  });
});
