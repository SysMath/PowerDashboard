import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { relayablePath, relayToApi } from "./api-relay";

/**
 * Relais des chemins publics de l'API, pour un hébergement sans nginx.
 *
 * Wings appelle le panel sur des chemins codés en dur. Sur un hébergement
 * cPanel, l'adresse du panel ne sert que Next : sans ce relais, chaque appel
 * d'un daemon finissait en page introuvable et aucun serveur ne démarrait.
 */

const amont = vi.fn(async (..._args: unknown[]) =>
  Response.json({ ok: true }, { headers: { "content-encoding": "gzip", "set-cookie": "a=b" } }),
);

/** Un texte lu tel quel dans une expression régulière, antislash compris. */
function echapper(texte: string): string {
  return texte.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
}

function appel(chemin: string, init: RequestInit & { duplex?: "half" } = {}): Request {
  return new Request(`https://panel.example.fr${chemin}`, init);
}

beforeEach(() => {
  vi.stubEnv("API_RELAY", "1");
  vi.stubGlobal("fetch", amont);
});
afterEach(() => {
  amont.mockClear();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("relayablePath", () => {
  it("reprend exactement les chemins que nginx envoie à l'API", () => {
    expect(relayablePath("/api/remote/servers")).toBe(true);
    expect(relayablePath("/api/remote/sftp/auth")).toBe(true);
    expect(relayablePath("/api/application/nodes/3/configuration")).toBe(true);
    expect(relayablePath("/api/v1/application/users")).toBe(true);
    expect(relayablePath("/api/node-agent/heartbeat")).toBe(true);
    expect(relayablePath("/api/v1/openapi.json")).toBe(true);
    expect(relayablePath("/api/v1/status")).toBe(true);
    expect(relayablePath("/api/v1/relais/envois")).toBe(true);
  });

  it("relaie le signal de release d'un hébergement autonome, avec sa signature", async () => {
    expect(relayablePath("/api/v1/updates/signal")).toBe(true);
    expect(relayablePath("/api/v1/updates/status")).toBe(false);

    await relayToApi(
      appel("/api/v1/updates/signal", {
        method: "POST",
        headers: {
          "x-gamedashboard-timestamp": "1790000000",
          "x-gamedashboard-version": "v1.2.0",
          "x-gamedashboard-signature": "sha256=abc",
        },
      }),
    );
    const [, init] = amont.mock.calls[0] as [string, RequestInit];
    const transmis = init.headers as Headers;
    expect(transmis.get("x-gamedashboard-timestamp")).toBe("1790000000");
    expect(transmis.get("x-gamedashboard-version")).toBe("v1.2.0");
    expect(transmis.get("x-gamedashboard-signature")).toBe("sha256=abc");
  });

  it("suit le vhost de production : tout ce que nginx envoie à l'API est relayé", () => {
    const vhost = readFileSync(
      fileURLToPath(new URL("../../../../infra/prod/panel.conf", import.meta.url)),
      "utf8",
    );
    const versApi = [...vhost.matchAll(/location\s+(=\s+)?(\/api\/\S+)\s*\{([^}]*)\}/g)]
      .filter((m) => m[3]?.includes("proxy_pass http://127.0.0.1:3211"))
      .map((m) => m[2] ?? "");
    expect(versApi.length).toBeGreaterThanOrEqual(5);
    for (const chemin of versApi) {
      expect(relayablePath(chemin.endsWith("/") ? `${chemin}x` : chemin), chemin).toBe(true);
    }
  });

  it("n'ouvre rien d'autre de l'API", () => {
    expect(relayablePath("/api/v1/admin/users")).toBe(false);
    expect(relayablePath("/api/v1/client/servers")).toBe(false);
    expect(relayablePath("/api/v1/status/incidents")).toBe(false);
    expect(relayablePath("/api/v1/applications")).toBe(false);
  });

  it("ouvre la liaison mobile à tous, l'espace client au seul jeton d'appareil (ADR 0010)", () => {
    expect(relayablePath("/api/v1/auth/app/token")).toBe(true);
    expect(relayablePath("/api/v1/auth/app/refresh")).toBe(true);
    expect(relayablePath("/api/v1/client/servers", "Bearer gd_mob_jeton")).toBe(true);
    expect(relayablePath("/api/v1/auth/me", "Bearer gd_mob_jeton")).toBe(true);
    expect(relayablePath("/api/v1/reseller/overview", "Bearer gd_mob_jeton")).toBe(true);
    expect(relayablePath("/api/v1/reseller/overview")).toBe(false);
    // Une clé personnelle, ou rien : la porte reste fermée, comme dans nginx.
    expect(relayablePath("/api/v1/client/servers", "Bearer gd_live_abc_secret")).toBe(false);
    expect(relayablePath("/api/v1/auth/me")).toBe(false);
    // Le jeton d'appareil n'ouvre rien d'autre.
    expect(relayablePath("/api/v1/admin/users", "Bearer gd_mob_jeton")).toBe(false);
    expect(relayablePath("/api/v1/auth/sessions", "Bearer gd_mob_jeton")).toBe(false);
    expect(relayablePath("/api/v1/client/../admin/users", "Bearer gd_mob_jeton")).toBe(false);
  });

  it("échappe tout le chemin cité dans une expression régulière", () => {
    for (const texte of ["= /api/v1/auth/me", "a\\b.c", "^(x)+[y]{1}|$?*"]) {
      expect(new RegExp(`^${echapper(texte)}$`).test(texte), texte).toBe(true);
    }
    expect(new RegExp(echapper("a.c")).test("abc")).toBe(false);
  });

  it("relaie l'espace client nginx pour le jeton d'appareil, comme le vhost", () => {
    const vhost = readFileSync(
      fileURLToPath(new URL("../../../../infra/prod/panel.conf", import.meta.url)),
      "utf8",
    );
    expect(vhost).toMatch(
      /map \$http_authorization \$gd_mobile_upstream \{\s*"~\^Bearer gd_mob_"\s+127\.0\.0\.1:3211;/,
    );
    for (const chemin of ["/api/v1/client/", "/api/v1/reseller/", "= /api/v1/auth/me"]) {
      const bloc = new RegExp(`location ${echapper(chemin)} \\{([^}]*)\\}`).exec(vhost)?.[1];
      expect(bloc, chemin).toMatch(/proxy_pass http:\/\/\$gd_mobile_upstream;/);
      expect(bloc, chemin).toMatch(/proxy_set_header Cookie\s+"";/);
    }
  });

  it("refuse un chemin qui remonterait vers une autre route", () => {
    expect(relayablePath("/api/remote/../v1/admin/users")).toBe(false);
    expect(relayablePath("/api/remote/%2e%2e/v1/admin/users")).toBe(false);
    expect(relayablePath("/api/remote/..%2fv1%2fadmin")).toBe(false);
    expect(relayablePath("/api/remote/.\\..\\v1")).toBe(false);
  });
});

describe("relayToApi", () => {
  it("reste éteint sans API_RELAY : en production, nginx aiguille lui-même", async () => {
    vi.stubEnv("API_RELAY", "");
    const reponse = await relayToApi(appel("/api/remote/servers"));
    expect(reponse.status).toBe(404);
    expect(amont).not.toHaveBeenCalled();
  });

  it("relaie la confirmation de présence d'un appareil, jamais son cookie", async () => {
    await relayToApi(
      appel("/api/v1/client/servers/abc/backups/def/restore", {
        method: "POST",
        headers: {
          authorization: "Bearer gd_mob_jeton",
          "x-gd-presence": "defi.signature",
          cookie: "gd_session=volee",
        },
      }),
    );
    const [, init] = amont.mock.calls[0] as [string, RequestInit];
    const transmis = init.headers as Headers;
    expect(transmis.get("x-gd-presence")).toBe("defi.signature");
    expect(transmis.get("cookie")).toBeNull();
  });

  it("refuse une route de l'API qui n'est pas publique", async () => {
    const reponse = await relayToApi(appel("/api/v1/admin/users"));
    expect(reponse.status).toBe(404);
    expect(amont).not.toHaveBeenCalled();
  });

  it("transmet le jeton du daemon, le chemin et la requête, jamais le cookie", async () => {
    const reponse = await relayToApi(
      appel("/api/remote/servers?page=2&per_page=50", {
        headers: {
          authorization: "Bearer node.jeton",
          accept: "application/vnd.pterodactyl.v1+json",
          "user-agent": "Pterodactyl Wings/v1.12.1",
          "x-forwarded-for": "203.0.113.7",
          cookie: "gd_session=volee",
          "x-gd-origin": "https://panel.example.fr",
        },
      }),
    );

    expect(reponse.status).toBe(200);
    const [url, init] = amont.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:3201/api/remote/servers?page=2&per_page=50");
    const transmis = init.headers as Headers;
    expect(transmis.get("authorization")).toBe("Bearer node.jeton");
    expect(transmis.get("user-agent")).toBe("Pterodactyl Wings/v1.12.1");
    expect(transmis.get("x-forwarded-for")).toBe("203.0.113.7");
    expect(transmis.get("cookie")).toBeNull();
    expect(transmis.get("x-gd-origin")).toBeNull();
    expect(init.body).toBeUndefined();
  });

  it("relaie le corps d'un compte rendu et la clé d'idempotence", async () => {
    await relayToApi(
      appel("/api/v1/application/servers", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "cle-1" },
        body: JSON.stringify({ name: "survie" }),
        duplex: "half",
      }),
    );

    const [, init] = amont.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect((init.headers as Headers).get("idempotency-key")).toBe("cle-1");
    expect(await new Response(init.body).text()).toBe('{"name":"survie"}');
  });

  it("ne renvoie ni cookie ni encodage d'un corps déjà décompressé", async () => {
    const reponse = await relayToApi(appel("/api/v1/status"));
    expect(reponse.headers.get("set-cookie")).toBeNull();
    expect(reponse.headers.get("content-encoding")).toBeNull();
    expect(reponse.headers.get("content-type")).toContain("application/json");
    expect(await reponse.json()).toEqual({ ok: true });
  });

  it("répond 502 quand l'API est injoignable, pour que Wings rejoue", async () => {
    amont.mockRejectedValueOnce(new TypeError("fetch failed"));
    const reponse = await relayToApi(appel("/api/remote/backups/abc", { method: "POST" }));
    expect(reponse.status).toBe(502);
  });
});
