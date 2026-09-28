import { CONSUMPTION_RETENTION_DAYS } from "@gamedashboard/contracts";
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

/**
 * Effacement des données périmées.
 *
 * **Rien ne purgeait rien.** Le relevé de consommation écrit une ligne par
 * serveur et par minute, la sonde de jeu une autre, et aucune ne repartait
 * jamais. Sur un parc de cent serveurs cela fait près de trois cents mille
 * lignes par jour, cent millions par an : la table finit par ne plus tenir en
 * cache, les graphes ralentissent, puis le disque se remplit. Une panne
 * annoncée, dont la date dépend seulement de la taille du parc.
 *
 * Le service des notifications promettait d'ailleurs déjà cette purge en
 * commentaire — « la rétention les effacera » — sans que personne l'écrive.
 *
 * **Ce qui est gardé, et pourquoi.** Chaque fenêtre ci-dessous répond à une
 * question précise : « jusqu'où quelqu'un regardera-t-il en arrière ? ». Une
 * fenêtre trop courte détruit une information qu'on cherchera ; trop longue,
 * elle garde des lignes que personne n'ouvrira jamais.
 */

/**
 * Cadence : une fois par heure.
 *
 * Effacer coûte des écritures et du journal de transactions. Le faire à la
 * minute, comme le relevé, ferait payer en permanence une opération dont le
 * résultat ne change qu'à l'échelle du jour.
 */
const TICK_MS = 60 * 60_000;

/**
 * Lignes effacées par requête.
 *
 * Le premier tour sur une base jamais purgée a des millions de lignes à
 * retirer : une seule instruction poserait un verrou de plusieurs minutes sur
 * une table que le relevé écrit toutes les minutes. On avance donc par
 * tranches, et le tour suivant reprendra où celui-ci s'arrête.
 */
const BATCH = 20_000;

/** Nombre de tranches par table et par tour. Borne la durée d'un tour. */
const MAX_BATCHES = 10;

interface RetentionRule {
  /** Nom de la table, écrit en clair : ces requêtes sont du SQL, pas de l'ORM. */
  table: string;
  /** Colonne portant l'instant de référence. */
  column: string;
  days: number;
  /**
   * Condition supplémentaire, quand l'âge ne suffit pas à décider.
   *
   * C'est ici que se joue la différence entre « vieux » et « fini » : une
   * notification non lue reste due à quelqu'un quel que soit son âge, et une
   * livraison en attente doit survivre jusqu'à ce qu'elle aboutisse ou
   * renonce.
   */
  where?: string;
  /** Ce que la fenêtre protège. Sert au journal, et à la relecture. */
  reason: string;
}

const RULES: readonly RetentionRule[] = [
  {
    table: "server_metrics",
    column: "at",
    days: 30,
    reason: "un mois de courbes de consommation ; au-delà, personne ne remonte",
  },
  {
    /*
     * Le résumé journalier de `server_metrics`, qui lui survit : treize mois,
     * pour qu'un facturier compare un mois à celui de l'an passé et qu'un
     * litige tardif ait encore de quoi se relire (`CONSUMPTION_RETENTION_DAYS`).
     */
    table: "server_consumption_days",
    column: "day",
    days: CONSUMPTION_RETENTION_DAYS,
    reason: "treize mois de consommation journalière, pour la facturation et ses litiges",
  },
  {
    table: "server_health",
    column: "at",
    days: 30,
    reason: "même horizon que les courbes, dont elle est le pendant",
  },
  {
    /*
     * Seules les notifications **lues**.
     *
     * Une notification non lue est encore due à quelqu'un : l'effacer parce
     * qu'elle a trois mois reviendrait à décider à sa place qu'il ne la lira
     * pas. Celui qui ne s'est pas connecté depuis l'été trouvera sa sauvegarde
     * échouée en rentrant.
     */
    table: "notifications",
    column: "created_at",
    days: 90,
    where: "read_at is not null",
    reason: "trois mois après lecture ; les non lues restent, elles sont dues",
  },
  {
    /*
     * Seules les livraisons **réglées**.
     *
     * Une livraison encore en attente de sa prochaine tentative doit survivre :
     * l'effacer annulerait un rappel que le tiers attend, sans que personne ne
     * puisse s'en apercevoir — il ignore qu'il devait le recevoir.
     */
    table: "application_webhook_deliveries",
    column: "created_at",
    days: 30,
    where: "next_attempt_at is null",
    reason: "un mois de comptes rendus ; les livraisons en attente restent",
  },
  {
    /*
     * Mêmes règles que pour les livraisons applicatives, et pour la même
     * raison : une livraison encore en attente de sa prochaine tentative doit
     * survivre. L'effacer annulerait un rappel que le client attend, sans que
     * personne ne puisse s'en apercevoir.
     */
    table: "webhook_deliveries",
    column: "created_at",
    days: 30,
    where: "next_attempt_at is null",
    reason: "un mois de comptes rendus ; les livraisons en attente restent",
  },
  {
    /*
     * Réponses mémorisées de l'idempotence (audit ASVS, NC-39).
     *
     * Elles portent la réponse complète d'une création — adresse et nom du
     * compte créé compris — et n'étaient jamais purgées. Leur seul usage est
     * de rendre la même réponse à une reprise : quelques secondes pour un
     * délai réseau, quelques heures pour une file ou un clic sur « Create »
     * dans la facturation. Un mois couvre ces reprises avec une marge large.
     * Au-delà, une clé rejouée est traitée comme une demande neuve.
     */
    table: "idempotency_records",
    column: "created_at",
    days: 30,
    reason: "un mois de reprises possibles ; au-delà, la réponse n'a plus à être rendue",
  },
  {
    table: "auth_tokens",
    column: "expires_at",
    days: 30,
    reason: "un mois après expiration : de quoi expliquer un lien déjà employé",
  },
  {
    // Le verrou de connexion ne regarde que les quinze dernières minutes ;
    // le reste n'est qu'un historique, qu'un attaquant peut faire grossir.
    table: "login_attempts",
    column: "at",
    days: 30,
    reason: "un mois de tentatives, de quoi relire une attaque ; au-delà, rien",
  },
  {
    /*
     * Sessions fermées seulement.
     *
     * Une session encore valable ne se touche pas, quel que soit son âge :
     * elle est ouverte sur l'appareil de quelqu'un.
     */
    table: "sessions",
    column: "expires_at",
    days: 90,
    where: "revoked_at is not null or expires_at < now()",
    reason: "trois mois d'historique d'appareils, comme l'écran de sécurité",
  },
  {
    /*
     * Un an, et volontairement plus long que le reste.
     *
     * Le journal d'audit sert à répondre « qui a fait cela, et quand »,
     * parfois des mois après. Le tailler aux trente jours des mesures le
     * rendrait inutile précisément dans les cas où on l'ouvre.
     */
    table: "activity_logs",
    column: "at",
    days: 365,
    reason: "un an : un audit se lit longtemps après les faits",
  },
];

/** Ce qu'une table a rendu au dernier tour, avec la fenêtre qui l'a décidé. */
export interface RetentionTableReport {
  table: string;
  rows: number;
  days: number;
  reason: string;
}

/**
 * Compte rendu du service, lisible depuis l'administration.
 *
 * **Un service silencieux ne se distingue pas d'un service mort.** La
 * rétention ne parlait que lorsqu'elle effaçait quelque chose : sur une
 * plateforme jeune, où rien n'a encore l'âge d'être retiré, elle n'écrivait
 * jamais une ligne. Rien ne permettait de dire si elle tournait, si elle
 * échouait en boucle, ou si le minuteur n'avait jamais été armé — et on ne
 * l'aurait découvert qu'au disque plein.
 *
 * Le compte rendu vit **en mémoire**, et c'est assez : il décrit l'état du
 * processus courant, et un redémarrage le remet à zéro en même temps que le
 * minuteur qu'il décrit. L'écrire en base ferait payer une écriture par heure
 * pour une information qu'on regarde deux fois par an.
 */
export interface RetentionReport {
  /** Fin du dernier tour, réussi ou non. `null` tant qu'aucun n'a eu lieu. */
  lastRunAt: string | null;
  /**
   * Fin du dernier tour **réussi**.
   *
   * Distinct du précédent, et la distinction porte tout : un service qui tourne
   * toutes les heures en échouant chaque fois a un `lastRunAt` frais et n'a
   * plus rien effacé depuis des jours. Le décompte par table ci-dessous date de
   * ce tour-là, pas de la dernière tentative.
   */
  lastSuccessAt: string | null;
  /** Durée de ce tour, en millisecondes. */
  durationMs: number | null;
  /** Quand le prochain tour est attendu. */
  nextRunAt: string | null;
  /** Lignes retirées au dernier tour, table par table — **zéro compris**. */
  tables: RetentionTableReport[];
  /** Total du dernier tour. */
  lastRemoved: number;
  /** Total depuis le démarrage du processus. */
  totalRemoved: number;
  /**
   * Cause du dernier échec, et depuis combien de tours il se répète.
   *
   * Compté, parce qu'un tour raté est sans gravité — le suivant reprend — là
   * où dix d'affilée signifient que plus rien n'est effacé.
   */
  failure: { message: string; consecutive: number } | null;
}

@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RetentionService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  /* --- Ce que le service rend de lui-même ---------------------------------- */
  private lastRunAt: number | null = null;
  private lastSuccessAt: number | null = null;
  private nextRunAt: number | null = null;
  private durationMs: number | null = null;
  private lastTables: RetentionTableReport[] = [];
  private lastRemoved = 0;
  private totalRemoved = 0;
  private failure: { message: string; consecutive: number } | null = null;
  /** Le premier tour parle même pour ne rien dire : c'est lui qui atteste. */
  private announced = false;

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  onModuleInit(): void {
    /*
     * Un premier tour peu après le démarrage, puis toutes les heures.
     *
     * Sans ce premier tour, un panel redémarré chaque nuit par sa mise à jour
     * n'atteindrait jamais l'heure pleine et ne purgerait jamais rien.
     */
    setTimeout(() => battre(this.logger, "retention", () => this.tick()), 60_000).unref();
    this.nextRunAt = Date.now() + 60_000;
    this.timer = setInterval(() => battre(this.logger, "retention", () => this.tick()), TICK_MS);
    this.timer.unref();
  }

  /**
   * L'état du service, tel que l'administration l'affiche.
   *
   * Les règles voyagent avec : savoir que le ménage tourne ne sert qu'à moitié
   * si l'on ignore **ce qu'il garde et combien de temps**. Les deux ensemble
   * répondent à la seule question qu'on se pose devant cet écran — « mes
   * journaux d'il y a six mois sont-ils encore là ? ».
   */
  report(): RetentionReport {
    return {
      lastRunAt: this.lastRunAt === null ? null : new Date(this.lastRunAt).toISOString(),
      lastSuccessAt:
        this.lastSuccessAt === null ? null : new Date(this.lastSuccessAt).toISOString(),
      durationMs: this.durationMs,
      nextRunAt: this.nextRunAt === null ? null : new Date(this.nextRunAt).toISOString(),
      // Aucun tour encore passé : on annonce les règles avec zéro ligne plutôt
      // qu'un tableau vide. « Rien effacé » et « on ne sait pas » se
      // distinguent par `lastRunAt`, pas en escamotant la politique.
      tables:
        this.lastTables.length > 0
          ? this.lastTables
          : RULES.map((rule) => ({
              table: rule.table,
              rows: 0,
              days: rule.days,
              reason: rule.reason,
            })),
      lastRemoved: this.lastRemoved,
      totalRemoved: this.totalRemoved,
      failure: this.failure,
    };
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Un tour : chaque règle, par tranches. */
  async tick(): Promise<void> {
    // Non réentrant : sur une base jamais purgée, un tour peut durer plus
    // longtemps que l'intervalle, et deux tours concurrents se disputeraient
    // les mêmes lignes.
    if (this.running) return;
    this.running = true;
    const startedAt = Date.now();
    const tables: RetentionTableReport[] = [];

    try {
      for (const rule of RULES) {
        const removed = await this.apply(rule);
        // Les tables rendues à zéro comptent aussi : c'est ce qui distingue
        // « la règle s'est appliquée et n'a rien trouvé » de « la règle n'a
        // pas été atteinte », les deux donnant zéro ligne effacée.
        tables.push({ table: rule.table, rows: removed, days: rule.days, reason: rule.reason });
        if (removed > 0) {
          this.logger.log(`Rétention ${rule.table} : ${removed} ligne(s) retirée(s).`);
        }
      }

      this.lastTables = tables;
      this.lastRemoved = tables.reduce((sum, entry) => sum + entry.rows, 0);
      this.totalRemoved += this.lastRemoved;
      this.lastSuccessAt = Date.now();
      this.failure = null;

      /*
       * Le premier tour parle, même pour ne rien dire.
       *
       * C'est la seule ligne qui atteste que le minuteur est armé et que les
       * requêtes passent. Les tours suivants se taisent tant qu'ils n'effacent
       * rien — une ligne par heure disant « rien à faire » finit par n'être
       * plus lue, et emporte avec elle celles qui comptent.
       */
      if (!this.announced) {
        this.announced = true;
        this.logger.log(
          `Rétention active : ${RULES.length} table(s) surveillée(s), ${this.lastRemoved} ligne(s) retirée(s) à ce premier tour.`,
        );
      }
    } catch (error) {
      // Un tour raté ne doit pas arrêter le minuteur : le suivant reprendra.
      const message = error instanceof Error ? error.message : "erreur inconnue";
      this.failure = { message, consecutive: (this.failure?.consecutive ?? 0) + 1 };
      this.logger.warn(
        `Tour de rétention interrompu (${this.failure.consecutive} d'affilée) : ${message}`,
      );
    } finally {
      this.running = false;
      this.lastRunAt = Date.now();
      this.durationMs = this.lastRunAt - startedAt;
      this.nextRunAt = this.lastRunAt + TICK_MS;
    }
  }

  /**
   * Applique une règle, par tranches bornées.
   *
   * La sous-requête `ctid` est la forme la plus simple d'un effacement borné
   * en PostgreSQL : elle choisit les lignes à retirer sans exiger de clé
   * primaire, ce que `server_metrics` et `node_metrics` n'ont pas.
   */
  private async apply(rule: RetentionRule): Promise<number> {
    let total = 0;

    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const extra = rule.where ? `and (${rule.where})` : "";
      const statement = sql.raw(`
        delete from "${rule.table}"
        where ctid in (
          select ctid from "${rule.table}"
          where "${rule.column}" < now() - interval '${rule.days} days'
          ${extra}
          limit ${BATCH}
        )
      `);

      /*
       * Dans une transaction, avec le réglage de session qui autorise la purge.
       *
       * `activity_logs` est en ajout seul côté base (migration 0025) : le
       * déclencheur refuse tout effacement, sauf quand `gamedashboard.retention`
       * vaut `on` dans la transaction courante. C'est la seule voie, et elle
       * ne vit que le temps de cette tranche.
       */
      const result = (await this.db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('gamedashboard.retention', 'on', true)`);
        return await tx.execute(statement);
      })) as unknown as { count?: number };
      // `count` et non `rowCount` : c'est le nom que lui donne postgres-js. Lu
      // sous l'autre nom, chaque tranche valait zéro — l'écran annonçait
      // « 0 ligne » quoi qu'il arrive, et la boucle s'arrêtait à la première.
      const removed = result.count ?? 0;
      total += removed;

      // Moins qu'une tranche pleine : il ne reste rien à retirer pour cette
      // règle, et insister ferait une requête pour zéro ligne.
      if (removed < BATCH) break;
    }

    return total;
  }
}

/** Exposé pour le test : les fenêtres se relisent, elles ne se devinent pas. */
export const RETENTION_RULES = RULES;
