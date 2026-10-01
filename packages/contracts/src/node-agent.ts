import { z } from "zod";
import { NODE_HEARTBEAT_LOST_MS } from "./node";
import { WINGS_CONFIGURE_PREFIX, withoutTrailingSlashes } from "./wings-node-config";

/**
 * Agent de node (ADR 0008, ADR 0009) : le contrat entre le panel et
 * `gamedashboard-agent`, installé à côté de Wings sur la machine de jeu.
 *
 * L'agent est **facultatif**. Rien de ce que le panel savait faire avant lui
 * n'en dépend : créer, démarrer, transférer un serveur ne le demandent
 * jamais. Seules les fonctions déclarées ici en ont besoin, et
 * `nodeCapabilities()` est la seule règle qui dit, pour un node, lesquelles
 * sont offertes.
 */

/**
 * Préfixe des routes appelées par l'agent.
 *
 * Hors de `/api/v1/` pour la même raison que `/api/remote` : ce sont des
 * routes de machine, derrière un garde de machine, que le vhost et le relais
 * cPanel limitent comme celles du daemon.
 */
export const NODE_AGENT_PREFIX = "/api/node-agent";

/**
 * `gamedashboard-agent configure --panel-url … --token <clé> --node <id>`.
 *
 * Même préfixe, même portée (`nodes.configure`) et même clé d'amorçage que
 * `wings configure` : l'exploitant fait deux fois le même geste.
 */
export function nodeAgentConfigurationPath(nodeId: string): string {
  return `${WINGS_CONFIGURE_PREFIX}/nodes/${nodeId}/agent-configuration`;
}

/**
 * La ligne à recopier sur la machine, pendant de `wingsConfigureCommand` :
 * même clé d'amorçage, même `--node` toujours en option. `--activer` met en
 * marche la fonction voulue dans le même geste.
 */
export function nodeAgentConfigureCommand(input: {
  panelOrigin: string;
  nodeId: string;
  token?: string;
  activer?: NodeAgentFunction;
}): string {
  return [
    "gamedashboard-agent configure",
    `--panel-url ${withoutTrailingSlashes(input.panelOrigin)}`,
    `--token ${input.token ?? "<clé applicative>"}`,
    `--node ${input.nodeId}`,
    ...(input.activer ? [`--activer ${input.activer}`] : []),
  ].join(" ");
}

/** Réponse de la route de configuration, sans enveloppe, comme pour Wings. */
export interface NodeAgentConfiguration {
  uuid: string;
  token_id: string;
  token: string;
  remote: string;
}

/**
 * Au-delà, une fonction de l'agent est dite muette : ses réglages restent
 * lisibles, les écritures qui l'attendent sont refusées. Le même seuil que
 * celui qui fait conclure à un daemon injoignable.
 */
export const NODE_AGENT_SILENT_MS = NODE_HEARTBEAT_LOST_MS;

/**
 * Les fonctions que le panel sait offrir, chacune avec son interrupteur
 * global (Administration › Paramètres › Agent de node).
 *
 * Une fonction s'ajoute ici quand son côté panel existe. Un nom annoncé par
 * l'agent et absent de cette liste est conservé mais n'ouvre rien.
 */
export const NODE_AGENT_FUNCTIONS = {
  instantanes: {
    label: "Instantanés de volumes",
    setting: "agent.instantanes",
  },
} as const satisfies Record<string, { label: string; setting: string }>;

export type NodeAgentFunction = keyof typeof NODE_AGENT_FUNCTIONS;

export const NODE_AGENT_FUNCTION_NAMES = Object.keys(NODE_AGENT_FUNCTIONS) as NodeAgentFunction[];

/** Nom de fonction tel que l'agent peut l'annoncer (`pare-feu`, `maj-wings`…). */
const FunctionName = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);

/** Entrées de journal envoyées par relevé, au plus (l'agent en envoie 200). */
export const NODE_AGENT_JOURNAL_BATCH_MAX = 500;
/** Longueurs gardées d'une entrée : au-delà, le texte est tronqué, pas refusé. */
export const NODE_AGENT_DETAIL_MAX = 2000;
export const NODE_AGENT_EVENT_MAX = 64;

/**
 * Une entrée du journal local de l'agent (SQLite), telle qu'il l'envoie.
 *
 * Seul l'identifiant est exigé : c'est lui qui s'accuse. Tout le reste est
 * ramené à une forme sûre plutôt que refusé, parce qu'une entrée refusée
 * serait renvoyée à chaque relevé et bloquerait toutes celles d'après.
 */
export const NodeAgentJournalEntry = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  horodatage: z.unknown().optional(),
  niveau: z.unknown().optional(),
  fonction: z.unknown().optional(),
  evenement: z.unknown().optional(),
  serveur: z.unknown().optional(),
  detail: z.unknown().optional(),
});
export type NodeAgentJournalEntry = z.infer<typeof NodeAgentJournalEntry>;

/** `POST /api/node-agent/heartbeat`. */
export const NodeAgentHeartbeat = z.object({
  version: z
    .string()
    .max(32)
    .regex(/^[A-Za-z0-9.+_-]*$/),
  /** Fonction du processus qui parle : chaque fonction a son service. */
  fonction: FunctionName,
  /** Fonctions actives dans le `config.yml`. */
  fonctions: z.array(FunctionName).max(16),
  journal: z.array(NodeAgentJournalEntry).max(NODE_AGENT_JOURNAL_BATCH_MAX),
  /** Des entrées sont tombées sur la machine sans avoir été reçues. */
  trou: z.boolean(),
});
export type NodeAgentHeartbeat = z.infer<typeof NodeAgentHeartbeat>;

export interface NodeAgentHeartbeatReply {
  journal_accuse: number;
}

export type NodeAgentLevel = "info" | "alerte" | "erreur";

export interface NormalizedAgentJournalEntry {
  id: number;
  at: string;
  level: NodeAgentLevel;
  function: string;
  event: string;
  server: string | null;
  detail: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Une horloge de machine qui avance de plus que ceci n'est pas crue. */
const CLOCK_SKEW_MS = 5 * 60_000;

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  // Aucun caractère de contrôle : le texte finit à l'écran et dans les exports.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: on les retire du journal.
  const clean = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
  return clean === "" ? null : clean.slice(0, max);
}

/**
 * Ramène une entrée de l'agent à ce que le journal d'activité peut ranger.
 *
 * L'horodatage de la machine est gardé tant qu'il est plausible : c'est lui
 * qui date une panne vécue pendant que le panel était injoignable. Une date
 * illisible ou dans le futur prend l'heure de réception.
 */
export function normalizeAgentJournalEntry(
  entry: NodeAgentJournalEntry,
  now: number = Date.now(),
): NormalizedAgentJournalEntry {
  const stamp = typeof entry.horodatage === "string" ? Date.parse(entry.horodatage) : Number.NaN;
  const at = Number.isFinite(stamp) && stamp <= now + CLOCK_SKEW_MS ? stamp : now;
  const level =
    entry.niveau === "alerte" || entry.niveau === "erreur" ? entry.niveau : ("info" as const);
  const fn = text(entry.fonction, 40);
  const server = text(entry.serveur, 36);
  return {
    id: entry.id,
    at: new Date(at).toISOString(),
    level,
    function: fn && FunctionName.safeParse(fn).success ? fn : "inconnue",
    event: text(entry.evenement, NODE_AGENT_EVENT_MAX) ?? "inconnu",
    server: server && UUID.test(server) ? server.toLowerCase() : null,
    detail: text(entry.detail, NODE_AGENT_DETAIL_MAX),
  };
}

/** L'agent d'un node, tel que la base le connaît ; `null` : pas d'agent. */
export interface NodeAgentSnapshot {
  version: string | null;
  functions: readonly string[];
  functionsSeen: Readonly<Record<string, string>>;
  lastSeenAt: string | null;
}

export const NodeCapabilityState = z.enum([
  "active",
  "silent",
  "absent",
  "node_disabled",
  "platform_disabled",
]);
export type NodeCapabilityState = z.infer<typeof NodeCapabilityState>;

export interface NodeCapability {
  state: NodeCapabilityState;
  /** La fonction est offerte : l'écran la montre, l'API la sert. */
  offered: boolean;
  /** Les écritures qui attendent l'agent sont acceptées. */
  writable: boolean;
  /** Pourquoi elle ne l'est pas, pour l'administration ; nul si active. */
  reason: string | null;
}

export type NodeCapabilities = Record<NodeAgentFunction, NodeCapability>;

const REASONS: Record<Exclude<NodeCapabilityState, "active">, string> = {
  platform_disabled: "Fonction coupée pour toute la plateforme (Administration › Paramètres).",
  absent: "Aucun agent de node n'est installé sur cette machine.",
  node_disabled: "L'agent de cette machine n'a pas cette fonction active dans son config.yml.",
  silent: "La machine ne répond pas : l'agent ne s'est pas manifesté depuis plus de deux minutes.",
};

/**
 * Ce que le panel offre sur un node, fonction par fonction.
 *
 * **La seule règle**, sur le modèle de `nodeOutageBlock()` : l'écran et
 * l'API la lisent tous deux, pour qu'un bouton affiché ne mène jamais à un
 * refus, ni une route servie à un écran qui la cache.
 *
 * - interrupteur global coupé : absente partout, même là où l'agent l'a ;
 * - pas d'agent, ou fonction absente de son `config.yml` : absente sur ce
 *   node, avec la raison pour l'administration ;
 * - agent muet (plus de deux minutes pour **cette** fonction) : offerte en
 *   lecture, écritures refusées (409) ;
 * - sinon, active.
 *
 * `platform` : l'état des interrupteurs globaux ; une fonction absente de
 * l'objet est considérée coupée, pour qu'un oubli ferme la porte.
 */
export function nodeCapabilities(
  agent: NodeAgentSnapshot | null,
  platform: Partial<Record<NodeAgentFunction, boolean>>,
  now: number = Date.now(),
): NodeCapabilities {
  const out = {} as NodeCapabilities;
  for (const name of NODE_AGENT_FUNCTION_NAMES) {
    out[name] = capability(name, agent, platform[name] === true, now);
  }
  return out;
}

function capability(
  name: NodeAgentFunction,
  agent: NodeAgentSnapshot | null,
  enabled: boolean,
  now: number,
): NodeCapability {
  let state: NodeCapabilityState;
  if (!enabled) state = "platform_disabled";
  else if (!agent) state = "absent";
  else if (!agent.functions.includes(name)) state = "node_disabled";
  else {
    const seen = Date.parse(agent.functionsSeen[name] ?? "");
    state = Number.isFinite(seen) && now - seen <= NODE_AGENT_SILENT_MS ? "active" : "silent";
  }
  return {
    state,
    offered: state === "active" || state === "silent",
    writable: state === "active",
    reason: state === "active" ? null : REASONS[state],
  };
}

/** État d'ensemble de l'agent d'un node, pour la fiche d'administration. */
export type NodeAgentStatus = "none" | "online" | "silent";

export function nodeAgentStatus(
  agent: NodeAgentSnapshot | null,
  now: number = Date.now(),
): NodeAgentStatus {
  if (!agent) return "none";
  const seen = agent.lastSeenAt ? Date.parse(agent.lastSeenAt) : Number.NaN;
  return Number.isFinite(seen) && now - seen <= NODE_AGENT_SILENT_MS ? "online" : "silent";
}

/** `GET /api/v1/admin/nodes/:nodeId/agent`. */
export interface AdminNodeAgentView {
  status: NodeAgentStatus;
  version: string | null;
  functions: string[];
  lastSeenAt: string | null;
  tokenIssuedAt: string | null;
  capabilities: NodeCapabilities;
  /** Chemin de la route que `gamedashboard-agent configure` appelle. */
  configurationPath: string;
}
