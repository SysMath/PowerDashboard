/**
 * Lecture des couleurs de `packages/ui/src/styles/tokens.css`, source unique
 * des couleurs du panel (ADR 0010 : « aucune couleur en dur, là non plus »).
 *
 * Le thème clair est `:root`, le sombre `:root[data-theme="dark"]` par-dessus.
 * Seules les couleurs hexadécimales passent : ombres, anneaux et polices sont
 * des notions du web.
 */

export type Palette = Record<string, string>;

/** `--gd-text-muted` → `textMuted` ; `--gd-accent-500` → `accent500`. */
export function nomDeJeton(variable: string): string {
  return variable
    .replace(/^--gd-/, "")
    .replace(/-([a-z0-9])/g, (_, lettre: string) => lettre.toUpperCase());
}

function couleursDuBloc(bloc: string): Palette {
  const palette: Palette = {};
  for (const [, variable, valeur] of bloc.matchAll(
    /(--gd-[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g,
  )) {
    if (variable && valeur) palette[nomDeJeton(variable)] = valeur.toLowerCase();
  }
  return palette;
}

/** Le contenu du premier bloc dont le sélecteur est exactement `selecteur`. */
function bloc(css: string, selecteur: string): string {
  const debut = css.indexOf(`${selecteur} {`);
  if (debut < 0) throw new Error(`Bloc ${selecteur} introuvable dans tokens.css.`);
  const ouverture = css.indexOf("{", debut);
  const fermeture = css.indexOf("\n}", ouverture);
  return css.slice(ouverture + 1, fermeture);
}

export function lireJetons(css: string): { clair: Palette; sombre: Palette } {
  const sansCommentaires = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const clair = couleursDuBloc(bloc(sansCommentaires, ":root"));
  const sombre = {
    ...clair,
    ...couleursDuBloc(bloc(sansCommentaires, ':root[data-theme="dark"]')),
  };
  return { clair, sombre };
}

/** Le module TypeScript que l'application importe, tel que le script l'écrit. */
export function moduleDeCouleurs(jetons: { clair: Palette; sombre: Palette }): string {
  const objet = (palette: Palette) =>
    Object.entries(palette)
      .map(([nom, valeur]) => `    ${nom}: "${valeur}",`)
      .join("\n");
  return `// Généré par \`pnpm --filter @gamedashboard/mobile couleurs\` depuis
// packages/ui/src/styles/tokens.css. Ne pas modifier à la main : un test
// vérifie la concordance.
export const COULEURS = {
  clair: {
${objet(jetons.clair)}
  },
  sombre: {
${objet(jetons.sombre)}
  },
} as const;

export type NomCouleur = keyof (typeof COULEURS)["clair"];
`;
}
