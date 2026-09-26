import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { THEME_INIT_SCRIPT, THEME_STORAGE_KEY } from "./theme-init";

/**
 * Le script de thème servi par `/gd-theme.js`.
 *
 * Il vivait dans `theme-toggle.tsx`, un module client : vu du serveur, la
 * constante était une référence client, et la route servait le texte d'une
 * fonction anonyme que le navigateur refusait (« Function statements require
 * a function name »). Le thème choisi n'était jamais posé avant la peinture.
 */
describe("THEME_INIT_SCRIPT", () => {
  /** Joue le script avec un stockage et une racine de document simulés. */
  function jouer(stocke: string | null): string | null {
    let theme: string | null = null;
    const localStorage = { getItem: (cle: string) => (cle === THEME_STORAGE_KEY ? stocke : null) };
    const document = {
      documentElement: {
        setAttribute: (nom: string, valeur: string) => {
          if (nom === "data-theme") theme = valeur;
        },
      },
    };
    new Function("localStorage", "document", THEME_INIT_SCRIPT)(localStorage, document);
    return theme;
  }

  it("pose le thème choisi, et rien pour « système » ou une valeur inconnue", () => {
    expect(jouer("dark")).toBe("dark");
    expect(jouer("light")).toBe("light");
    expect(jouer(null)).toBeNull();
    expect(jouer("<script>")).toBeNull();
  });

  it("vit dans un module sans « use client », que le serveur lit comme une valeur", () => {
    const source = readFileSync(new URL("./theme-init.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/^\s*["']use client["']/m);
  });
});
