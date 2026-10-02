import { APP_REDIRECT_URI, appLinkMessage, appRefreshMessage } from "@gamedashboard/contracts";
import { describe, expect, it, vi } from "vitest";
import { versHex } from "./base64";
import {
  cleFactice,
  coffreMemoire,
  hasardNode,
  reponse,
  sha256Node,
  signatureValide,
} from "./essais/outils-node";
import { aliasCle, Registre } from "./instances";
import { lireRetour, preparerLiaison, terminerLiaison } from "./liaison";
import { LiaisonPerdue, SessionAppareil } from "./session";
import { EchecPanel } from "./transport";

const descripteur = {
  instance: "inst-0001-aaaa",
  nom: "Panel d'essai",
  origine: "https://panel.example.com",
  version: "1.0.0",
  notifications: "aucune" as const,
};

function grant(n: number) {
  return {
    deviceId: "0b0c1a4e-3c57-4c2e-9d36-3f1f5e9f0a11",
    accessToken: `gd_mob_jeton${n}`,
    accessExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    deviceSecret: `gd_dev_secret${n}`,
    deviceExpiresAt: "2027-01-01T00:00:00.000Z",
  };
}

async function lier(forme: "brut" | "spki" = "brut") {
  const coffre = coffreMemoire();
  const registre = new Registre(coffre, hasardNode);
  const { cle, cles, etat } = cleFactice(forme);
  const instance = await registre.preparer("https://panel.example.com", descripteur);
  const demande = await preparerLiaison({
    instance,
    nomAppareil: "Pixel de Léa",
    plateforme: "android",
    hasard: hasardNode,
    sha256: sha256Node,
  });
  let corps: Record<string, unknown> = {};
  const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    corps = JSON.parse(String(init?.body));
    return reponse({ data: grant(1) });
  });
  const fin = await terminerLiaison({
    instance,
    code: "c".repeat(43),
    verifier: demande.verifier,
    registre,
    cle,
    fetch,
    horloge: { maintenant: () => 1_800_000_000_000 },
    versionApplication: "1.0.0",
    raison: "Lier",
  });
  return { coffre, registre, cle, cles, etat, instance: fin.instance, demande, corps, fetch };
}

describe("preparerLiaison", () => {
  it("ouvre la page du panel avec un défi PKCE S256 et un state neufs", async () => {
    const coffre = coffreMemoire();
    const registre = new Registre(coffre, hasardNode);
    const instance = await registre.preparer("https://panel.example.com", descripteur);
    const demande = await preparerLiaison({
      instance,
      nomAppareil: "iPhone",
      plateforme: "ios",
      hasard: hasardNode,
      sha256: sha256Node,
    });
    const url = new URL(demande.url);
    expect(`${url.origin}${url.pathname}`).toBe("https://panel.example.com/auth/app/authorize");
    expect(url.searchParams.get("redirect_uri")).toBe(APP_REDIRECT_URI);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    // Le défi est le SHA-256 du vérificateur, que le panel ne voit jamais.
    const attendu = Buffer.from(await sha256Node(demande.verifier)).toString("base64url");
    expect(url.searchParams.get("code_challenge")).toBe(attendu);
    expect(demande.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("state")).toBe(demande.state);
  });
});

describe("lireRetour", () => {
  it("ne reprend que la liaison ouverte", () => {
    const ok = `${APP_REDIRECT_URI}?code=abc&state=etat-attendu-0001`;
    expect(lireRetour(ok, "etat-attendu-0001")).toEqual({ code: "abc" });
    // Un autre state : ce retour ne répond pas à notre demande.
    expect(lireRetour(ok, "autre-etat-00000")).toEqual({ erreur: "etat" });
    expect(
      lireRetour(
        `${APP_REDIRECT_URI}?error=access_denied&state=s1234567890123456`,
        "s1234567890123456",
      ),
    ).toEqual({
      erreur: "refusee",
    });
    expect(lireRetour("https://pirate.example/liaison?code=abc&state=x", "x")).toEqual({
      erreur: "invalide",
    });
  });
});

describe("terminerLiaison", () => {
  it("échange le code signé par la clé d'appareil, que le panel sait vérifier (iOS et Android)", async () => {
    for (const forme of ["brut", "spki"] as const) {
      const { corps, etat } = await lier(forme);
      expect(corps.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const message = appLinkMessage({
        code: String(corps.code),
        publicKey: String(corps.publicKey),
        signedAt: Number(corps.signedAt),
      });
      expect(signatureValide(String(corps.publicKey), message, String(corps.signature))).toBe(true);
      // La liaison est un geste : la biométrie est demandée sur le moment.
      expect(etat.presences).toBe(1);
    }
  });

  it("range le secret et l'appareil, et marque l'instance liée", async () => {
    const { registre, instance } = await lier();
    expect(instance.etat).toBe("liee");
    expect(instance.deviceId).toBe(grant(1).deviceId);
    expect(await registre.lireSecret(instance.id)).toBe("gd_dev_secret1");
  });

  it("efface la clé quand le panel refuse le code", async () => {
    const coffre = coffreMemoire();
    const registre = new Registre(coffre, hasardNode);
    const { cle, cles } = cleFactice();
    const instance = await registre.preparer("https://panel.example.com", descripteur);
    const refus = vi.fn(async () => reponse({ message: "Liaison refusée." }, 401));
    await expect(
      terminerLiaison({
        instance,
        code: "c".repeat(43),
        verifier: "v".repeat(43),
        registre,
        cle,
        fetch: refus,
        horloge: { maintenant: () => Date.now() },
        versionApplication: "1.0.0",
        raison: "Lier",
      }),
    ).rejects.toBeInstanceOf(EchecPanel);
    expect(cles.has(aliasCle(instance.id))).toBe(false);
    expect(await registre.lireSecret(instance.id)).toBeNull();
  });
});

describe("SessionAppareil", () => {
  async function session() {
    const lien = await lier();
    const recus: Record<string, unknown>[] = [];
    let n = 1;
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith("/api/v1/auth/app/refresh")) {
        recus.push(JSON.parse(String(init?.body)));
        n += 1;
        return reponse({ data: grant(n) });
      }
      return reponse({ data: { challenge: "defi0123456789abcdef" } });
    });
    const s = new SessionAppareil({
      instanceId: lien.instance.id,
      registre: lien.registre,
      cle: lien.cle,
      fetch,
      horloge: { maintenant: () => Date.now() },
      sha256: sha256Node,
      versionApplication: "1.0.0",
    });
    return { ...lien, s, fetch, recus };
  }

  it("renouvelle avec le secret signé, et range le nouveau aussitôt", async () => {
    const { s, recus, registre, instance, corps } = await session();
    expect(await s.jeton()).toBe("gd_mob_jeton2");
    const envoi = recus[0] ?? {};
    expect(envoi.deviceSecret).toBe("gd_dev_secret1");
    const message = appRefreshMessage({
      deviceId: grant(1).deviceId,
      secretSha256: versHex(await sha256Node("gd_dev_secret1")),
      signedAt: Number(envoi.signedAt),
    });
    expect(signatureValide(String(corps.publicKey), message, String(envoi.signature))).toBe(true);
    // L'ancien secret ne vaut plus rien : le garder, c'est se faire retirer.
    expect(await registre.lireSecret(instance.id)).toBe("gd_dev_secret2");
  });

  it("ne renouvelle qu'une fois pour des appels simultanés", async () => {
    // Deux renouvellements présenteraient deux fois le même secret : le
    // second passerait pour un vol, et le panel retirerait l'appareil.
    const { s, recus } = await session();
    const jetons = await Promise.all([s.jeton(), s.jeton(), s.renouveler()]);
    expect(new Set(jetons).size).toBe(1);
    expect(recus).toHaveLength(1);
    expect(await s.jeton()).toBe(jetons[0]);
    expect(recus).toHaveLength(1);
  });

  it("garde le jeton valable sans renouveler", async () => {
    const { s, recus } = await session();
    s.adopter(grant(9));
    expect(await s.jeton()).toBe("gd_mob_jeton9");
    expect(recus).toHaveLength(0);
  });

  it("laisse l'écran demander la biométrie quand la clé est fermée", async () => {
    const { s, etat } = await session();
    etat.verrouillee = true;
    await expect(s.jeton()).rejects.toThrow("VERROUILLEE");
  });

  it("marque l'instance à relier quand le panel refuse le renouvellement", async () => {
    const { registre, instance, cle, cles } = await lier();
    const s = new SessionAppareil({
      instanceId: instance.id,
      registre,
      cle,
      fetch: vi.fn(async () => reponse({ message: "Liaison refusée." }, 401)),
      horloge: { maintenant: () => Date.now() },
      sha256: sha256Node,
      versionApplication: "1.0.0",
    });
    await expect(s.jeton()).rejects.toBeInstanceOf(LiaisonPerdue);
    expect((await registre.trouver(instance.id))?.etat).toBe("a-relier");
    expect(await registre.lireSecret(instance.id)).toBeNull();
    expect(cles.has(aliasCle(instance.id))).toBe(false);
  });

  it("garde la liaison quand le panel est seulement injoignable", async () => {
    const { registre, instance, cle } = await lier();
    const s = new SessionAppareil({
      instanceId: instance.id,
      registre,
      cle,
      fetch: vi.fn(async () => {
        throw new TypeError("Network request failed");
      }),
      horloge: { maintenant: () => Date.now() },
      sha256: sha256Node,
      versionApplication: "1.0.0",
    });
    await expect(s.jeton()).rejects.toMatchObject({ status: 0 });
    expect((await registre.trouver(instance.id))?.etat).toBe("liee");
    expect(await registre.lireSecret(instance.id)).toBe("gd_dev_secret1");
  });

  it("signe la présence pour le geste exact, après la biométrie", async () => {
    const { s, corps, etat } = await session();
    const avant = etat.presences;
    const entete = await s.presence(
      "POST",
      "/api/v1/client/servers/s1/backups/b1/restore",
      "Restaurer",
    );
    const [defi, signature] = (entete["x-gd-presence"] ?? "").split(".");
    expect(defi).toBe("defi0123456789abcdef");
    const message = [
      "gamedashboard-app-presence-v1",
      grant(1).deviceId,
      defi,
      "POST /api/v1/client/servers/s1/backups/b1/restore",
    ].join("\n");
    expect(signatureValide(String(corps.publicKey), message, signature ?? "")).toBe(true);
    expect(etat.presences).toBe(avant + 1);
  });

  it("délie : le panel d'abord, puis la clé et le secret quittent le téléphone", async () => {
    const { s, fetch, registre, instance, cles } = await session();
    s.adopter(grant(5));
    await s.delier();
    const appel = fetch.mock.calls.find(([url]) => String(url).endsWith("/api/v1/auth/app/device"));
    expect(appel?.[1]?.method).toBe("DELETE");
    expect(await registre.trouver(instance.id)).toBeNull();
    expect(await registre.lireSecret(instance.id)).toBeNull();
    expect(cles.has(aliasCle(instance.id))).toBe(false);
  });
});
