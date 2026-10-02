import { join } from "node:path";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

/**
 * En-têtes fixes, identiques pour toute réponse.
 *
 * La CSP n'est pas ici : son nonce change à chaque requête, elle est donc
 * posée par `src/proxy.ts`.
 */
const securityHeaders = [
  // Le panel n'est jamais encadré : redondant avec `frame-ancestors`, pour
  // les navigateurs qui ne lisent pas la CSP.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Les URL `/reset?token=` ne doivent pas partir en Referer vers les logos
  // des revendeurs ni vers un lien externe.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  },
  /*
   * La fenêtre du panel ne partage pas son contexte avec une page d'un autre
   * site qu'elle ouvrirait, ou qui l'aurait ouverte : un onglet malveillant
   * ne peut ni la manipuler par `window.opener`, ni l'observer (PLAN §5.4).
   * Rien n'en pâtit : le SSO passe par des redirections, pas par une
   * fenêtre surgissante, et les onglets ouverts par le panel le sont déjà en
   * `noopener`.
   *
   * Pas de `Cross-Origin-Embedder-Policy`, et c'est un choix. Il ne protège
   * rien par lui-même : il sert à obtenir l'isolation cross-origin
   * (`SharedArrayBuffer`), dont le panel n'a pas l'usage. Et il imposerait à
   * toute ressource d'un autre site d'y consentir — les logos des revendeurs,
   * hébergés chez eux, et le cadre de Turnstile disparaîtraient.
   */
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  // HSTS est posé par nginx, qui termine TLS : ici il ne s'appliquerait pas
  // en développement et ferait doublon en production.
];

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
  transpilePackages: [
    "@gamedashboard/ui",
    "@gamedashboard/contracts",
    "@gamedashboard/i18n",
    "@gamedashboard/sdk",
  ],
  experimental: {
    optimizePackageImports: ["lucide-react"],
  },
  // Turbopack est le bundler par défaut depuis Next 16. Déclarer la section,
  // même vide, vaut adhésion explicite : sans elle, une configuration webpack
  // résiduelle ferait échouer le build avec un avertissement de migration.
  turbopack: {},
  /*
   * Pas de `watchOptions: { pollIntervalMs }` ici, et c'est voulu.
   *
   * Le dépôt a vécu sur `/mnt/c`, servi à WSL par le montage `drvfs`, qui
   * n'émet aucun événement `inotify` : le rechargement à chaud n'y fonctionnait
   * pas, et rien ne le signalait — Turbopack ne se plaint pas d'un veilleur
   * muet, il attend. L'erreur qu'on finissait par lire accusait le code, sur
   * un export pourtant bien présent, parce que le graphe de modules datait du
   * démarrage du serveur.
   *
   * Le sondage est la réponse habituelle à ce montage. Il a été essayé et il ne
   * marchait pas : page ouverte dans le navigateur, son propre fichier touché,
   * aucune recompilation. Le veilleur à sondage de Turbopack tentait de
   * surveiller des chemins qui n'existent pas sur le disque — l'espace virtuel
   * `.next-internal`, les `node_modules` de la racine que pnpm n'y place pas —
   * et déversait un `watch error` par chemin dans la console, c'est-à-dire là
   * où l'on lit les vraies erreurs.
   *
   * Le dépôt a donc déménagé dans le système de fichiers de WSL, où `inotify`
   * fonctionne nativement. Le réglage n'a plus d'objet ; le réintroduire le
   * jour où le rechargement à chaud rate quelque chose reviendrait à refaire ce
   * chemin à l'envers.
   */
};

/*
 * Construction autonome, pour l'archive qui se met à jour d'elle-même
 * (`infra/release/autonome.mjs`, docs/hebergement-cpanel.md).
 *
 * `standalone` réunit dans `.next-autonome/standalone` le serveur et les
 * seuls fichiers de node_modules qu'il charge : l'hébergement n'installe
 * rien. Un dossier à part, pour que la construction ordinaire (`next start`,
 * infra/prod, la CI) reste exactement ce qu'elle est. La racine de traçage
 * est celle du dépôt : les paquets de l'espace de travail en font partie.
 */
if (process.env.GAMEDASHBOARD_AUTONOME === "1") {
  config.output = "standalone";
  config.distDir = ".next-autonome";
  config.outputFileTracingRoot = join(process.cwd(), "..", "..");
}

// Sans argument, le plugin cherche `src/i18n/request.ts`.
export default createNextIntlPlugin()(config);
