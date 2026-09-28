import { shiftDay, utcDay } from "@gamedashboard/contracts";
import type { Database } from "@gamedashboard/db";
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { sql } from "drizzle-orm";
import { battre } from "../../common/background-tick";
import { DATABASE } from "../../common/database.provider";

/** Un tour par heure : la journée en cours n'a pas besoin d'être plus fraîche pour être facturée. */
const TICK_MS = 60 * 60_000;

/**
 * Premier tour peu après le démarrage, pas pendant : l'API a mieux à faire
 * que d'agréger un mois de relevés au moment où elle ouvre ses routes.
 */
const FIRST_TICK_MS = 2 * 60_000;

/**
 * Jours recalculés au premier tour.
 *
 * Tout ce que `server_metrics` garde encore. C'est ce qui rattrape une API
 * restée arrêtée plusieurs jours, et c'est aussi ce qui remplit la table la
 * première fois qu'elle existe : le mois écoulé est déjà exportable le jour de
 * la mise à jour.
 */
const BACKFILL_DAYS = 30;

/**
 * Jusqu'où le calcul d'une journée regarde en arrière pour son premier
 * relevé : le débit réseau est l'écart entre deux compteurs, et celui de
 * minuit a son prédécesseur la veille.
 */
const LOOKBACK = "1 hour";

/**
 * Résume `server_metrics` en journées (`server_consumption_days`).
 *
 * Chaque tour **recalcule** la veille et le jour en cours au lieu d'ajouter à
 * un cumul : un relevé arrivé en retard, un tour manqué, une API redémarrée au
 * milieu — tout se corrige au tour suivant, puisque rien ne dépend de ce qu'a
 * fait le précédent. Au-delà de la veille, les mesures d'une journée ne
 * bougent plus.
 */
@Injectable()
export class ConsumptionRollupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ConsumptionRollupService.name);
  private timer: NodeJS.Timeout | null = null;
  private first: NodeJS.Timeout | null = null;
  private running = false;

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  onModuleInit(): void {
    this.first = setTimeout(() => void this.tick(BACKFILL_DAYS), FIRST_TICK_MS);
    this.timer = setInterval(() => void this.tick(1), TICK_MS);
    // Ces minuteurs ne doivent pas empêcher le processus de s'arrêter.
    this.first.unref();
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
  }

  private tick(days: number): Promise<void> {
    return battre(this.logger, "consumption-rollup", async () => {
      // Un tour lent ne se superpose pas au suivant : ils écriraient les
      // mêmes lignes, et le second attendrait les verrous du premier.
      if (this.running) return;
      this.running = true;
      try {
        await this.rollupByDay(shiftDay(utcDay(new Date()), -days));
      } finally {
        this.running = false;
      }
    });
  }

  /**
   * Recalcule de `fromDay` à aujourd'hui, **une journée par requête**.
   *
   * Le rattrapage de trente jours d'un seul tenant lirait jusqu'à 43 000
   * relevés par serveur dans une même transaction ; découpé, chaque requête
   * reste courte, ne tient ses verrous que le temps d'une journée, et ménage
   * le PostgreSQL mutualisé d'un hébergement cPanel.
   */
  async rollupByDay(fromDay: string, now: Date = new Date()): Promise<number> {
    let written = 0;
    for (let day = fromDay; day <= utcDay(now); day = shiftDay(day, 1)) {
      written += await this.rollup(day, now, day);
    }
    return written;
  }

  /**
   * Recalcule les journées de `fromDay` (incluse) jusqu'à `now`, ou jusqu'à
   * `toDay` (incluse) si elle est donnée.
   *
   * **Serveur par serveur** (`lateral`) : l'index de `server_metrics` est
   * `(server_id, at)`, et une lecture bornée par le seul instant parcourrait
   * la table entière.
   *
   * Ce qui compte :
   *
   * - **En ligne** : tout état autre que `offline`. Le processeur et la mémoire
   *   ne se moyennent que sur ces relevés — Wings rend des zéros pour un
   *   conteneur arrêté, et les compter ferait baisser la moyenne d'un serveur
   *   qu'on a simplement éteint la nuit. Le disque, lui, existe éteint.
   * - **Réseau** : Wings rend des octets cumulés depuis le démarrage du
   *   conteneur. Le trafic d'un relevé est l'écart au précédent ; un compteur
   *   plus petit que le précédent a été remis à zéro par un redémarrage, et
   *   tout ce qu'il affiche a été échangé depuis. Le premier relevé connu n'a
   *   pas de prédécesseur : il ne compte rien, faute de savoir d'où il part.
   *
   * Rend le nombre de journées écrites.
   */
  async rollup(fromDay: string, now: Date = new Date(), toDay?: string): Promise<number> {
    const start = `${fromDay}T00:00:00.000Z`;
    // Borne exclue : le relevé de minuit pile appartient au lendemain, et ne
    // doit pas venir écrire une journée partielle à la place de la sienne.
    const end = toDay
      ? `${shiftDay(toDay, 1)}T00:00:00.000Z`
      : new Date(now.getTime() + 1).toISOString();
    /*
     * Seule la journée en cours suit le titulaire, le revendeur, le nom et
     * les limites actuels. Une journée passée déjà écrite garde les siens,
     * veille comprise : un transfert fait ce matin n'attribue pas au
     * repreneur ce qu'a consommé l'ancien titulaire hier, et le rattrapage de
     * trente jours qui suit chaque démarrage ne réécrit pas le passé. Les
     * mesures, elles, se recalculent : elles ne dépendent que des relevés.
     */
    const today = utcDay(now);
    const result = (await this.db.execute(sql`
      insert into server_consumption_days as c (
        day, server_id, server_name, owner_id, reseller_id,
        memory_limit_mb, disk_limit_mb, cpu_limit_pct,
        samples, online_samples, cpu_avg_pct, cpu_max_pct,
        memory_avg_bytes, memory_max_bytes, disk_max_bytes,
        network_rx_bytes, network_tx_bytes, players_max, rolled_at
      )
      select
        (r.at at time zone 'UTC')::date,
        s.id, s.name, s.owner_id, s.reseller_id,
        s.memory_mb, s.disk_mb, s.cpu_pct,
        count(*)::int,
        (count(*) filter (where r.actif))::int,
        avg(r.cpu) filter (where r.actif),
        max(r.cpu) filter (where r.actif),
        round(avg(r.memoire) filter (where r.actif))::bigint,
        (max(r.memoire) filter (where r.actif))::bigint,
        max(r.disque)::bigint,
        coalesce(sum(r.rx), 0)::bigint,
        coalesce(sum(r.tx), 0)::bigint,
        max(r.players) filter (where r.actif),
        ${now.toISOString()}::timestamptz
      from servers s
      cross join lateral (
        select
          m.at,
          m.state <> 'offline' as actif,
          m.cpu_pct::float8 as cpu,
          m.mem_bytes::float8 as memoire,
          m.disk_bytes::float8 as disque,
          m.players,
          case
            when lag(m.net_rx) over w is null then 0
            when m.net_rx >= lag(m.net_rx) over w then m.net_rx - lag(m.net_rx) over w
            else m.net_rx
          end::float8 as rx,
          case
            when lag(m.net_tx) over w is null then 0
            when m.net_tx >= lag(m.net_tx) over w then m.net_tx - lag(m.net_tx) over w
            else m.net_tx
          end::float8 as tx
        from server_metrics m
        where m.server_id = s.id
          and m.at >= ${start}::timestamptz - interval '${sql.raw(LOOKBACK)}'
          and m.at <= ${now.toISOString()}::timestamptz
          and m.at < ${end}::timestamptz
        window w as (order by m.at)
      ) r
      where r.at >= ${start}::timestamptz
      group by 1, s.id
      on conflict (server_id, day) do update set
        server_name = case when c.day >= ${today}::date then excluded.server_name else c.server_name end,
        owner_id = case when c.day >= ${today}::date then excluded.owner_id else c.owner_id end,
        reseller_id = case when c.day >= ${today}::date then excluded.reseller_id else c.reseller_id end,
        memory_limit_mb = case when c.day >= ${today}::date then excluded.memory_limit_mb else c.memory_limit_mb end,
        disk_limit_mb = case when c.day >= ${today}::date then excluded.disk_limit_mb else c.disk_limit_mb end,
        cpu_limit_pct = case when c.day >= ${today}::date then excluded.cpu_limit_pct else c.cpu_limit_pct end,
        samples = excluded.samples,
        online_samples = excluded.online_samples,
        cpu_avg_pct = excluded.cpu_avg_pct,
        cpu_max_pct = excluded.cpu_max_pct,
        memory_avg_bytes = excluded.memory_avg_bytes,
        memory_max_bytes = excluded.memory_max_bytes,
        disk_max_bytes = excluded.disk_max_bytes,
        network_rx_bytes = excluded.network_rx_bytes,
        network_tx_bytes = excluded.network_tx_bytes,
        players_max = excluded.players_max,
        rolled_at = excluded.rolled_at
    `)) as unknown as { count?: number };
    return result.count ?? 0;
  }
}
