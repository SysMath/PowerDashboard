#!/usr/bin/env node
/**
 * Assemble l'archive **autonome** d'une version : le panel prêt à tourner,
 * sans rien à installer, pour un hébergement qui se met à jour de lui-même
 * (docs/hebergement-cpanel.md).
 *
 *   GAMEDASHBOARD_AUTONOME=1 pnpm --filter @gamedashboard/web build
 *   node infra/release/autonome.mjs v1.2.0 [dossier-de-sortie]
 *
 * Lancé par .github/workflows/release.yml sur chaque étiquette `v*`, à côté
 * de l'archive ordinaire (assembler.sh), qui reste celle d'un serveur à soi.
 *
 * Ce qu'elle contient, sous `gamedashboard/` :
 *
 *   passenger/lanceur.cjs, passenger/{api,interface}/app.cjs, passenger/admin.cjs
 *   versions/<version>/
 *     RELEASE        version, commit, dépôt, identifiant de construction
 *     demarrage/     les modules que charge le lanceur (infra/cpanel)
 *     api/           main.cjs et migrer.cjs (esbuild), migrations,
 *                    node_modules réduit au module natif d'argon2
 *     web/           l'interface en mode standalone, statiques compris
 *
 * Elle s'extrait telle quelle dans le dossier personnel pour une première
 * installation ; ensuite, le panel n'en extrait plus que `versions/<v>/`.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { build } from "esbuild";
import { EXTERNES_API } from "./externes-api.mjs";

const VERSION = process.argv[2];
const SORTIE = process.argv[3] ?? "dist";
const RACINE = realpathSync(join(import.meta.dirname, "..", ".."));
const WEB = join(RACINE, "apps", "web");
const API = join(RACINE, "apps", "api");

if (!/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(VERSION ?? "")) {
  arreter("Usage : autonome.mjs <version, ex. v1.2.0> [dossier de sortie]");
}

/*
 * Des sources modifiées donneraient une archive qui ne correspond à aucun
 * commit : même garde-fou que assembler.sh.
 */
const modifies = git(
  "status",
  "--porcelain",
  "--untracked-files=no",
  "--",
  ".",
  ":!apps/web/next-env.d.ts",
);
if (modifies) arreter(`Des fichiers suivis sont modifiés :\n${modifies}`);

const STANDALONE = join(WEB, ".next-autonome", "standalone");
if (!existsSync(join(STANDALONE, "apps", "web", "server.js"))) {
  arreter(
    "Interface autonome absente : GAMEDASHBOARD_AUTONOME=1 pnpm --filter @gamedashboard/web build",
  );
}

const travail = mkdtempSync(join(tmpdir(), "gamedashboard-autonome-"));
try {
  const racineArchive = join(travail, "gamedashboard");
  const version = join(racineArchive, "versions", VERSION);
  mkdirSync(version, { recursive: true });

  await compilerApi(join(version, "api"));
  copierInterface(join(version, "web"));
  copierDemarrage(version, racineArchive);
  ecrireRelease(version);

  mkdirSync(SORTIE, { recursive: true });
  const nom = `gamedashboard-${VERSION}-autonome.tar.gz`;
  const archive = join(SORTIE, nom);
  // Archive reproductible : dates, propriétaires et ordre fixés.
  execFileSync("tar", [
    "--sort=name",
    `--mtime=@${git("show", "-s", "--format=%ct", "HEAD")}`,
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    "--use-compress-program=gzip -n -9",
    "-C",
    travail,
    "-cf",
    archive,
    "gamedashboard",
  ]);
  const empreinte = createHash("sha256").update(readFileSync(archive)).digest("hex");
  writeFileSync(`${archive}.sha256`, `${empreinte}  ${nom}\n`);
  const taille = (statSync(archive).size / 1024 / 1024).toFixed(1);
  console.log(`Archive autonome : ${archive} (${taille} Mo)\n${empreinte}  ${nom}`);
} finally {
  rmSync(travail, { recursive: true, force: true });
}

/**
 * L'API et son migrateur, chacun en un fichier.
 *
 * CommonJS : des dépendances en CommonJS y lisent `__dirname`, qu'un paquet
 * ESM n'aurait pas. `keepNames` : Nest lit le nom des classes (contexte des
 * journaux, `code` des erreurs renvoyées).
 *
 * Restent dehors : le module natif d'argon2, copié à côté, et les paquets
 * facultatifs que Nest cherche sans les exiger (`externes-api.mjs`).
 */
async function compilerApi(dossier) {
  const externes = EXTERNES_API;
  await build({
    absWorkingDir: API,
    entryPoints: { main: "src/main.ts", migrer: "src/migrate.ts" },
    outdir: dossier,
    outExtension: { ".js": ".cjs" },
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
    tsconfig: join(API, "tsconfig.json"),
    keepNames: true,
    legalComments: "linked",
    external: externes,
    logLevel: "warning",
    // `new Reply(…)` sur un espace de noms : c'est le code de Nest lui-même
    // (@nestjs/platform-fastify, en ESM), qui se comporte de même sous tsx.
    logOverride: { "call-import-namespace": "silent" },
  });

  // La création d'un administrateur attend au premier niveau : elle se
  // compile en ESM, avec un `require` pour les dépendances en CommonJS.
  await build({
    absWorkingDir: API,
    entryPoints: { "creer-admin": "scripts/create-admin.mts" },
    outdir: dossier,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    banner: {
      js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    },
    tsconfig: join(API, "tsconfig.json"),
    keepNames: true,
    legalComments: "linked",
    external: externes,
    logLevel: "warning",
  });

  cpSync(join(RACINE, "packages", "db", "migrations"), join(dossier, "migrations"), {
    recursive: true,
  });

  // argon2 et le binaire de la plateforme des hébergements (Linux x64, glibc).
  const exiger = createRequire(join(RACINE, "packages", "auth", "package.json"));
  const argon2 = dirname(exiger.resolve("@node-rs/argon2/package.json"));
  const binaire = join(dirname(argon2), "argon2-linux-x64-gnu");
  if (!existsSync(binaire)) arreter(`Binaire d'argon2 introuvable : ${binaire}`);
  for (const paquet of [argon2, binaire]) {
    cpSync(realpathSync(paquet), join(dossier, "node_modules", "@node-rs", basename(paquet)), {
      recursive: true,
      dereference: true,
    });
  }
}

/** L'interface standalone, avec ce que Next laisse à copier : statiques et `public/`. */
function copierInterface(dossier) {
  cpSync(STANDALONE, dossier, { recursive: true, verbatimSymlinks: true });
  const app = join(dossier, "apps", "web");
  cpSync(join(WEB, ".next-autonome", "static"), join(app, ".next-autonome", "static"), {
    recursive: true,
  });
  cpSync(join(WEB, "public"), join(app, "public"), { recursive: true });

  // Next recopie les `.env` qu'il trouve : aucun n'a sa place dans une archive
  // publiée.
  for (const fichier of lister(dossier)) {
    if (/^\.env(\..*)?$/.test(basename(fichier))) {
      arreter(
        `Fichier d'environnement dans l'interface construite : ${relative(dossier, fichier)}`,
      );
    }
  }
}

/** Les modules de démarrage de la version, le lanceur et les racines Passenger. */
function copierDemarrage(version, racineArchive) {
  const source = join(RACINE, "infra", "cpanel");
  const demarrage = join(version, "demarrage");
  mkdirSync(demarrage, { recursive: true });
  for (const nom of [
    "admin.cjs",
    "api.cjs",
    "interface.cjs",
    "entetes.cjs",
    "emplacements.cjs",
    "lanceur.cjs",
  ]) {
    cpSync(join(source, nom), join(demarrage, nom));
  }

  const passenger = join(racineArchive, "passenger");
  cpSync(join(source, "lanceur.cjs"), join(passenger, "lanceur.cjs"));
  writeFileSync(
    join(passenger, "admin.cjs"),
    "// Crée un administrateur : node admin.cjs <email> <prénom> <nom>\n" +
      'require(require("./lanceur.cjs").commande("admin"));\n',
  );
  for (const role of ["api", "interface"]) {
    mkdirSync(join(passenger, role), { recursive: true });
    writeFileSync(
      join(passenger, role, "app.cjs"),
      "// Racine d'application Passenger : tout le reste suit etat.json.\n" +
        `require("../lanceur.cjs").lancer(${JSON.stringify(role)});\n`,
    );
  }
}

function ecrireRelease(version) {
  const buildId = readFileSync(join(WEB, ".next-autonome", "BUILD_ID"), "utf8").trim();
  const lignes = [
    `version=${VERSION}`,
    `commit=${git("rev-parse", "HEAD")}`,
    `date=${git("show", "-s", "--format=%cI", "HEAD")}`,
    `node=${process.version}`,
    `build_id=${buildId}`,
    // Le dépôt dont la version suivante sera tirée (src/modules/updates).
    `depot=${process.env.GITHUB_REPOSITORY ?? "PowerNexus/PowerDashboard"}`,
  ];
  writeFileSync(join(version, "RELEASE"), `${lignes.join("\n")}\n`);
}

function* lister(dossier) {
  for (const entree of readdirSync(dossier, { withFileTypes: true })) {
    const chemin = join(dossier, entree.name);
    if (entree.isDirectory()) yield* lister(chemin);
    else yield chemin;
  }
}

function git(...args) {
  return execFileSync("git", args, { cwd: RACINE, encoding: "utf8" }).trim();
}

function arreter(message) {
  console.error(message);
  process.exit(1);
}
