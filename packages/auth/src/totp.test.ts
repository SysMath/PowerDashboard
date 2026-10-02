import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  InvalidBase32Error,
  otpauthUri,
  TOTP_PERIOD_SECONDS,
  totpCodeAt,
  totpStep,
  verifyTotp,
} from "./totp";

/**
 * Secret des vecteurs d'essai de la RFC 6238, « 12345678901234567890 » en
 * ASCII, réécrit en base32 comme l'attend notre implémentation.
 */
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890", "utf8"));

describe("base32", () => {
  it("suit les vecteurs de la RFC 4648", () => {
    const vectors: [string, string][] = [
      ["f", "MY"],
      ["fo", "MZXQ"],
      ["foo", "MZXW6"],
      ["foob", "MZXW6YQ"],
      ["fooba", "MZXW6YTB"],
      ["foobar", "MZXW6YTBOI"],
    ];
    for (const [plain, encoded] of vectors) {
      expect(base32Encode(Buffer.from(plain, "utf8"))).toBe(encoded);
    }
  });

  it("fait l'aller-retour sur des octets quelconques", () => {
    const bytes = Uint8Array.from({ length: 20 }, (_, i) => (i * 37) % 256);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
  });

  it("accepte minuscules, espaces et remplissage", () => {
    // Un secret recopié depuis un gestionnaire de mots de passe arrive sous
    // toutes ces formes ; refuser sur une casse serait incompréhensible.
    expect(base32Decode("mz xw6 ytb oi==")).toEqual(base32Decode("MZXW6YTBOI"));
  });

  it("retire le remplissage en temps linéaire", () => {
    // `replace(/=+$/, "")` était quadratique sur « ====…x » (CodeQL).
    const debut = performance.now();
    expect(() => base32Decode(`${"=".repeat(100_000)}1`)).toThrow(InvalidBase32Error);
    expect(performance.now() - debut).toBeLessThan(200);
  });

  it("refuse un caractère hors alphabet au lieu de l'ignorer", () => {
    // L'ignorer donnerait une clé différente de celle qu'on croit avoir
    // saisie, et des codes toujours faux sans que rien ne dise pourquoi.
    expect(() => base32Decode("MZXW6YTB01")).toThrow(InvalidBase32Error);
  });
});

describe("totpCodeAt", () => {
  /**
   * Vecteurs d'essai de la RFC 6238, appendice B, pour HMAC-SHA1.
   *
   * La RFC publie huit chiffres ; nous en affichons six, donc la comparaison
   * porte sur les six derniers — la troncature est la même opération.
   */
  it.each([
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
    [20000000000, "353130"],
  ])("rend le code de la RFC 6238 à t=%i", (seconds, expected) => {
    const step = Math.floor(seconds / TOTP_PERIOD_SECONDS);
    expect(totpCodeAt(RFC_SECRET, step)).toBe(expected);
  });

  it("rend toujours six chiffres, zéros de tête compris", () => {
    // `005924` ci-dessus l'illustre : sans remplissage, l'application afficherait
    // « 5924 » et la saisie ne correspondrait jamais.
    for (let step = 0; step < 200; step += 1) {
      expect(totpCodeAt(RFC_SECRET, step)).toMatch(/^[0-9]{6}$/);
    }
  });
});

describe("verifyTotp", () => {
  const now = new Date("2026-09-16T12:00:00.000Z");
  const step = totpStep(now);

  it("accepte le code du pas courant", () => {
    const result = verifyTotp(RFC_SECRET, totpCodeAt(RFC_SECRET, step), { at: now });
    expect(result).toEqual({ valid: true, step });
  });

  it("tolère un pas d'avance et un pas de retard", () => {
    // Horloge de téléphone décalée d'une demi-minute, ou six chiffres recopiés
    // juste après le basculement.
    for (const offset of [-1, 1]) {
      const result = verifyTotp(RFC_SECRET, totpCodeAt(RFC_SECRET, step + offset), { at: now });
      expect(result.valid).toBe(true);
    }
  });

  it("refuse au-delà de la fenêtre", () => {
    expect(verifyTotp(RFC_SECRET, totpCodeAt(RFC_SECRET, step + 2), { at: now }).valid).toBe(false);
    expect(verifyTotp(RFC_SECRET, totpCodeAt(RFC_SECRET, step - 2), { at: now }).valid).toBe(false);
  });

  it("refuse un code déjà consommé, même mathématiquement juste", () => {
    // Le cas qui justifie l'anti-rejeu : sans lui, un code intercepté reste
    // utilisable pendant toute la fenêtre.
    const code = totpCodeAt(RFC_SECRET, step);
    expect(verifyTotp(RFC_SECRET, code, { at: now, lastUsedStep: step }).valid).toBe(false);
  });

  it("accepte encore un pas plus récent que celui déjà consommé", () => {
    // L'anti-rejeu ne doit pas bloquer la connexion suivante : sinon un compte
    // deviendrait inaccessible pendant trente secondes après chaque usage.
    const code = totpCodeAt(RFC_SECRET, step + 1);
    expect(verifyTotp(RFC_SECRET, code, { at: now, lastUsedStep: step }).valid).toBe(true);
  });

  it("refuse ce qui n'est pas six chiffres, sans calculer", () => {
    for (const bad of ["", "12345", "1234567", "abcdef", "12 34 5", "12345a"]) {
      expect(verifyTotp(RFC_SECRET, bad, { at: now }).valid).toBe(false);
    }
  });

  it("accepte un code saisi avec des espaces", () => {
    // Beaucoup d'applications affichent « 123 456 » ; le copier-coller emporte
    // l'espace, et refuser dessus ferait douter du code lui-même.
    const code = totpCodeAt(RFC_SECRET, step);
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect(verifyTotp(RFC_SECRET, spaced, { at: now }).valid).toBe(true);
  });
});

describe("generateTotpSecret", () => {
  it("produit 20 octets, la taille recommandée par la RFC 4226", () => {
    expect(base32Decode(generateTotpSecret())).toHaveLength(20);
  });

  it("ne produit pas deux fois le même", () => {
    const secrets = new Set(Array.from({ length: 50 }, () => generateTotpSecret()));
    expect(secrets.size).toBe(50);
  });
});

describe("otpauthUri", () => {
  const uri = otpauthUri({
    issuer: "GameDashboard",
    account: "equipier@gamedashboard.test",
    secret: RFC_SECRET,
  });

  it("nomme l'émetteur dans l'étiquette et en paramètre", () => {
    // Les applications anciennes ne lisent que l'étiquette, les récentes
    // préfèrent le paramètre : n'en mettre qu'un affiche « (sans nom) » chez
    // une partie des gens.
    expect(uri).toContain("GameDashboard%3Aequipier%40gamedashboard.test");
    expect(uri).toContain("issuer=GameDashboard");
  });

  it("déclare l'algorithme, le nombre de chiffres et la période", () => {
    expect(uri).toContain("algorithm=SHA1");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });
});
