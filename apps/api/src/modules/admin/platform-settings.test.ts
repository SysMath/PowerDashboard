import type { Database } from "@gamedashboard/db";
import { BadRequestException } from "@nestjs/common";
import { beforeEach, describe, expect, it } from "vitest";
import { decryptRowSecret } from "../../common/row-secrets";
import { PlatformSettingsService } from "./platform-settings.service";

/**
 * Base simulée : `written` garde ce qui aurait été enregistré, `stored` ce que
 * la lecture renvoie.
 */
function service(stored: { key: string; value: unknown; isSecret: boolean }[] = []) {
  const written: { key: string; value: unknown; isSecret: boolean }[] = [];

  /**
   * `from()` doit être **à la fois** awaitable et porteur de `.where()` :
   * `all()` filtre par clé, `flags()` lit la table entière. Un double qui ne
   * gère qu'une des deux formes échoue sur l'autre — c'est exactement ce qui
   * est arrivé au premier jet.
   */
  const from = () => Object.assign(Promise.resolve([] as unknown[]), { where: async () => stored });

  const db = {
    select: () => ({ from }),
    insert: () => ({
      values: (row: { key: string; value: unknown; isSecret: boolean }) => ({
        onConflictDoUpdate: async () => {
          written.push(row);
        },
      }),
    }),
  } as unknown as Database;

  return { svc: new PlatformSettingsService(db), written };
}

describe("écriture des réglages", () => {
  it("refuse une clé absente du catalogue", async () => {
    // La table accepterait n'importe quoi : une faute de frappe produirait un
    // réglage écrit, jamais lu, impossible à distinguer d'un réglage cassé.
    const { svc } = service();
    await expect(svc.save({ "smtp.hots": "x" })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("chiffre un secret avant de l'écrire", async () => {
    process.env.APP_SECRET_KEY ??= "cle-de-test-suffisamment-longue-pour-vitest";
    const { svc, written } = service();
    await svc.save({ "smtp.password": "mon-mot-de-passe" });

    expect(written).toHaveLength(1);
    expect(written[0]?.isSecret).toBe(true);
    // Le contenu ne doit jamais apparaître tel quel dans la colonne.
    expect(String(written[0]?.value)).not.toContain("mon-mot-de-passe");
  });

  it.each([
    "http://status.gamedashboard.fr",
    "https://127.0.0.1",
    "https://192.168.1.10",
    "https://status.internal",
    "file:///etc/passwd",
  ])("refuse la page Instatus « %s » : le panel l'appellerait lui-même", async (adresse) => {
    // NC-56 : la réponse est publiée dans la bannière de chaque page.
    const { svc, written } = service();
    await expect(svc.save({ "instatus.pageUrl": adresse })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(written).toEqual([]);
  });

  it("accepte une page Instatus publique en https, et l'effacement", async () => {
    const { svc, written } = service();
    await svc.save({ "instatus.pageUrl": "https://93.184.216.34" });
    await svc.save({ "instatus.pageUrl": "" });
    expect(written.map((row) => row.value)).toEqual(["https://93.184.216.34", ""]);
  });

  it("ramène le domaine des sous-domaines à sa forme canonique, et refuse ce qui n'en est pas un", async () => {
    // Il finit dans chaque nom publié : « Jeux.Exemple.fr. » produirait des
    // noms que la comparaison avec la zone ne reconnaîtrait plus.
    const { svc, written } = service();
    await svc.save({ "dns.domain": " Jeux.Exemple.FR. " });
    await svc.save({ "dns.domain": "" });
    await expect(svc.save({ "dns.domain": "https://jeux.exemple.fr" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(written.map((row) => row.value)).toEqual(["jeux.exemple.fr", ""]);
  });

  it("refuse un jeton DNS qui n'a pas la forme d'un jeton", async () => {
    // Revue N5 : un jeton collé avec un en-tête ou un saut de ligne partait
    // tel quel dans les requêtes, et pouvait revenir dans un message d'erreur.
    const { svc, written } = service();
    for (const jeton of [
      "Bearer abcdefghijklmnopqrstuvwxyz",
      "court",
      "abc\ndefghijklmnopqrstuvwxyz",
    ]) {
      await expect(svc.save({ "dns.apiToken": jeton })).rejects.toBeInstanceOf(BadRequestException);
    }
    process.env.APP_SECRET_KEY ??= "cle-de-test-suffisamment-longue-pour-vitest";
    await svc.save({ "dns.apiToken": "  Ab_cD-0123456789efghijKLMNOP  " });
    expect(written).toHaveLength(1);
    expect(decryptRowSecret("settings.value", "dns.apiToken", String(written[0]?.value))).toBe(
      "Ab_cD-0123456789efghijKLMNOP",
    );
  });

  it("ignore un secret reçu vide plutôt que d'effacer", async () => {
    // Le champ est toujours vide à l'écran, puisqu'on ne relit jamais un
    // secret. Sans cette règle, enregistrer la marque effacerait le SMTP.
    const { svc, written } = service();
    await svc.save({ "smtp.password": "" });
    expect(written).toEqual([]);
  });

  it("contrôle les adresses de la marque comme celles d'un revendeur", async () => {
    // Ces valeurs finissent dans un `src` ou un `href` de chaque page.
    const { svc, written } = service();
    for (const adresse of ["javascript:alert(1)", "http://cdn.exemple.fr/logo.png", "//x.fr/a"]) {
      await expect(svc.save({ "brand.logoUrl": adresse })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    }
    await expect(svc.save({ "brand.accent": "red;}*{display:none" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(written).toEqual([]);

    await svc.save({ "brand.logoUrl": " https://cdn.exemple.fr/logo.png ", "brand.accent": "" });
    expect(written.map((w) => [w.key, w.value])).toEqual([
      ["brand.logoUrl", "https://cdn.exemple.fr/logo.png"],
      ["brand.accent", ""],
    ]);
  });

  it("convertit une valeur numérique reçue en texte", async () => {
    // `jsonb` accepte une chaîne là où on attend un nombre : la mauvaise
    // valeur ne se découvrirait qu'à l'envoi d'un e-mail.
    const { svc, written } = service();
    await svc.save({ "smtp.port": "2525" });
    expect(written[0]?.value).toBe(2525);
  });

  it("refuse un nombre inexploitable", async () => {
    const { svc } = service();
    await expect(svc.save({ "smtp.port": "deux mille" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("refuse un drapeau inconnu", async () => {
    const { svc } = service();
    await expect(svc.setFlag("teleportation", true)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("lecture des réglages", () => {
  beforeEach(() => {
    process.env.APP_SECRET_KEY ??= "cle-de-test-suffisamment-longue-pour-vitest";
  });

  it("ne rend jamais la valeur d'un secret", async () => {
    const { svc } = service([
      { key: "smtp.password", value: "peu-importe-le-contenu", isSecret: true },
    ]);
    const { values } = await svc.all();
    const secret = values.find((v) => v.key === "smtp.password");

    expect(secret).toEqual({ key: "smtp.password", kind: "secret", isConfigured: true });
    // Aucune trace du contenu, où que ce soit dans la réponse.
    expect(JSON.stringify(values)).not.toContain("peu-importe-le-contenu");
  });

  it("dit qu'un secret n'est pas configuré plutôt que de l'omettre", async () => {
    // L'omettre ferait disparaître le champ de l'écran, et on ne saurait pas
    // qu'il existe à renseigner.
    const { svc } = service();
    const { values } = await svc.all();
    expect(values.find((v) => v.key === "s3.secretKey")).toEqual({
      key: "s3.secretKey",
      kind: "secret",
      isConfigured: false,
    });
  });

  it("sert le repli déclaré quand rien n'est enregistré", async () => {
    const { svc } = service();
    const { values } = await svc.all();
    expect(values.find((v) => v.key === "smtp.port")).toMatchObject({ value: 587 });
    expect(values.find((v) => v.key === "brand.name")).toMatchObject({ value: "GameDashboard" });
  });

  it("ignore une clé en base absente du catalogue", async () => {
    // Un vestige que personne ne lit ne doit pas laisser croire qu'il sert.
    const { svc } = service([{ key: "vestige.oublie", value: "x", isSecret: false }]);
    const { values } = await svc.all();
    expect(values.some((v) => v.key === "vestige.oublie")).toBe(false);
  });
});
