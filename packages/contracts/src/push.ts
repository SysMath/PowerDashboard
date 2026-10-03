import { z } from "zod";
import { NOTIFICATION_EVENTS } from "./notifications-catalogue";

/*
 * Notifications poussées vers l'application mobile (ADR 0010, lot 4).
 *
 * Le droit d'écrire à l'application appartient à son éditeur : un panel n'a
 * jamais de quoi parler lui-même aux services d'Apple et de Google. Il passe
 * par Expo Push, directement s'il détient le jeton d'accès Expo de l'éditeur
 * (`direct`), sinon par le relais de l'éditeur (`relais`), qui garde ce
 * jeton seul. `aucune` : l'application relève la boîte à l'ouverture.
 */

export const PUSH_MODES = ["direct", "relais", "aucune"] as const;
export type PushMode = (typeof PUSH_MODES)[number];

/**
 * Mode des notifications de ce panel, tiré de son environnement.
 *
 * `PUSH_MODE=aucune` l'emporte : un exploitant peut refuser le relais. Puis
 * le jeton Expo (`direct`), puis l'adresse d'un relais (`relais`).
 */
export function pushMode(env: {
  PUSH_MODE?: string;
  EXPO_ACCESS_TOKEN?: string;
  PUSH_RELAY_URL?: string;
}): PushMode {
  if (env.PUSH_MODE?.trim() === "aucune") return "aucune";
  if (env.EXPO_ACCESS_TOKEN?.trim()) return "direct";
  return pushRelayUrl(env) ? "relais" : "aucune";
}

/** L'adresse du relais, en `https://` seulement, sans barre finale ; `null` sinon. */
export function pushRelayUrl(env: { PUSH_RELAY_URL?: string }): string | null {
  const brute = env.PUSH_RELAY_URL?.trim();
  if (!brute) return null;
  try {
    const url = new URL(brute);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      return null;
    }
    return url.href.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** Jeton d'appareil d'Expo Push, tel que l'application le reçoit. */
export const EXPO_PUSH_TOKEN = /^Expo(?:nent)?PushToken\[[A-Za-z0-9_-]{8,128}\]$/;

/** Poignée rendue par le relais : 32 octets au hasard, en base64url. */
export const PUSH_RELAY_HANDLE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Ce que l'application dépose au panel pour recevoir ses notifications :
 * son jeton Expo en mode `direct`, sa poignée du relais en mode `relais`.
 * Le panel n'accepte que le mode qu'il sert.
 */
export const appPushBodySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("direct"), poignee: z.string().regex(EXPO_PUSH_TOKEN) }),
  z.object({ mode: z.literal("relais"), poignee: z.string().regex(PUSH_RELAY_HANDLE) }),
]);
export type AppPushBody = z.infer<typeof appPushBodySchema>;

/* --- Contenu ---------------------------------------------------------------- */

/** Au-delà, un nom de serveur est coupé : rien d'autre ne voyage. */
export const PUSH_SERVER_NAME_MAX = 64;

const TYPES = new Set(NOTIFICATION_EVENTS.map((event) => event.type));

/** Un type que le panel émet vraiment : aucun autre texte ne part. */
export function isPushType(type: string): boolean {
  return TYPES.has(type);
}

/**
 * Une notification poussée, au format fermé de l'ADR (réponse 5) : le type
 * d'événement, le nom du serveur et l'identifiant de la notification. Ni
 * adresse, ni ligne de console, ni nom de fichier, ni détail de sécurité :
 * Apple, Google, Expo et le relais ne voient que cela. Le texte complet se
 * lit dans l'application, par l'API, une fois déverrouillée.
 */
export const pushMessageSchema = z.object({
  type: z.string().refine(isPushType, "Type de notification inconnu."),
  serveur: z.string().trim().min(1).max(PUSH_SERVER_NAME_MAX).nullable(),
  notification: z.uuid(),
  langue: z.enum(["fr", "en"]),
});
export type PushMessage = z.infer<typeof pushMessageSchema>;

/** Le nom d'un serveur ramené à ce qui voyage. */
export function pushServerName(nom: string | null | undefined): string | null {
  const propre = nom?.replace(/\s+/g, " ").trim();
  return propre ? propre.slice(0, PUSH_SERVER_NAME_MAX) : null;
}

/* --- Relais ----------------------------------------------------------------- */

/** Envois acceptés par appel au relais, comme Expo par requête. */
export const PUSH_RELAY_BATCH = 100;

/** Écart toléré entre l'horloge du panel et celle du relais. */
export const PUSH_RELAY_CLOCK_SKEW_MS = 5 * 60_000;

/** En-tête de la signature Ed25519 d'un panel, en base64. */
export const PUSH_RELAY_SIGNATURE_HEADER = "x-gd-signature";

/** Identifiant d'instance : celui du descripteur (`instanceId`). */
const instance = z.string().min(8).max(100);

/**
 * Un panel s'enregistre : son identifiant, sa clé publique Ed25519 (SPKI DER,
 * base64) et son origine. Le relais lit le descripteur à cette origine et
 * n'accepte la clé que si le panel l'y publie (`cle_notifications`) : un
 * identifiant d'instance est public, et le premier venu ne doit pas pouvoir
 * s'en emparer.
 */
export const pushRelayRegisterSchema = z.object({
  instance,
  cle: z.string().min(40).max(200),
  origine: z
    .url()
    .max(255)
    .refine((value) => new URL(value).protocol === "https:", "Origine en https:// attendue."),
});

/** L'application inscrit son jeton Expo pour une instance, et reçoit une poignée. */
export const pushRelayHandleSchema = z.object({
  instance,
  jeton: z.string().regex(EXPO_PUSH_TOKEN),
});

/**
 * Un envoi d'un panel : signé (Ed25519, corps brut) et daté, pour qu'un
 * envoi capté ne se rejoue pas au-delà de quelques minutes.
 */
export const pushRelaySendSchema = z.object({
  instance,
  horodatage: z.number().int().positive(),
  messages: z
    .array(pushMessageSchema.extend({ poignee: z.string().regex(PUSH_RELAY_HANDLE) }))
    .min(1)
    .max(PUSH_RELAY_BATCH),
});
export type PushRelaySend = z.infer<typeof pushRelaySendSchema>;

/**
 * Issue d'un envoi, message par message, dans l'ordre : `inconnue` dit au
 * panel d'oublier la poignée (appareil désinstallé, ou poignée d'une autre
 * instance), `reessayer` qu'il peut la reprendre plus tard.
 */
export type PushOutcome = "envoyee" | "inconnue" | "reessayer";

/**
 * Le texte que signe un panel pour un envoi : chaque champ dans un ordre
 * fixe, pour que le relais recompose exactement ce qui a été signé à partir
 * du JSON reçu, quel que soit l'ordre de ses clés.
 */
export function pushRelaySignedText(envoi: PushRelaySend): string {
  const messages = envoi.messages.map((m) => [
    m.poignee,
    m.type,
    m.serveur,
    m.notification,
    m.langue,
  ]);
  return [
    "gamedashboard-relais-v1",
    envoi.instance,
    String(envoi.horodatage),
    JSON.stringify(messages),
  ].join("\n");
}
