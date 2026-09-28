import { join } from "node:path";
import { build } from "esbuild";

/**
 * Ce qui reste **hors** de l'API regroupée par esbuild (`autonome.mjs`).
 *
 * Le module natif d'argon2, copié à côté, et les pairs facultatifs que Nest
 * cherche à la demande sans les exiger (microservices, websockets, Express,
 * validation par classes, et pour l'adaptateur Fastify : fichiers statiques,
 * gabarits, envoi de fichiers en plusieurs parties). Absents ici comme dans
 * node_modules : esbuild, qui ne sait pas qu'ils sont facultatifs, refuserait
 * de regrouper sans eux.
 *
 * Chaque montée de NestJS peut en ajouter un (`@fastify/multipart` est venu
 * avec `@nestjs/platform-fastify` 12.1.0, et cassait la release) :
 * `infra-prod.test.ts` compare cette liste aux `peerDependenciesMeta` des
 * paquets de Nest installés, et regroupe l'API pour de bon (`regrouperApi`).
 */
export const EXTERNES_API = [
  "@node-rs/argon2",
  "@nestjs/microservices",
  "@nestjs/microservices/*",
  "@nestjs/platform-express",
  "@nestjs/websockets",
  "@nestjs/websockets/*",
  "class-transformer",
  "class-transformer/*",
  "class-validator",
  "@fastify/static",
  "@fastify/view",
  "@fastify/multipart",
];

/**
 * Regroupe l'API comme l'archive autonome l'embarque : `main.cjs` et
 * `migrer.cjs` en CommonJS, `creer-admin.mjs` en ESM (elle attend au premier
 * niveau, et prend un `require` pour les dépendances en CommonJS).
 *
 * Sans `dossier`, rien ne s'écrit : c'est l'essai de `infra-prod.test.ts`,
 * qui voit ainsi tout import qu'esbuild ne sait pas résoudre, d'où qu'il
 * vienne, sans attendre une release — ci.yml ne construit pas l'archive.
 */
export async function regrouperApi(api, dossier) {
  const commun = {
    absWorkingDir: api,
    outdir: dossier ?? join(api, "dist-essai-autonome"),
    write: dossier !== undefined,
    bundle: true,
    platform: "node",
    target: "node24",
    tsconfig: join(api, "tsconfig.json"),
    keepNames: true,
    legalComments: "linked",
    external: EXTERNES_API,
    logLevel: dossier === undefined ? "silent" : "warning",
  };
  await build({
    ...commun,
    entryPoints: { main: "src/main.ts", migrer: "src/migrate.ts" },
    outExtension: { ".js": ".cjs" },
    format: "cjs",
    // `new Reply(…)` sur un espace de noms : c'est le code de Nest lui-même
    // (@nestjs/platform-fastify, en ESM), qui se comporte de même sous tsx.
    logOverride: { "call-import-namespace": "silent" },
  });
  await build({
    ...commun,
    entryPoints: { "creer-admin": "scripts/create-admin.mts" },
    outExtension: { ".js": ".mjs" },
    format: "esm",
    banner: {
      js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    },
  });
}
