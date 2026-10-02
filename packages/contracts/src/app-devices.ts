import { z } from "zod";
import { type CookieEnvironment, cookiesRequireHttps } from "./auth-cookies";

/**
 * Application mobile : liaison d'un appareil à un panel (ADR 0010).
 *
 * L'application est publique et se lie à **n'importe quel** panel
 * auto-hébergé. Elle le reconnaît par son descripteur d'instance, ouvre la
 * connexion dans le navigateur du téléphone (code à usage unique et PKCE),
 * puis parle à l'API comme un *appareil* révocable : un jeton d'accès court,
 * renouvelé par un secret d'appareil que seule une clé non exportable du
 * téléphone sait présenter.
 *
 * Tout ce que l'API, l'interface et l'application doivent dire pareil vit
 * ici : préfixes, durées, messages signés, routes ouvertes à l'application.
 */

/**
 * Jeton d'accès d'un appareil : `gd_mob_…`.
 *
 * Pas `gd_app_` : ce préfixe est celui des clés de l'API applicative
 * (`generateApiKey("app")`), et un même préfixe pour deux natures de jeton
 * ferait mentir l'outil de détection de secrets comme le journal.
 */
export const APP_ACCESS_TOKEN_PREFIX = "gd_mob_";

/** Secret d'appareil : `gd_dev_…`, gardé dans le trousseau du téléphone. */
export const APP_DEVICE_SECRET_PREFIX = "gd_dev_";

/** Jeton d'accès : quinze minutes, puis un renouvellement signé. */
export const APP_ACCESS_TTL_MS = 15 * 60 * 1000;

/** Code d'autorisation : soixante secondes, une seule fois. */
export const APP_LINK_CODE_TTL_MS = 60 * 1000;

/** Un appareil qui ne sert pas pendant trente jours se délie. */
export const APP_DEVICE_IDLE_MS = 30 * 24 * 60 * 60 * 1000;

/** Quatre-vingt-dix jours au plus, puis une nouvelle connexion par le navigateur. */
export const APP_DEVICE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/** Défi de présence : deux minutes pour poser le doigt. */
export const APP_PRESENCE_TTL_MS = 2 * 60 * 1000;

/**
 * Écart toléré entre l'horloge du téléphone et celle du panel pour une
 * signature horodatée. Au-delà, la signature est refusée : elle a pu être
 * captée et rejouée.
 */
export const APP_SIGNATURE_SKEW_MS = 5 * 60 * 1000;

/**
 * Adresse de retour vers l'application, la seule acceptée.
 *
 * Un schéma propre et non un lien universel : l'application publiée déclare
 * ses domaines associés une fois pour toutes, et ne peut donc pas en avoir
 * pour chaque panel auto-hébergé. Le schéma peut être revendiqué par une
 * autre application ; c'est ce que le PKCE neutralise (RFC 8252, §8.1) : un
 * code intercepté ne s'échange pas sans le vérificateur, resté dans
 * l'application qui a ouvert la liaison.
 */
export const APP_REDIRECT_URI = "gamedashboard://liaison";

/**
 * Version du protocole de liaison, annoncée par le descripteur.
 *
 * Elle ne bouge que si l'échange change de forme : l'application sait alors
 * qu'elle parle à un panel trop ancien, ou trop récent, pour elle.
 */
export const APP_PROTOCOL_VERSION = 1;

/** Version la plus ancienne de l'application que ce panel accepte. */
export const APP_MINIMUM_VERSION = "1.0.0";

export const APP_PLATFORMS = ["ios", "android"] as const;
export type AppPlatform = (typeof APP_PLATFORMS)[number];

/** Nom d'appareil : ce que le téléphone dit de lui, sans caractère de contrôle. */
export const appDeviceNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine((value) => !/\p{Cc}/u.test(value), "Nom d'appareil invalide.");

/** Défi PKCE S256 : SHA-256 du vérificateur, en base64url sans remplissage. */
export const pkceChallengeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** Vérificateur PKCE (RFC 7636, §4.1) : 43 à 128 caractères non réservés. */
export const pkceVerifierSchema = z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/);

/** `state` de la liaison : rendu tel quel à l'application, jamais lu par le panel. */
export const appStateSchema = z.string().regex(/^[A-Za-z0-9._~-]{16,128}$/);

/** Clé publique d'appareil P-256, en base64 (SPKI DER, ou point brut de 65 octets). */
const publicKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9+/_-]+={0,2}$/)
  .max(256);

/** Signature ECDSA P-256 / SHA-256, DER, en base64 ou base64url. */
const signatureSchema = z
  .string()
  .regex(/^[A-Za-z0-9+/_-]+={0,2}$/)
  .max(200);

/** Instant de signature, en millisecondes depuis l'époque. */
const signedAtSchema = z.number().int().positive();

/** Ce que la page de liaison reçoit de l'application, dans l'adresse. */
export const appAuthorizeQuerySchema = z.object({
  code_challenge: pkceChallengeSchema,
  code_challenge_method: z.literal("S256"),
  state: appStateSchema,
  device_name: appDeviceNameSchema,
  platform: z.enum(APP_PLATFORMS),
  redirect_uri: z.literal(APP_REDIRECT_URI),
});
export type AppAuthorizeQuery = z.infer<typeof appAuthorizeQuerySchema>;

/**
 * Cookie qui garde la demande de liaison pendant la connexion.
 *
 * La page de connexion ne sait pas où revenir : toutes ses voies (mot de
 * passe, second facteur, clé d'accès, Google, annuaire) mènent à l'accueil,
 * qui reprend la liaison en attente. Dix minutes, `HttpOnly`, et rien de
 * secret dedans : le défi PKCE est public par construction.
 */
export function appLinkCookieName(env: CookieEnvironment): string {
  return cookiesRequireHttps(env) ? "__Host-gd_app_link" : "gd_app_link";
}

export const APP_LINK_COOKIE_MAX_AGE_S = 10 * 60;

/** `POST /api/v1/auth/app/authorize`, par la session du navigateur. */
export const appAuthorizeBodySchema = z.object({
  codeChallenge: pkceChallengeSchema,
  deviceName: appDeviceNameSchema,
  platform: z.enum(APP_PLATFORMS),
});

/** `POST /api/v1/auth/app/token` : le code contre un appareil. */
export const appTokenBodySchema = z.object({
  code: z.string().min(20).max(100),
  codeVerifier: pkceVerifierSchema,
  publicKey: publicKeySchema,
  appVersion: z.string().max(32).optional(),
  signedAt: signedAtSchema,
  signature: signatureSchema,
});

/** `POST /api/v1/auth/app/refresh` : le secret contre un nouveau jeton. */
export const appRefreshBodySchema = z.object({
  deviceId: z.uuid(),
  deviceSecret: z.string().startsWith(APP_DEVICE_SECRET_PREFIX).max(100),
  appVersion: z.string().max(32).optional(),
  signedAt: signedAtSchema,
  signature: signatureSchema,
});

/** Ce que rendent l'échange et le renouvellement. */
export interface AppDeviceGrant {
  deviceId: string;
  accessToken: string;
  accessExpiresAt: string;
  /** À ranger à la place du précédent, qui ne vaut plus rien. */
  deviceSecret: string;
  /** Au-delà, il faut repasser par le navigateur. */
  deviceExpiresAt: string;
}

/** Un appareil lié, tel que Compte › Sécurité le liste. */
export interface AppDeviceSummary {
  id: string;
  name: string;
  platform: AppPlatform;
  appVersion: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  lastIp: string | null;
  expiresAt: string;
}

/*
 * Messages signés par la clé d'appareil.
 *
 * Chacun commence par son usage : une signature faite pour un renouvellement
 * ne vaut jamais pour une liaison ni pour un geste, même avec les mêmes
 * valeurs. Les champs sont séparés par un saut de ligne, qu'aucun d'eux ne
 * peut contenir.
 */

export function appLinkMessage(input: { code: string; publicKey: string; signedAt: number }) {
  return ["gamedashboard-app-link-v1", input.code, input.publicKey, String(input.signedAt)].join(
    "\n",
  );
}

/**
 * Message du renouvellement.
 *
 * Il porte le condensat du secret présenté : une signature captée ne sert
 * qu'avec ce secret-là, qui ne vaut plus rien dès le renouvellement suivant.
 */
export function appRefreshMessage(input: {
  deviceId: string;
  secretSha256: string;
  signedAt: number;
}) {
  return [
    "gamedashboard-app-refresh-v1",
    input.deviceId,
    input.secretSha256,
    String(input.signedAt),
  ].join("\n");
}

/**
 * Message d'une confirmation de présence.
 *
 * Il nomme le geste (verbe et chemin exact) : un défi signé pour restaurer
 * une sauvegarde ne permet pas d'en supprimer une autre.
 */
export function appPresenceMessage(input: {
  deviceId: string;
  challenge: string;
  method: string;
  path: string;
}) {
  return [
    "gamedashboard-app-presence-v1",
    input.deviceId,
    input.challenge,
    `${input.method.toUpperCase()} ${input.path}`,
  ].join("\n");
}

/** En-tête de la confirmation de présence : `<défi>.<signature>`. */
export const APP_PRESENCE_HEADER = "x-gd-presence";

/** Ce que l'API répond quand un geste attend la confirmation de présence. */
export const APP_PRESENCE_REQUIRED = "presence_required";

/*
 * Ce que l'application peut atteindre.
 *
 * Une liste d'autorisation, pas d'interdiction : une route ajoutée demain à
 * l'administration reste fermée à l'application tant qu'on ne l'a pas
 * ouverte ici. Les chemins sont ceux du routeur (`:id`), verbe compris.
 */

interface AppRoute {
  method: string;
  /** Gabarit du routeur, tel que Nest le déclare (`/api/v1/admin/…/:id`). */
  path: string;
}

/**
 * Routes de revendeur et d'administration ouvertes à l'application.
 *
 * Vide tant que les espaces revendeur (lot 5) et administration simple
 * (lot 6) n'existent pas dans l'application : aujourd'hui, le personnel n'y
 * fait que ce que fait un client. Toute écriture qui y entrera demandera la
 * confirmation de présence (`appNeedsPresence`).
 */
export const APP_STAFF_ROUTES: readonly AppRoute[] = [];

/**
 * Gestes lourds de l'espace client : ils exigent la confirmation de présence
 * quand ils viennent de l'application (biométrie, puis défi signé).
 */
export const APP_PRESENCE_ROUTES: readonly AppRoute[] = [
  { method: "POST", path: "/api/v1/client/servers/:id/backups/:backupId/restore" },
  { method: "DELETE", path: "/api/v1/client/servers/:id/backups/:backupId" },
  { method: "POST", path: "/api/v1/client/servers/:id/files/delete" },
  { method: "POST", path: "/api/v1/client/servers/:id/settings/reinstall" },
  { method: "POST", path: "/api/v1/client/servers/:id/snapshots/:name/restore" },
  { method: "DELETE", path: "/api/v1/client/servers/:id/databases/:databaseId" },
];

/** Préfixes que l'application atteint en client, au nom du compte. */
const APP_CLIENT_PREFIXES = ["/api/v1/client/"];

/** Routes de compte que l'application emploie. */
const APP_ACCOUNT_ROUTES: readonly AppRoute[] = [
  { method: "GET", path: "/api/v1/auth/me" },
  { method: "POST", path: "/api/v1/auth/app/challenge" },
  { method: "DELETE", path: "/api/v1/auth/app/device" },
  { method: "PUT", path: "/api/v1/auth/app/push" },
  { method: "DELETE", path: "/api/v1/auth/app/push" },
];

const STAFF_PREFIXES = ["/api/v1/admin/", "/api/v1/reseller/"];

function same(route: AppRoute, method: string, path: string): boolean {
  return route.method === method.toUpperCase() && route.path === path;
}

/**
 * L'application peut-elle atteindre cette route ?
 *
 * `routePath` est le gabarit du routeur, jamais l'adresse reçue : un
 * `/api/v1/client/../admin` n'atteint pas ce contrôle sous une forme qu'il
 * prendrait pour une route client.
 */
export function appMayReach(method: string, routePath: string): boolean {
  if (APP_STAFF_ROUTES.some((route) => same(route, method, routePath))) return true;
  if (STAFF_PREFIXES.some((prefix) => routePath.startsWith(prefix))) return false;
  if (APP_ACCOUNT_ROUTES.some((route) => same(route, method, routePath))) return true;
  return APP_CLIENT_PREFIXES.some((prefix) => routePath.startsWith(prefix));
}

/** Ce geste, venu de l'application, exige-t-il la confirmation de présence ? */
export function appNeedsPresence(method: string, routePath: string): boolean {
  if (APP_PRESENCE_ROUTES.some((route) => same(route, method, routePath))) return true;
  const writes = !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
  return writes && APP_STAFF_ROUTES.some((route) => same(route, method, routePath));
}

/**
 * Descripteur d'instance, servi à `/.well-known/gamedashboard`.
 *
 * Public et sans secret : l'application le lit avant toute connexion pour
 * savoir qu'elle parle à un panel GameDashboard, et lequel. Les clés sont
 * celles de l'ADR 0010. L'application ignore les champs qu'elle ne connaît
 * pas : c'est la place réservée à une future preuve de licence, qui n'est
 * pas conçue ici.
 */
export interface InstanceDescriptor {
  produit: "gamedashboard";
  /** Version du protocole de liaison (`APP_PROTOCOL_VERSION`). */
  api: number;
  /** Version du panel, quand elle est connue (`null` en développement). */
  version: string | null;
  version_app_minimale: string;
  /** Tiré au hasard une fois, jamais réutilisé : il change si le panel est réinstallé. */
  instance: string;
  /** Nom de la marque du domaine interrogé. */
  nom: string;
  /** Origine que Wings attend pour la console (`PANEL_ORIGIN`). */
  origine: string;
  /** Mode des notifications poussées (`pushMode`). */
  notifications: "direct" | "relais" | "aucune";
  /**
   * En mode `relais` : l'adresse du relais, que l'application ne suit que si
   * c'est celui de son éditeur, et la clé publique Ed25519 du panel auprès
   * de lui, qui prouve au relais que l'instance est bien servie ici.
   */
  relais?: string;
  cle_notifications?: string;
}

/** Ce que l'API rend pour composer le descripteur (le nom vient de la marque). */
export type InstanceIdentity = Omit<InstanceDescriptor, "nom">;

/**
 * Lecture du descripteur par l'application.
 *
 * Souple là où il faut l'être : les champs inconnus passent (la place
 * réservée), et `notifications` accepte un mode qu'une version future
 * ajouterait — l'application le traite alors comme `aucune`. Strict sur ce
 * qui engage la liaison : le produit, l'identifiant et l'origine en
 * `https://`.
 */
export const instanceDescriptorSchema = z.looseObject({
  produit: z.literal("gamedashboard"),
  api: z.number().int().nonnegative(),
  version: z.string().max(64).nullable(),
  version_app_minimale: z.string().regex(/^\d+\.\d+\.\d+$/),
  instance: z.string().min(8).max(100),
  nom: z.string().trim().min(1).max(191),
  origine: z
    .url()
    .refine((value) => new URL(value).protocol === "https:", "Origine en https:// attendue."),
  notifications: z.string().max(32),
  relais: z.string().max(255).optional(),
  cle_notifications: z.string().max(200).optional(),
});
