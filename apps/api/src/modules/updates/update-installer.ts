import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { extract } from "tar";
import { archiveName, type PublishedRelease } from "./github-releases";

/**
 * Les gestes d'une mise à jour, chacun à part pour se tester seul :
 * télécharger en vérifiant, extraire, répéter, faire le ménage. L'ordre et
 * les décisions sont dans `UpdateService`.
 */

/** Une archive autonome pèse une vingtaine de mégaoctets : au-delà, ce n'en est pas une. */
const TAILLE_MAXIMALE = 500 * 1024 * 1024;

/**
 * Télécharge l'archive d'une release et la vérifie contre l'empreinte
 * publiée avec elle.
 *
 * L'empreinte ne prouve pas l'origine — elle vient de la même release —
 * mais elle écarte un téléchargement tronqué, et HTTPS vers le seul dépôt
 * configuré fait le reste. L'adresse est vérifiée avant tout : rien d'autre
 * que les fichiers de release de ce dépôt ne se télécharge ici. `repository`
 * est son nom actuel quand GitHub l'a vu renommé (`fetchLatestRelease`).
 * `site` ne change que pour les tests.
 */
export async function downloadRelease(
  release: PublishedRelease,
  directory: string,
  repository: string,
  site = "https://github.com",
): Promise<string> {
  for (const url of [release.archiveUrl, release.checksumUrl]) {
    if (!isReleaseFile(url, repository, site)) {
      throw new Error(`Adresse de téléchargement refusée : ${url}`);
    }
  }

  const checksum = await fetch(release.checksumUrl, { signal: AbortSignal.timeout(30_000) });
  if (!checksum.ok) throw new Error(`Empreinte introuvable (${checksum.status}).`);
  const [attendue, nom] = (await checksum.text()).trim().split(/\s+/);
  if (!attendue || !/^[0-9a-f]{64}$/.test(attendue) || nom !== archiveName(release.version)) {
    throw new Error("Fichier d'empreinte illisible.");
  }

  await mkdir(directory, { recursive: true });
  const fichier = join(directory, archiveName(release.version));
  const response = await fetch(release.archiveUrl, { signal: AbortSignal.timeout(15 * 60_000) });
  if (!response.ok || !response.body) {
    throw new Error(`Téléchargement impossible (${response.status}).`);
  }

  const hash = createHash("sha256");
  let taille = 0;
  await pipeline(
    Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
    new Transform({
      transform(morceau: Buffer, _encodage, suite) {
        taille += morceau.length;
        if (taille > TAILLE_MAXIMALE) return suite(new Error("Archive trop volumineuse."));
        hash.update(morceau);
        suite(null, morceau);
      },
    }),
    createWriteStream(fichier, { mode: 0o600 }),
  );

  if (hash.digest("hex") !== attendue) {
    await rm(fichier, { force: true });
    throw new Error("L'archive ne correspond pas à son empreinte.");
  }
  return fichier;
}

/**
 * Vrai si `url` désigne un fichier de release de `repository`, et rien d'autre.
 *
 * L'adresse est analysée, pas comparée en texte :
 * - elle doit être déjà sous sa forme normale (`href` identique) : un `../`,
 *   un `%2e%2e` ou une barre inverse se résoudraient ailleurs que le préfixe
 *   lu, vers un autre dépôt ;
 * - même origine que `site` : ni autre hôte, ni autre port, ni identifiants ;
 * - chemin `/<propriétaire>/<dépôt>/releases/download/…`, **sans tenir compte
 *   de la casse**, comme GitHub : `GAMEDASHBOARD_DEPOT` se tape à la main ;
 * - aucune barre encodée (`%2f`, `%5c`), qu'un serveur décoderait.
 */
export function isReleaseFile(url: string, repository: string, site: string): boolean {
  let adresse: URL;
  try {
    adresse = new URL(url);
  } catch {
    return false;
  }
  if (adresse.href !== url || adresse.origin !== new URL(site).origin) return false;
  if (adresse.username || adresse.password || adresse.search || adresse.hash) return false;
  if (/%2f|%5c/i.test(adresse.pathname)) return false;
  const prefixe = `/${repository}/releases/download/`.toLowerCase();
  const chemin = adresse.pathname.toLowerCase();
  return chemin.startsWith(prefixe) && chemin.length > prefixe.length;
}

/**
 * N'extrait de l'archive que `gamedashboard/versions/<version>/`.
 *
 * Le reste (lanceur, racines Passenger) ne sert qu'à une première
 * installation : ici, il est déjà en place. L'extraction se fait à côté,
 * puis le dossier est renommé d'un geste : une version à moitié extraite ne
 * porte jamais son nom. `tar` refuse d'elle-même les chemins absolus et les
 * remontées (`..`).
 */
export async function extractRelease(
  archive: string,
  root: string,
  version: string,
): Promise<string> {
  const versions = join(root, "versions");
  const partiel = join(versions, `.${version}.partiel`);
  const cible = join(versions, version);
  await rm(partiel, { recursive: true, force: true });
  await mkdir(partiel, { recursive: true });

  const prefixe = `gamedashboard/versions/${version}/`;
  await extract({
    file: archive,
    cwd: partiel,
    strip: 3,
    filter: (chemin) => chemin.startsWith(prefixe),
  });
  if (!existsSync(join(partiel, "demarrage", "api.cjs"))) {
    await rm(partiel, { recursive: true, force: true });
    throw new Error(`L'archive ne contient pas la version ${version}.`);
  }

  await rm(cible, { recursive: true, force: true });
  await rename(partiel, cible);
  return cible;
}

/**
 * Répétition : la nouvelle version démarre à part, sur deux ports locaux,
 * avant qu'aucun visiteur ne la voie.
 *
 * L'API joue d'abord ses migrations (c'est son démarrage qui les lance),
 * puis doit répondre avec sa base ; l'interface doit rendre la page de
 * connexion et joindre cette API. `GAMEDASHBOARD_ESSAI` coupe les tâches de
 * fond et la mise à jour : la version en service les tient déjà, deux
 * planificateurs lanceraient deux fois chaque tâche.
 *
 * Un échec lève une erreur qui cite la fin de la sortie de la version : c'est
 * ce que l'administrateur lira pour comprendre.
 */
export async function rehearse(
  root: string,
  version: string,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  const delai = options.timeoutMs ?? 180_000;
  const dossier = join(root, "versions", version, "demarrage");
  const [portApi, portInterface] = [await freePort(), await freePort()];
  const base = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    NODE_ENV: "production",
    GAMEDASHBOARD_ESSAI: "1",
  };

  const api = startNode(join(dossier, "api.cjs"), {
    ...base,
    PORT: String(portApi),
    HOST: "127.0.0.1",
  });
  let interfaceWeb: StartedNode | null = null;
  try {
    await waitFor(
      `http://127.0.0.1:${portApi}/api/health`,
      (corps) => corps.status === "ok" && corps.database === true,
      delai,
      api,
      "L'API",
    );
    interfaceWeb = startNode(join(dossier, "interface.cjs"), {
      ...base,
      PORT: String(portInterface),
      API_URL: `http://127.0.0.1:${portApi}`,
    });
    await waitFor(
      `http://127.0.0.1:${portInterface}/api/health`,
      (corps) => corps.status === "ok",
      delai,
      interfaceWeb,
      "L'interface",
    );
    const connexion = await fetch(`http://127.0.0.1:${portInterface}/login`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (connexion.status !== 200) {
      throw new Error(`L'interface répond ${connexion.status} sur /login.\n${interfaceWeb.tail()}`);
    }
  } finally {
    await Promise.all([stop(api.child), interfaceWeb ? stop(interfaceWeb.child) : null]);
  }
}

/** Efface les versions qui ne sont ni en service ni la précédente, et les restes. */
export async function cleanupVersions(root: string, keep: (string | null | undefined)[]) {
  const versions = join(root, "versions");
  const garder = new Set(keep.filter(Boolean));
  for (const nom of await readdir(versions).catch(() => [] as string[])) {
    if (!garder.has(nom)) await rm(join(versions, nom), { recursive: true, force: true });
  }
  await rm(join(root, "telechargements"), { recursive: true, force: true });
}

interface StartedNode {
  child: ChildProcess;
  tail(): string;
}

function startNode(module: string, env: Record<string, string>): StartedNode {
  const child = spawn(process.execPath, [module], { env, stdio: ["ignore", "pipe", "pipe"] });
  const lignes: string[] = [];
  const garder = (morceau: Buffer) => {
    lignes.push(...morceau.toString("utf8").split("\n").filter(Boolean));
    lignes.splice(0, Math.max(0, lignes.length - 40));
  };
  child.stdout?.on("data", garder);
  child.stderr?.on("data", garder);
  return { child, tail: () => lignes.join("\n") };
}

async function waitFor(
  url: string,
  ready: (corps: Record<string, unknown>) => boolean,
  timeoutMs: number,
  node: StartedNode,
  nom: string,
): Promise<void> {
  const limite = Date.now() + timeoutMs;
  while (Date.now() < limite) {
    if (node.child.exitCode !== null) {
      throw new Error(
        `${nom} s'est arrêtée au démarrage (code ${node.child.exitCode}).\n${node.tail()}`,
      );
    }
    try {
      const reponse = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (reponse.ok && ready((await reponse.json()) as Record<string, unknown>)) return;
    } catch {
      // Pas encore prête.
    }
    await new Promise((fin) => setTimeout(fin, 1_000));
  }
  throw new Error(`${nom} n'a pas répondu en ${Math.round(timeoutMs / 1000)} s.\n${node.tail()}`);
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const fin = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const force = setTimeout(() => child.kill("SIGKILL"), 10_000);
  await fin;
  clearTimeout(force);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const serveur = createServer();
    serveur.once("error", reject);
    serveur.listen(0, "127.0.0.1", () => {
      const adresse = serveur.address();
      serveur.close(() =>
        typeof adresse === "object" && adresse
          ? resolve(adresse.port)
          : reject(new Error("Aucun port libre.")),
      );
    });
  });
}
