/**
 * Ce que l'éditeur de l'application publie pour elle (ADR 0010, lot 7).
 *
 * La politique de confidentialité est la même page que celle donnée aux deux
 * magasins : l'application la montre avant toute liaison, comme Google Play
 * l'exige, et un panel n'y est pour rien.
 */
export const DEPOT = "https://github.com/SysMath/PowerDashboard";

/** Chemin, dans le dépôt, du texte de la politique de confidentialité. */
export const FICHIER_CONFIDENTIALITE = "docs/confidentialite-application.md";

export const POLITIQUE_CONFIDENTIALITE = `${DEPOT}/blob/main/${FICHIER_CONFIDENTIALITE}`;
