/**
 * Ce que dit l'invite biométrique d'un geste protégé (ADR 0010) : le système
 * l'affiche au-dessus de Face ID ou de l'empreinte, il doit nommer le geste.
 * Rend une clé de `mobile.presence`.
 */
export type RaisonPresence =
  | "restaurerSauvegarde"
  | "supprimerSauvegarde"
  | "supprimerFichiers"
  | "restaurerInstantane"
  | "geste";

export function raisonPresence(method: string, path: string): RaisonPresence {
  const verbe = method.toUpperCase();
  if (verbe === "POST" && /\/backups\/[^/]+\/restore$/.test(path)) return "restaurerSauvegarde";
  if (verbe === "DELETE" && /\/backups\/[^/]+$/.test(path)) return "supprimerSauvegarde";
  if (verbe === "POST" && path.endsWith("/files/delete")) return "supprimerFichiers";
  if (verbe === "POST" && /\/snapshots\/[^/]+\/restore$/.test(path)) return "restaurerInstantane";
  return "geste";
}
