import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COULEURS } from "./couleurs";
import { lireJetons, moduleDeCouleurs, nomDeJeton } from "./jetons";

const tokens = readFileSync(
  fileURLToPath(new URL("../../../../packages/ui/src/styles/tokens.css", import.meta.url)),
  "utf8",
);

describe("couleurs de l'application", () => {
  it("concordent avec tokens.css (relancer `pnpm --filter @gamedashboard/mobile couleurs`)", () => {
    // Une couleur retouchée dans tokens.css et oubliée ici ferait diverger
    // l'application du panel sans que personne ne le voie.
    const genere = readFileSync(fileURLToPath(new URL("./couleurs.ts", import.meta.url)), "utf8");
    expect(genere).toBe(moduleDeCouleurs(lireJetons(tokens)));
  });

  it("portent les jetons dont les écrans ont besoin, en clair et en sombre", () => {
    for (const nom of ["bg", "surface", "text", "textMuted", "accent500", "dangerInk"] as const) {
      expect(COULEURS.clair[nom]).toMatch(/^#[0-9a-f]{6}$/);
      expect(COULEURS.sombre[nom]).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(COULEURS.sombre.bg).not.toBe(COULEURS.clair.bg);
  });

  it("nomme les jetons comme le CSS, en camelCase", () => {
    expect(nomDeJeton("--gd-text-muted")).toBe("textMuted");
    expect(nomDeJeton("--gd-accent-500")).toBe("accent500");
    expect(nomDeJeton("--gd-ansi-bright-red")).toBe("ansiBrightRed");
  });
});
