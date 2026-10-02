/**
 * Exporte les couleurs de tokens.css en module TypeScript pour l'application.
 *
 *   pnpm --filter @gamedashboard/mobile couleurs
 *
 * À relancer après toute retouche de tokens.css : `couleurs.test.ts` échoue
 * tant que les deux ne concordent pas.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { lireJetons, moduleDeCouleurs } from "../src/theme/jetons.ts";

const source = fileURLToPath(
  new URL("../../../packages/ui/src/styles/tokens.css", import.meta.url),
);
const cible = fileURLToPath(new URL("../src/theme/couleurs.ts", import.meta.url));

writeFileSync(cible, moduleDeCouleurs(lireJetons(readFileSync(source, "utf8"))));
console.log(`Couleurs écrites dans ${cible}`);
