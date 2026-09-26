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
 * paquets de Nest installés.
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
