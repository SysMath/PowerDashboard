import { VERSION_PATTERN } from "./update-state";

/**
 * La dernière release publiée du dépôt, par l'API de GitHub.
 *
 * Sans jeton : le dépôt est public, et un jeton serait un secret de plus à
 * garder sur l'hébergement. La limite anonyme (soixante requêtes par heure
 * et par adresse, partagée avec les voisins d'un mutualisé) est tenue par
 * l'étiquette HTTP : une réponse 304 ne compte pas, et la vérification ne
 * passe qu'à intervalle long.
 *
 * `releases/latest` ne rend jamais une préversion : une étiquette
 * `v1.2.0-rc.1` se publie sans atteindre les hébergements.
 */
export interface PublishedRelease {
  version: string;
  archiveUrl: string;
  checksumUrl: string;
  publishedAt: string | null;
  /**
   * Le nom sous lequel le dépôt publie ses fichiers : celui demandé, ou son
   * nom actuel quand il a été renommé ou transféré depuis. Absent d'un
   * `etat.json` écrit par une version antérieure : c'est alors le nom demandé.
   */
  repository?: string;
}

export type LatestRelease =
  | { kind: "unchanged" }
  | { kind: "none"; etag: string | null }
  | { kind: "found"; release: PublishedRelease; etag: string | null };

export const GITHUB_API = "https://api.github.com";

/**
 * `propriétaire/dépôt`, tel que GitHub les admet ; ni `.` ni `..` comme dépôt,
 * qui changeraient de dossier dans une adresse. Recopié dans
 * `infra/release/autonome.mjs` (`infra-prod.test.ts` vérifie qu'ils sont égaux).
 */
export const REPOSITORY_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/(?!\.\.?$)[A-Za-z0-9._-]+$/;

/** Nom de l'archive autonome d'une version (infra/release/autonome.mjs). */
export function archiveName(version: string): string {
  return `gamedashboard-${version}-autonome.tar.gz`;
}

export async function fetchLatestRelease(
  repository: string,
  options: { etag?: string | null; apiBase?: string; userAgent: string },
): Promise<LatestRelease> {
  const apiBase = options.apiBase ?? GITHUB_API;
  const response = await fetch(`${apiBase}/repos/${repository}/releases/latest`, {
    headers: headers(options.userAgent, options.etag),
    signal: AbortSignal.timeout(20_000),
  });

  if (response.status === 304) return { kind: "unchanged" };
  const etag = response.headers.get("etag");
  // Aucune release encore : GitHub répond 404.
  if (response.status === 404) return { kind: "none", etag };
  if (!response.ok) {
    throw new Error(`GitHub a répondu ${response.status} pour la dernière release.`);
  }

  const body = (await response.json()) as {
    tag_name?: unknown;
    published_at?: unknown;
    assets?: { name?: unknown; browser_download_url?: unknown }[];
  };
  const version = typeof body.tag_name === "string" ? body.tag_name : "";
  if (!VERSION_PATTERN.test(version)) return { kind: "none", etag };

  const url = (name: string) =>
    body.assets?.find((asset) => asset.name === name)?.browser_download_url;
  const archiveUrl = url(archiveName(version));
  const checksumUrl = url(`${archiveName(version)}.sha256`);
  // Une release publiée avant l'archive autonome ne s'installe pas ici.
  if (typeof archiveUrl !== "string" || typeof checksumUrl !== "string") {
    return { kind: "none", etag };
  }

  return {
    kind: "found",
    etag,
    release: {
      version,
      archiveUrl,
      checksumUrl,
      publishedAt: typeof body.published_at === "string" ? body.published_at : null,
      repository: response.redirected
        ? await currentName(repository, response.url, apiBase, options.userAgent)
        : repository,
    },
  };
}

/**
 * Le nom actuel d'un dépôt renommé ou transféré.
 *
 * GitHub redirige l'ancien nom vers `/repositories/<identifiant>/…`, et les
 * fichiers de la release sont publiés sous le nouveau nom : sans lui, la
 * vérification de l'adresse de téléchargement refuserait chaque archive.
 * Le nom se lit auprès de GitHub, par l'identifiant où l'ancien nom mène, et
 * jamais du contenu de la release : c'est toujours le même dépôt, et le seul.
 */
async function currentName(
  requested: string,
  redirectedTo: string,
  apiBase: string,
  userAgent: string,
): Promise<string> {
  const id = new URL(redirectedTo).pathname.match(/^\/repositories\/(\d+)\/releases\/latest$/)?.[1];
  // L'identifiant ne se demande qu'à l'API d'où vient la redirection.
  if (!id || new URL(redirectedTo).origin !== new URL(apiBase).origin) {
    throw new Error(`GitHub a redirigé ${requested} vers une adresse inattendue : ${redirectedTo}`);
  }
  const response = await fetch(`${apiBase}/repositories/${id}`, {
    headers: headers(userAgent),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`GitHub a répondu ${response.status} pour le dépôt ${requested}, renommé.`);
  }
  const body = (await response.json()) as { id?: unknown; full_name?: unknown };
  if (
    String(body.id) !== id ||
    typeof body.full_name !== "string" ||
    !REPOSITORY_PATTERN.test(body.full_name)
  ) {
    throw new Error(`Nom actuel du dépôt ${requested} illisible.`);
  }
  return body.full_name;
}

function headers(userAgent: string, etag?: string | null): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": userAgent,
    ...(etag ? { "if-none-match": etag } : {}),
  };
}
