/**
 * La police à chasse fixe du système. « monospace » n'est une famille que
 * sous Android : iOS ne la connaît pas et retombe sur la police
 * proportionnelle, ce qui décale les colonnes de la console et de l'éditeur.
 */
export function policeMono(systeme: string): string {
  return systeme === "ios" ? "Menlo" : "monospace";
}
