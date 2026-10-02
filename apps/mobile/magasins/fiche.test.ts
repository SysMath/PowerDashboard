import { describe, expect, it } from "vitest";
import { FICHES, type Fiche, LIMITES } from "./fiche";

/** Ce que les magasins refusent dans la fiche d'un éditeur qui n'en est pas titulaire. */
const MARQUES =
  /minecraft|pterodactyl|fivem|steam|discord|curseforge|modrinth|apple|android|google|face id|touch id/i;

describe("fiche des magasins", () => {
  for (const [langue, fiche] of Object.entries(FICHES)) {
    it(`« ${langue} » tient dans les limites de chaque magasin`, () => {
      for (const [champ, limite] of Object.entries(LIMITES)) {
        const texte = fiche[champ as keyof Fiche];
        expect(texte.trim(), champ).not.toBe("");
        expect([...texte].length, champ).toBeLessThanOrEqual(limite);
      }
    });

    it(`« ${langue} » ne cite aucune marque d'autrui`, () => {
      for (const texte of Object.values(fiche)) expect(texte).not.toMatch(MARQUES);
    });

    it(`« ${langue} » a des mots-clés nets, sans le nom de l'application`, () => {
      const mots = fiche.motsCles.split(",");
      expect(mots.every((mot) => mot === mot.trim() && mot !== "")).toBe(true);
      expect(new Set(mots).size).toBe(mots.length);
      expect(fiche.motsCles.toLowerCase()).not.toContain(fiche.nom.toLowerCase());
    });
  }

  it("garde le même nom dans chaque langue", () => {
    expect(new Set(Object.values(FICHES).map((fiche) => fiche.nom)).size).toBe(1);
  });
});
