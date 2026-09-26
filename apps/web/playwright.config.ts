import { defineConfig, devices } from "@playwright/test";

/**
 * Parcours critiques, joués dans un vrai navigateur.
 *
 * **Ce que ces tests attrapent et qu'aucun autre niveau n'attrape.** Les tests
 * unitaires connaissent les fonctions, les tests d'intégration connaissent
 * l'API — aucun des deux ne sait si la page de connexion se rend, si le cookie
 * de session voyage, si le rendu serveur et l'hydratation disent la même
 * chose, ou si un lecteur d'écran peut suivre. Ce sont précisément les pannes
 * qu'un utilisateur rencontre en premier.
 *
 * **Deux serveurs sont démarrés, et c'est volontaire.** Faire répondre une API
 * simulée validerait l'interface contre une fiction. Ici, le panel parle à la
 * vraie API, qui parle à une vraie base — le seul élément absent est le
 * daemon, qui n'est pas atteignable depuis une intégration continue et dont
 * le contrat est éprouvé ailleurs, par les bancs d'`infra/local`.
 */
const API_PORT = Number(process.env.E2E_API_PORT ?? 3401);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3400);
const API_URL = `http://127.0.0.1:${API_PORT}`;

/**
 * Viser une installation **déjà en marche**, plutôt que d'en démarrer une.
 *
 * `E2E_BASE_URL=https://gamedashboard.local pnpm e2e` joue la suite contre la
 * production locale. C'est le mode qu'on emploie en développement : construire
 * l'interface prend plusieurs minutes, et on veut souvent juste savoir si un
 * écran qu'on vient de toucher tient encore.
 *
 * L'intégration continue, elle, démarre ses propres serveurs : elle doit
 * éprouver ce que la construction produit, pas ce qui traîne sur une machine.
 */
const EXISTANT = process.env.E2E_BASE_URL;
const BASE_URL = EXISTANT ?? `http://127.0.0.1:${WEB_PORT}`;

/**
 * Arrêt des deux serveurs par SIGTERM, et non par le SIGKILL immédiat que
 * Playwright envoie par défaut au groupe de processus.
 *
 * Depuis pnpm 11.27.1, et seulement sans terminal de contrôle (CI, conteneur,
 * service), `pnpm run` lance le script dans **son propre** groupe de
 * processus ; dans un terminal, il le garde dans le sien, et le défaut ne se
 * voit pas en local. Le SIGKILL du groupe tue alors pnpm, mais l'API et Next
 * survivent, orphelins : la suite finissait ses tests puis restait pendue à
 * l'arrêt, jusqu'au délai du job. Un SIGTERM, lui, est relayé par pnpm au
 * script, qui s'arrête proprement.
 */
const ARRET = { signal: "SIGTERM", timeout: 10_000 } as const;

export default defineConfig({
  testDir: "./e2e",
  /*
   * Un seul essai en local, deux en intégration continue.
   *
   * Réessayer masque une instabilité, et une suite qui réessaie trois fois
   * finit par cacher un vrai défaut intermittent. Deux essais bornent le bruit
   * des machines partagées sans transformer un échec réel en succès.
   */
  retries: process.env.CI ? 2 : 0,
  // En série sur la CI : les deux serveurs partagent une base, et deux
  // parcours qui écriraient en même temps se gêneraient pour des raisons
  // qui n'ont rien à voir avec ce qu'ils vérifient.
  workers: process.env.CI ? 1 : undefined,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],

  use: {
    baseURL: BASE_URL,
    // La production locale est servie par mkcert, dont l'autorité n'est pas
    // dans le magasin du navigateur de Playwright. Le certificat n'est pas ce
    // qu'on éprouve ici.
    ignoreHTTPSErrors: true,
    // La trace n'est gardée que d'un échec : elle pèse quelques mégaoctets, et
    // en produire une par test réussi remplirait les artefacts sans servir.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    locale: "fr-FR",
    timezoneId: "Europe/Paris",
  },

  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    /*
     * Un navigateur mobile, parce que le panel est consulté depuis un
     * téléphone — c'est là qu'on regarde un serveur quand on n'est pas devant
     * son écran, et c'est le cas que les mises en page cassent en premier.
     */
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],

  webServer: EXISTANT
    ? undefined
    : [
        {
          command: `pnpm --filter @gamedashboard/api start`,
          port: API_PORT,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
          gracefulShutdown: ARRET,
          env: {
            PORT: String(API_PORT),
            HOST: "127.0.0.1",
            PANEL_ORIGIN: BASE_URL,
            NODE_ENV: "production",
          },
        },
        {
          command: `pnpm --filter @gamedashboard/web start --port ${WEB_PORT}`,
          port: WEB_PORT,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
          gracefulShutdown: ARRET,
          env: { API_URL, PORT: String(WEB_PORT), NODE_ENV: "production" },
        },
      ],
});
