import { z } from "zod";

/**
 * Consommation exportable des serveurs (PLAN §10.3).
 *
 * Le panel relève chaque minute ce que Wings dit de chaque conteneur
 * (`server_metrics`, trente jours). Un facturier n'a que faire de la minute :
 * il facture des journées, et il lui faut encore celles du mois dernier quand
 * il clôt. Le panel en tient donc un **résumé par jour et par serveur**
 * (`server_consumption_days`, treize mois), et c'est ce résumé qui s'exporte :
 *
 * - en CSV ou en JSON par lignes, depuis l'administration, l'espace revendeur
 *   et la page d'un serveur ;
 * - en JSON paginé, par l'API applicative (portée `consumption.read`).
 *
 * Les jours sont ceux du **temps universel**. La journée en cours est rendue,
 * marquée `complete: false` : elle se recalcule chaque heure et n'est pas
 * encore facturable.
 */

/** Horizon gardé : treize mois, pour comparer un mois à celui de l'an passé. */
export const CONSUMPTION_RETENTION_DAYS = 400;

/** Plus longue période demandée d'un coup : une année, bissextile comprise. */
export const CONSUMPTION_MAX_SPAN_DAYS = 366;

/** Lignes par page de l'API applicative, et par bloc lu pour un export. */
export const CONSUMPTION_PAGE_SIZE = 1000;

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Une date `AAAA-MM-JJ` qui existe au calendrier : le 2026-02-30 est refusé, pas reporté. */
export const ConsumptionDayString = z
  .string()
  .regex(DAY_PATTERN, "Date attendue au format AAAA-MM-JJ.")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "Cette date n'existe pas.");

/** Le jour UTC d'un instant, au format `AAAA-MM-JJ`. */
export function utcDay(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/** Décale un jour `AAAA-MM-JJ` de `days` jours. */
export function shiftDay(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return utcDay(date);
}

/**
 * Formats de téléchargement.
 *
 * Les mêmes que l'export du journal, pour la même raison : `jsonl` plutôt
 * qu'un tableau JSON, qu'un téléchargement interrompu rendrait illisible en
 * entier.
 */
export const ConsumptionExportFormat = z.enum(["csv", "jsonl"]);
export type ConsumptionExportFormat = z.infer<typeof ConsumptionExportFormat>;

/** Un paramètre vide (`?serverId=`) vaut « pas de filtre », pas un identifiant vide. */
const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

/**
 * La période et les filtres d'une lecture.
 *
 * Sans période, **le mois en cours** jusqu'à aujourd'hui : c'est ce que
 * demande presque toujours celui qui ouvre l'écran. Une période plus longue
 * qu'une année, ou qui finit avant de commencer, est refusée, pas raccourcie :
 * un script qui demande deux ans doit l'apprendre, et non recevoir un an en
 * croyant en lire deux.
 */
export const ConsumptionQuery = z.object({
  from: optional(ConsumptionDayString),
  to: optional(ConsumptionDayString),
  serverId: optional(z.string().uuid("Identifiant de serveur invalide.")),
  ownerId: optional(z.string().uuid("Identifiant de compte invalide.")),
});
export type ConsumptionQuery = z.infer<typeof ConsumptionQuery>;

export const ConsumptionExportQuery = ConsumptionQuery.extend({
  format: optional(ConsumptionExportFormat).transform((value) => value ?? "csv"),
});

/** Page de l'API applicative : à partir de 1. */
export const ConsumptionPageQuery = ConsumptionQuery.extend({
  page: optional(z.coerce.number().int().min(1).max(100_000)).transform((value) => value ?? 1),
});

export interface ConsumptionPeriod {
  from: string;
  to: string;
}

/**
 * La période effective, ou le motif du refus.
 *
 * Rendue plutôt que levée : l'API la traduit en 400, l'écran en message sous
 * le formulaire, et aucun des deux n'a à attraper une exception de `contracts`.
 */
export function consumptionPeriod(
  query: { from?: string; to?: string },
  now: Date = new Date(),
): { period: ConsumptionPeriod } | { error: string } {
  const today = utcDay(now);
  const to = query.to ?? today;
  const from = query.from ?? `${to.slice(0, 8)}01`;

  if (from > to) return { error: "La période finit avant de commencer." };
  const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
  if (span > CONSUMPTION_MAX_SPAN_DAYS) {
    return {
      error: `Période trop longue : ${CONSUMPTION_MAX_SPAN_DAYS} jours au plus par demande.`,
    };
  }
  return { period: { from, to } };
}

/**
 * Une journée d'un serveur.
 *
 * Unités brutes — octets, pourcentages d'un cœur — et jamais arrondies en
 * gigaoctets : c'est au facturier de choisir son unité, et un arrondi fait ici
 * se retrouverait multiplié par trente sur la facture.
 *
 * `null` dit « pas mesuré », jamais zéro : un serveur éteint toute la journée
 * n'a pas de processeur moyen, il n'a pas de processeur du tout.
 */
export const ConsumptionDay = z.object({
  day: z.string(),
  serverId: z.string(),
  serverName: z.string(),
  /** Titulaire **ce jour-là** : un transfert ne réécrit pas le passé. */
  ownerId: z.string().nullable(),
  ownerEmail: z.string().nullable(),
  /** Identifiant du client chez le facturier, pour rapprocher sans table de correspondance. */
  ownerExternalId: z.string().nullable(),
  resellerId: z.string().nullable(),
  memoryLimitMb: z.number(),
  diskLimitMb: z.number(),
  cpuLimitPct: z.number(),
  /** Relevés reçus (un par minute) et, parmi eux, serveur démarré. */
  samples: z.number(),
  onlineSamples: z.number(),
  cpuAvgPct: z.number().nullable(),
  cpuMaxPct: z.number().nullable(),
  memoryAvgBytes: z.number().nullable(),
  memoryMaxBytes: z.number().nullable(),
  diskMaxBytes: z.number().nullable(),
  networkRxBytes: z.number(),
  networkTxBytes: z.number(),
  playersMax: z.number().nullable(),
  /** Faux pour la journée en cours : elle se recalcule encore. */
  complete: z.boolean(),
});
export type ConsumptionDay = z.infer<typeof ConsumptionDay>;

/**
 * Colonnes d'un export, dans l'ordre.
 *
 * Deux jeux, selon qui télécharge. Depuis la page d'un serveur, un
 * sous-utilisateur ou le nouveau titulaire après un transfert lit la
 * consommation de ce serveur, **pas** l'adresse de celui qui le possédait
 * avant : les colonnes qui nomment des comptes n'y figurent pas.
 */
export const CONSUMPTION_COLUMNS = [
  "day",
  "serverId",
  "serverName",
  "ownerId",
  "ownerEmail",
  "ownerExternalId",
  "resellerId",
  "memoryLimitMb",
  "diskLimitMb",
  "cpuLimitPct",
  "samples",
  "onlineSamples",
  "cpuAvgPct",
  "cpuMaxPct",
  "memoryAvgBytes",
  "memoryMaxBytes",
  "diskMaxBytes",
  "networkRxBytes",
  "networkTxBytes",
  "playersMax",
  "complete",
] as const satisfies readonly (keyof ConsumptionDay)[];

const ACCOUNT_COLUMNS = new Set<keyof ConsumptionDay>([
  "ownerId",
  "ownerEmail",
  "ownerExternalId",
  "resellerId",
]);

export const SERVER_CONSUMPTION_COLUMNS = CONSUMPTION_COLUMNS.filter(
  (column) => !ACCOUNT_COLUMNS.has(column),
);

export type ConsumptionColumn = (typeof CONSUMPTION_COLUMNS)[number];

/** Une ligne réduite aux colonnes d'un export. */
export function pickConsumptionColumns(
  row: ConsumptionDay,
  columns: readonly ConsumptionColumn[],
): Partial<ConsumptionDay> {
  return Object.fromEntries(columns.map((column) => [column, row[column]]));
}
