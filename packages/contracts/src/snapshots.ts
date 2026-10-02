import { z } from "zod";

/**
 * Instantanés de volumes (ADR 0009).
 *
 * Pris par l'agent de node sur tout `system.data` (btrfs ou ZFS), jamais par
 * le panel ni par Wings. Le panel tient le registre, les réglages et les
 * ordres ; il n'envoie à l'agent que des données, validées de son côté par
 * les mêmes bornes (`agent/internal/instantanes/protocole.go`).
 */

/** Seul nom accepté : celui que l'agent a lui-même tiré. */
export const SNAPSHOT_NAME = /^gd-\d{8}T\d{6}\.\d{3}Z$/;
export const SnapshotName = z.string().regex(SNAPSHOT_NAME);

/**
 * Un instantané manuel ou de sûreté échappe à la rotation pendant ce délai,
 * sans être épinglé : il a été pris pour quelqu'un, qui doit avoir le temps
 * de s'en servir. Jamais au-delà de la durée maximale du node.
 */
export const SNAPSHOT_REQUESTED_KEEP_HOURS = 24;

/**
 * Attente de l'instantané de sûreté avant une restauration de sauvegarde :
 * deux relevés de l'agent (15 s chacun) et de la marge. Au-delà, la
 * restauration part sans lui, et le journal du serveur le dit.
 */
export const BACKUP_SAFETY_WAIT_MS = 40_000;

/**
 * Ce qu'un client attend la réponse à une restauration de sauvegarde :
 * l'instantané de sûreté, puis l'ordre à Wings. Le délai ordinaire (dix
 * secondes) faisait dire « délai dépassé » à une restauration qui partait
 * pourtant, dès que l'agent tardait.
 */
export const BACKUP_RESTORE_TIMEOUT_MS = BACKUP_SAFETY_WAIT_MS + 30_000;

/** Clé de `settings` qui porte les valeurs par défaut, hors du catalogue. */
export const SNAPSHOT_DEFAULTS_SETTING_KEY = "snapshots.defaults";

/* --- Réglages --------------------------------------------------------------- */

/** Bornes imposées aussi par l'agent : un panel compromis ne les dépasse pas. */
export const SNAPSHOT_BOUNDS = {
  levelsMax: 8,
  intervalMinutesMin: 5,
  maxAgeDaysMax: 90,
  freeSpaceMin: 5,
  freeSpaceMax: 95,
  coalesceSecondsMax: 600,
  cooldownMinutesMax: 1440,
  pinLimitMax: 100,
} as const;

export const SnapshotLevel = z.object({
  intervalMinutes: z
    .number()
    .int()
    .min(SNAPSHOT_BOUNDS.intervalMinutesMin)
    .max(SNAPSHOT_BOUNDS.maxAgeDaysMax * 24 * 60),
  retentionHours: z
    .number()
    .int()
    .min(1)
    .max(SNAPSHOT_BOUNDS.maxAgeDaysMax * 24),
  enabled: z.boolean(),
});
export type SnapshotLevel = z.infer<typeof SnapshotLevel>;

/**
 * Réglages des instantanés d'un node, tous dans l'interface (exigence de
 * Matheo) : Administration › Nodes › *node* › Instantanés, avec des valeurs
 * par défaut dans Administration › Paramètres.
 */
export const SnapshotPolicy = z
  .object({
    enabled: z.boolean(),
    levels: z.array(SnapshotLevel).max(SNAPSHOT_BOUNDS.levelsMax),
    manualAllowed: z.boolean(),
    manualCooldownMinutes: z.number().int().min(0).max(SNAPSHOT_BOUNDS.cooldownMinutesMax),
    coalesceSeconds: z.number().int().min(0).max(SNAPSHOT_BOUNDS.coalesceSecondsMax),
    maxAgeDays: z.number().int().min(1).max(SNAPSHOT_BOUNDS.maxAgeDaysMax),
    freeSpaceThresholdPct: z
      .number()
      .int()
      .min(SNAPSHOT_BOUNDS.freeSpaceMin)
      .max(SNAPSHOT_BOUNDS.freeSpaceMax),
    defaultPinLimit: z.number().int().min(0).max(SNAPSHOT_BOUNDS.pinLimitMax),
    s3FromSnapshot: z.boolean(),
  })
  .superRefine((policy, ctx) => {
    policy.levels.forEach((level, index) => {
      if (level.retentionHours * 60 < level.intervalMinutes) {
        ctx.addIssue({
          code: "custom",
          path: ["levels", index, "retentionHours"],
          message: `Niveau ${index + 1} : la rétention doit couvrir au moins un intervalle.`,
        });
      }
      if (level.retentionHours > policy.maxAgeDays * 24) {
        ctx.addIssue({
          code: "custom",
          path: ["levels", index, "retentionHours"],
          message: `Niveau ${index + 1} : la rétention dépasse la durée maximale d'un instantané.`,
        });
      }
    });
  });
export type SnapshotPolicy = z.infer<typeof SnapshotPolicy>;

/** Les défauts de l'ADR 0009, « Tout se règle dans l'interface ». */
export const DEFAULT_SNAPSHOT_POLICY: SnapshotPolicy = {
  enabled: true,
  levels: [
    { intervalMinutes: 60, retentionHours: 24, enabled: true },
    { intervalMinutes: 24 * 60, retentionHours: 7 * 24, enabled: true },
  ],
  manualAllowed: true,
  manualCooldownMinutes: 5,
  coalesceSeconds: 60,
  maxAgeDays: 30,
  freeSpaceThresholdPct: 15,
  defaultPinLimit: 3,
  s3FromSnapshot: true,
};

/** Des réglages lus en base, ramenés aux défauts s'ils ne valent plus. */
export function resolveSnapshotPolicy(raw: unknown): SnapshotPolicy {
  const parsed = SnapshotPolicy.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_SNAPSHOT_POLICY;
}

/* --- Contrat avec l'agent ------------------------------------------------- */

export const AGENT_SNAPSHOT_PATHS = {
  state: "snapshots",
  report: "snapshots/report",
  backup: "snapshots/backups/:backupId",
} as const;

export const AgentOrderKind = z.enum(["prendre", "restaurer", "detruire", "archiver"]);
export type AgentOrderKind = z.infer<typeof AgentOrderKind>;

export interface AgentSnapshotSettings {
  actif: boolean;
  niveaux: { intervalle_s: number; retention_s: number }[];
  duree_max_s: number;
  seuil_libre_pct: number;
  regroupement_s: number;
}

export interface AgentSnapshotOrder {
  id: string;
  type: AgentOrderKind;
  serveur?: string;
  instantane?: string;
  sauvegarde?: string;
  exclusions?: string;
}

/** `GET /api/node-agent/snapshots`. */
export interface AgentSnapshotState {
  reglages: AgentSnapshotSettings;
  gardes: string[];
  ordres: AgentSnapshotOrder[];
}

/**
 * Traduit les réglages d'un node en ce que l'agent applique.
 *
 * `active` : la fonction est offerte et allumée pour ce node. Éteinte,
 * l'agent ne prend plus rien de lui-même, mais garde ses instantanés tant
 * que la rotation les garde.
 */
export function agentSettingsFromPolicy(
  policy: SnapshotPolicy,
  active: boolean,
): AgentSnapshotSettings {
  return {
    actif: active && policy.enabled,
    niveaux: policy.levels
      .filter((level) => level.enabled)
      .map((level) => ({
        intervalle_s: level.intervalMinutes * 60,
        retention_s: level.retentionHours * 3600,
      })),
    duree_max_s: policy.maxAgeDays * 86_400,
    seuil_libre_pct: policy.freeSpaceThresholdPct,
    regroupement_s: policy.coalesceSeconds,
  };
}

/** Le format que l'agent vérifie lui-même (`UUIDValide`), sans exiger de version. */
const Uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
/** Go écrit `null` pour une liste vide. */
const list = <T extends z.ZodTypeAny>(item: T, max: number) =>
  z
    .array(item)
    .max(max)
    .nullish()
    .transform((value) => value ?? []);

/** `POST /api/node-agent/snapshots/report`. */
export const AgentSnapshotReport = z.object({
  version: z.string().max(32),
  systeme: z.enum(["btrfs", "zfs", ""]),
  motif: z.string().max(1000).optional(),
  espace: z
    .object({
      total: z.number().int().nonnegative(),
      libre: z.number().int().nonnegative(),
    })
    .nullish(),
  suspendu: z.boolean(),
  instantanes: list(
    z.object({
      nom: SnapshotName,
      pris_le: z.string().datetime({ offset: true }),
      serveurs: list(Uuid, 10_000),
      octets: z.number().int().nonnegative().nullish(),
    }),
    5000,
  ),
  ordres: list(
    z.object({
      id: Uuid,
      etat: z.enum(["reussi", "echoue"]),
      instantane: SnapshotName.optional(),
      erreur: z.string().max(2000).optional(),
      depot_commence: z.boolean().optional(),
    }),
    100,
  ),
});
export type AgentSnapshotReport = z.infer<typeof AgentSnapshotReport>;

/* --- Vues ----------------------------------------------------------------- */

export const SnapshotCause = z.enum(["auto", "manual", "safety"]);
export type SnapshotCause = z.infer<typeof SnapshotCause>;

export const SNAPSHOT_CAUSE_LABEL: Record<SnapshotCause, string> = {
  auto: "Automatique",
  manual: "Manuel",
  safety: "De sûreté",
};

export interface ServerSnapshotView {
  name: string;
  takenAt: string;
  cause: SnapshotCause;
  /** Au-delà, l'agent le détruit, épinglé ou non. */
  expiresAt: string;
  pinned: boolean;
  pinLabel: string | null;
  /** Nul quand le système de fichiers ne le dit pas (btrfs). */
  bytes: number | null;
}

/** État de la fonction sur le node du serveur, tel que l'agent le rapporte. */
export interface NodeSnapshotStatus {
  filesystem: "btrfs" | "zfs" | null;
  /** Pourquoi la machine ne peut pas en prendre, dit par l'agent. */
  reason: string | null;
  freeBytes: number | null;
  totalBytes: number | null;
  /** Sous le seuil d'espace libre : rien n'est pris. */
  suspended: boolean;
  reportedAt: string | null;
}

export interface ServerSnapshotsMeta {
  status: NodeSnapshotStatus;
  /** Les écritures sont acceptées (agent qui parle, fonction allumée). */
  writable: boolean;
  manualAllowed: boolean;
  pinLimit: number;
  pinned: number;
  /** Une prise demandée et pas encore faite. */
  pending: boolean;
  /** Avant quand une nouvelle demande manuelle sera refusée ; nul si libre. */
  nextManualAt: string | null;
}

/** Libellé de l'onglet : un instantané ne remplace pas une sauvegarde. */
export const SNAPSHOT_WARNING =
  "Un instantané vit sur le même disque que votre serveur. Il ne remplace pas une sauvegarde.";

export const SnapshotPinInput = z.object({
  label: z.string().trim().max(80).optional(),
});
