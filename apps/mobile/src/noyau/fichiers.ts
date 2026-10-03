import type { ClientFileEntryView, UploadGrant } from "@gamedashboard/contracts";

/*
 * Le gestionnaire de fichiers de l'application (ADR 0010) : mêmes routes et
 * mêmes liens signés de Wings que le web. Un fichier texte s'ouvre dans un
 * éditeur simple jusqu'à 1 Mo ; au-delà, ou binaire, il se télécharge.
 */

/** Au-delà, un fichier ne s'ouvre pas dans l'éditeur du téléphone. */
export const TAILLE_EDITABLE = 1024 * 1024;

/** Dossiers d'abord, puis par nom : Wings ne garantit aucun tri. */
export function trier(entrees: readonly ClientFileEntryView[]): ClientFileEntryView[] {
  return [...entrees].sort((a, b) =>
    a.directory === b.directory ? a.name.localeCompare(b.name, "fr") : a.directory ? -1 : 1,
  );
}

/** Un chemin absolu du volume, sans barre finale ni segment vide. */
export function normaliser(chemin: string): string {
  const parties = chemin.split("/").filter((partie) => partie !== "" && partie !== ".");
  return `/${parties.join("/")}`;
}

export function joindre(dossier: string, nom: string): string {
  return normaliser(`${dossier}/${nom}`);
}

/** Le dossier qui contient `chemin` ; la racine est son propre parent. */
export function parent(chemin: string): string {
  const parties = normaliser(chemin).split("/").filter(Boolean);
  return `/${parties.slice(0, -1).join("/")}`;
}

/** Le fil d'Ariane : chaque dossier traversé, racine comprise. */
export function fil(chemin: string): { nom: string; chemin: string }[] {
  const parties = normaliser(chemin).split("/").filter(Boolean);
  return [
    { nom: "/", chemin: "/" },
    ...parties.map((nom, rang) => ({ nom, chemin: `/${parties.slice(0, rang + 1).join("/")}` })),
  ];
}

const MIMES_TEXTE = new Set([
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "application/javascript",
  "application/x-sh",
  "inode/x-empty",
]);

const EXTENSIONS_TEXTE = new Set(
  "txt log properties yml yaml json json5 toml cfg conf ini xml md sh bat env lang mcmeta csv secret".split(
    " ",
  ),
);

const ARCHIVES = [
  ".zip",
  ".tar",
  ".tar.gz",
  ".tgz",
  ".tar.bz2",
  ".tbz2",
  ".tar.xz",
  ".txz",
  ".rar",
  ".7z",
  ".gz",
];

export type Ouverture = "dossier" | "editer" | "trop-gros" | "binaire";

/** Ce qu'un toucher fait d'une entrée. */
export function ouverture(entree: ClientFileEntryView): Ouverture {
  if (entree.directory) return "dossier";
  if (!estTexte(entree)) return "binaire";
  return entree.size > TAILLE_EDITABLE ? "trop-gros" : "editer";
}

function estTexte(entree: ClientFileEntryView): boolean {
  const mime = (entree.mime.split(";")[0] ?? "").trim().toLowerCase();
  if (mime.startsWith("text/") || MIMES_TEXTE.has(mime)) return true;
  const point = entree.name.lastIndexOf(".");
  return point > 0 && EXTENSIONS_TEXTE.has(entree.name.slice(point + 1).toLowerCase());
}

export function estArchive(nom: string): boolean {
  const bas = nom.toLowerCase();
  return ARCHIVES.some((extension) => bas.endsWith(extension));
}

export type RefusNom = "vide" | "reserve" | "barre";

/** Un nom de dossier ou de fichier saisi sur le téléphone. `null` s'il convient. */
export function refusNom(nom: string): RefusNom | null {
  const propre = nom.trim();
  if (propre === "") return "vide";
  if (propre === "." || propre === ".." || propre.includes("\0")) return "reserve";
  if (propre.includes("/")) return "barre";
  return null;
}

/** Où déposer chez le daemon : le jeton et le dossier vont dans la requête. */
export function adresseEnvoi(grant: UploadGrant, dossier: string): string {
  const requete = `token=${encodeURIComponent(grant.token)}&directory=${encodeURIComponent(normaliser(dossier))}`;
  return `${grant.url}${grant.url.includes("?") ? "&" : "?"}${requete}`;
}

/**
 * Le refus du daemon, en clair : Wings écrit « fichier plus volumineux que
 * la limite », et le remplacer par un échec générique ferait chercher une
 * panne là où il n'y a qu'un fichier trop gros. `null` s'il n'en dit rien.
 */
export function refusDaemon(corps: string): string | null {
  try {
    const lu = JSON.parse(corps) as { error?: unknown; errors?: { detail?: unknown }[] };
    if (typeof lu.error === "string" && lu.error.trim() !== "") return lu.error;
    const detail = lu.errors?.[0]?.detail;
    return typeof detail === "string" && detail.trim() !== "" ? detail : null;
  } catch {
    return null;
  }
}

export type ActionFichier =
  | "ouvrir"
  | "telecharger"
  | "renommer"
  | "compresser"
  | "extraire"
  | "supprimer";

/**
 * Le menu d'une entrée, dans l'ordre affiché. Seul un fichier se télécharge
 * (le daemon ne sert pas un dossier entier : il faut le compresser d'abord),
 * et seule une archive s'extrait.
 */
export function actionsEntree(entree: ClientFileEntryView): ActionFichier[] {
  const actions: ActionFichier[] = [];
  const mode = ouverture(entree);
  if (mode === "dossier" || mode === "editer") actions.push("ouvrir");
  if (!entree.directory) actions.push("telecharger");
  actions.push("renommer", "compresser");
  if (!entree.directory && estArchive(entree.name)) actions.push("extraire");
  actions.push("supprimer");
  return actions;
}
