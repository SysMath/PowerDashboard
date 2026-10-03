/**
 * L'adresse d'un panel, telle que l'utilisateur la tape ou que le code QR la
 * porte.
 *
 * L'application ne connaît aucune adresse à l'avance (ADR 0010) : elle ne
 * garde que l'origine qu'on lui donne, en `https://` seulement. Un chemin, une
 * requête ou un fragment collés avec l'adresse (« …/login ») sont laissés de
 * côté : un panel se sert à la racine de son domaine.
 */

export type AdresseRefusee = "vide" | "http" | "invalide";

export function normaliserAdresse(
  saisie: string,
): { adresse: string } | { erreur: AdresseRefusee } {
  const brute = saisie.trim();
  if (brute === "") return { erreur: "vide" };
  const avecSchema = /^[a-z][a-z0-9+.-]*:\/\//i.test(brute) ? brute : `https://${brute}`;

  let url: URL;
  try {
    url = new URL(avecSchema);
  } catch {
    return { erreur: "invalide" };
  }
  // Pas de repli vers http : un panel en clair laisserait lire le code de
  // liaison et le jeton à quiconque est sur le même réseau.
  if (url.protocol === "http:") return { erreur: "http" };
  if (url.protocol !== "https:") return { erreur: "invalide" };
  // Des identifiants dans l'adresse (`https://moi:secret@…`) n'ont rien à
  // faire dans une liaison, et finiraient dans l'historique du navigateur.
  if (url.username !== "" || url.password !== "") return { erreur: "invalide" };
  if (url.hostname === "") return { erreur: "invalide" };
  return { adresse: url.origin };
}

/** Le domaine seul, celui que l'écran montre en gros avant la connexion. */
export function domaineDe(adresse: string): string {
  return new URL(adresse).host;
}
