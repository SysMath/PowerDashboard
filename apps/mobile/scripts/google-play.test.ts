import { createHash, createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertion, envoyer } from "./google-play.mts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const compte = {
  client_email: "envoi@projet.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};
const aab = new Uint8Array([1, 2, 3, 4]);
const empreinte = createHash("sha256").update(aab).digest("hex");

/** Un Google Play factice qui note chaque appel. */
function faux(sha256 = empreinte) {
  const appels: { methode: string; url: string; corps?: unknown }[] = [];
  const fetch = (async (url: string, init: RequestInit = {}) => {
    const methode = init.method ?? "GET";
    appels.push({ methode, url, corps: init.body });
    if (url.endsWith("/token")) return Response.json({ access_token: "jeton" });
    if (url.endsWith("/edits") && methode === "POST") return Response.json({ id: "e1" });
    if (url.includes("/bundles?uploadType=media"))
      return Response.json({ versionCode: 42, sha256 });
    return Response.json({});
  }) as typeof globalThis.fetch;
  return { appels, fetch };
}

describe("envoi à Google Play", () => {
  it("signe une assertion que la clé publique du compte vérifie", () => {
    const [entete, corps, signature] = assertion(compte, 1_000).split(".") as [
      string,
      string,
      string,
    ];
    expect(
      createVerify("RSA-SHA256")
        .update(`${entete}.${corps}`)
        .verify(publicKey, Buffer.from(signature, "base64url")),
    ).toBe(true);
    expect(JSON.parse(Buffer.from(corps, "base64url").toString())).toEqual({
      iss: compte.client_email,
      scope: "https://www.googleapis.com/auth/androidpublisher",
      aud: "https://oauth2.googleapis.com/token",
      iat: 1_000,
      exp: 4_600,
    });
  });

  it("dépose l'AAB, le place sur la piste interne et valide la session", async () => {
    const { appels, fetch } = faux();
    const code = await envoyer({ compte, paquet: "fr.gd.app", aab, nom: "1.2.3", fetch });
    expect(code).toBe(42);
    expect(
      appels.map(({ methode, url }) => `${methode} ${url.replace(/^https:\/\/[^/]+/, "")}`),
    ).toEqual([
      "POST /token",
      "POST /androidpublisher/v3/applications/fr.gd.app/edits",
      "POST /upload/androidpublisher/v3/applications/fr.gd.app/edits/e1/bundles?uploadType=media",
      "PUT /androidpublisher/v3/applications/fr.gd.app/edits/e1/tracks/internal",
      "POST /androidpublisher/v3/applications/fr.gd.app/edits/e1:commit",
    ]);
    expect(JSON.parse(appels[3]?.corps as string)).toEqual({
      track: "internal",
      releases: [{ name: "1.2.3", versionCodes: ["42"], status: "completed" }],
    });
  });

  it("abandonne la session si Google a reçu un autre fichier", async () => {
    const { appels, fetch } = faux("0".repeat(64));
    await expect(
      envoyer({ compte, paquet: "fr.gd.app", aab, nom: "1.2.3", fetch }),
    ).rejects.toThrow(/autre fichier/);
    const methodes = appels.map(({ methode, url }) => `${methode} ${url.split("/").pop()}`);
    expect(methodes.at(-1)).toBe("DELETE e1");
    expect(methodes.some((m) => m.includes(":commit"))).toBe(false);
  });
});
