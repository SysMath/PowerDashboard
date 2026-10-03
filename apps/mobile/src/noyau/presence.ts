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
  | "suspensionServeur"
  | "suspensionCompte"
  | "deconnecterPartout"
  | "publierIncident"
  | "miseAJourPanel"
  | "geste";

/** Les gestes de l'administration (ADR 0010, lot 6), chemin par chemin. */
const ADMINISTRATION: [RegExp, RaisonPresence][] = [
  [/^\/api\/v1\/admin\/servers\/[^/]+\/suspend$/, "suspensionServeur"],
  [/^\/api\/v1\/admin\/users\/[^/]+\/suspend$/, "suspensionCompte"],
  [/^\/api\/v1\/admin\/users\/[^/]+\/revoke-sessions$/, "deconnecterPartout"],
  [/^\/api\/v1\/admin\/incidents(\/[^/]+\/updates)?$/, "publierIncident"],
  [/^\/api\/v1\/admin\/updates\/check$/, "miseAJourPanel"],
];

export function raisonPresence(method: string, path: string): RaisonPresence {
  const verbe = method.toUpperCase();
  if (verbe === "POST" && /\/backups\/[^/]+\/restore$/.test(path)) return "restaurerSauvegarde";
  if (verbe === "DELETE" && /\/backups\/[^/]+$/.test(path)) return "supprimerSauvegarde";
  if (verbe === "POST" && path.endsWith("/files/delete")) return "supprimerFichiers";
  if (verbe === "POST" && /\/snapshots\/[^/]+\/restore$/.test(path)) return "restaurerInstantane";
  if (verbe === "POST" && /^\/api\/v1\/reseller\/servers\/[^/]+\/suspension$/.test(path)) {
    return "suspensionServeur";
  }
  if (verbe === "POST") {
    const trouvee = ADMINISTRATION.find(([motif]) => motif.test(path));
    if (trouvee) return trouvee[1];
  }
  return "geste";
}
