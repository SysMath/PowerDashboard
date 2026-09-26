import { describe, expect, it } from "vitest";
import config from "../../playwright.config";

/**
 * Les serveurs de la suite e2e s'arrêtent par SIGTERM.
 *
 * pnpm 11.27.1, sans terminal de contrôle (CI, conteneur), lance chaque
 * script dans son propre groupe de processus : le
 * SIGKILL que Playwright envoie par défaut au groupe tuait pnpm et laissait
 * l'API et Next orphelins, et la suite restait pendue après son dernier test.
 * Voir `ARRET` dans `playwright.config.ts`.
 */
describe("playwright.config", () => {
  // `E2E_BASE_URL` vise une installation déjà en marche : aucun serveur lancé.
  it.skipIf(process.env.E2E_BASE_URL)("arrête chaque serveur par SIGTERM", () => {
    const serveurs = [config.webServer ?? []].flat();
    expect(serveurs).toHaveLength(2);
    for (const serveur of serveurs) {
      expect(serveur.gracefulShutdown?.signal).toBe("SIGTERM");
    }
  });
});
