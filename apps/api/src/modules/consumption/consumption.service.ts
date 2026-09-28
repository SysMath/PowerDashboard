import {
  CONSUMPTION_PAGE_SIZE,
  type ConsumptionColumn,
  ConsumptionDay,
  type ConsumptionExportFormat,
  type ConsumptionPeriod,
  utcDay,
} from "@gamedashboard/contracts";
import type { Database } from "@gamedashboard/db";
import { Inject, Injectable } from "@nestjs/common";
import { type SQL, sql } from "drizzle-orm";
import { DATABASE } from "../../common/database.provider";
import { type ConsumptionExportFile, consumptionExportFile } from "./consumption-export";

/**
 * Ce qu'une lecture a le droit de voir.
 *
 * Le périmètre (serveur, revendeur) est posé par la route, jamais par la
 * requête : `ownerId` et `serverId` sont des filtres que l'appelant choisit,
 * `scope` est la borne qu'il ne choisit pas.
 */
export interface ConsumptionFilters {
  period: ConsumptionPeriod;
  serverId?: string;
  ownerId?: string;
  scope?: { serverId: string } | { resellerId: string };
}

/**
 * Lecture et export de `server_consumption_days`.
 *
 * Les colonnes d'octets sont converties en `float8` : le pilote rend un
 * `bigint` en chaîne, et la réponse repasse par son schéma, qui refuserait.
 */
@Injectable()
export class ConsumptionService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Une page, pour l'API applicative. */
  async page(
    filters: ConsumptionFilters,
    page: number,
    now: Date = new Date(),
  ): Promise<{ items: ConsumptionDay[]; hasMore: boolean }> {
    const rows = await this.read(filters, now, {
      limit: CONSUMPTION_PAGE_SIZE + 1,
      offset: (page - 1) * CONSUMPTION_PAGE_SIZE,
    });
    return {
      items: rows.slice(0, CONSUMPTION_PAGE_SIZE),
      hasMore: rows.length > CONSUMPTION_PAGE_SIZE,
    };
  }

  /**
   * Toutes les lignes, bloc par bloc.
   *
   * Par clé (`day`, `server_id`) et non par décalage : un décalage relit tout
   * ce qui précède à chaque bloc, et une année d'un parc entier se compte en
   * centaines de milliers de lignes.
   */
  async *all(filters: ConsumptionFilters, now: Date = new Date()): AsyncGenerator<ConsumptionDay> {
    let after: { day: string; serverId: string } | undefined;
    for (;;) {
      const rows = await this.read(filters, now, { limit: CONSUMPTION_PAGE_SIZE, after });
      yield* rows;
      const last = rows.at(-1);
      if (!last || rows.length < CONSUMPTION_PAGE_SIZE) return;
      after = { day: last.day, serverId: last.serverId };
    }
  }

  /** Le fichier à télécharger, prêt à partir en flux. */
  exportFile(
    filters: ConsumptionFilters,
    format: ConsumptionExportFormat,
    columns: readonly ConsumptionColumn[],
    now: Date = new Date(),
  ): ConsumptionExportFile {
    return consumptionExportFile(format, columns, this.all(filters, now), filters.period);
  }

  private async read(
    filters: ConsumptionFilters,
    now: Date,
    window: { limit: number; offset?: number; after?: { day: string; serverId: string } },
  ): Promise<ConsumptionDay[]> {
    const conditions: SQL[] = [
      sql`c.day >= ${filters.period.from}::date`,
      sql`c.day <= ${filters.period.to}::date`,
    ];
    if (filters.serverId) conditions.push(sql`c.server_id = ${filters.serverId}`);
    if (filters.ownerId) conditions.push(sql`c.owner_id = ${filters.ownerId}`);
    if (filters.scope && "serverId" in filters.scope) {
      conditions.push(sql`c.server_id = ${filters.scope.serverId}`);
    }
    if (filters.scope && "resellerId" in filters.scope) {
      conditions.push(sql`c.reseller_id = ${filters.scope.resellerId}`);
    }
    if (window.after) {
      conditions.push(
        sql`(c.day, c.server_id) > (${window.after.day}::date, ${window.after.serverId}::uuid)`,
      );
    }

    const rows = (await this.db.execute(sql`
      select
        to_char(c.day, 'YYYY-MM-DD') as "day",
        c.server_id as "serverId",
        c.server_name as "serverName",
        c.owner_id as "ownerId",
        u.email as "ownerEmail",
        u.external_id as "ownerExternalId",
        c.reseller_id as "resellerId",
        c.memory_limit_mb as "memoryLimitMb",
        c.disk_limit_mb as "diskLimitMb",
        c.cpu_limit_pct as "cpuLimitPct",
        c.samples as "samples",
        c.online_samples as "onlineSamples",
        c.cpu_avg_pct::float8 as "cpuAvgPct",
        c.cpu_max_pct::float8 as "cpuMaxPct",
        c.memory_avg_bytes::float8 as "memoryAvgBytes",
        c.memory_max_bytes::float8 as "memoryMaxBytes",
        c.disk_max_bytes::float8 as "diskMaxBytes",
        c.network_rx_bytes::float8 as "networkRxBytes",
        c.network_tx_bytes::float8 as "networkTxBytes",
        c.players_max as "playersMax",
        c.day < ${utcDay(now)}::date as "complete"
      from server_consumption_days c
      left join users u on u.id = c.owner_id
      where ${sql.join(conditions, sql` and `)}
      order by c.day, c.server_id
      limit ${window.limit}
      offset ${window.offset ?? 0}
    `)) as unknown as unknown[];

    // Le schéma fait foi : une colonne rendue en chaîne par le pilote doit
    // casser ici, pas dans le tableur d'un facturier.
    return rows.map((row) => ConsumptionDay.parse(row));
  }
}
