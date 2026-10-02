import { useColorScheme } from "react-native";
import { COULEURS, type NomCouleur } from "./couleurs";

export type Couleurs = Record<NomCouleur, string>;

/** Les couleurs du thème du téléphone, celles de tokens.css. */
export function useCouleurs(): Couleurs {
  return useColorScheme() === "dark" ? COULEURS.sombre : COULEURS.clair;
}

/** Espacements et rayons, alignés sur ceux du panel (`--gd-radius*`). */
export const ESPACE = { xs: 4, s: 8, m: 12, l: 16, xl: 24 } as const;
export const RAYON = { normal: 12, petit: 8 } as const;

/** Police à chasse fixe du système, pour la console. */
export const MONO = { fontFamily: "monospace" } as const;
