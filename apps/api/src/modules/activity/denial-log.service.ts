import { Inject, Injectable, Logger } from "@nestjs/common";
import type { RequestOrigin } from "../../common/request-origin";
import { ActivityService } from "./activity.service";

/**
 * Les refus qu'on consigne.
 *
 * - `access.denied` : un appelant identifié — session, clé d'API, clé
 *   applicative — demande ce que ses droits ne couvrent pas ;
 * - `application.key_rejected` : une clé applicative présentée et refusée ;
 * - `node.token_rejected` : un jeton de daemon présenté et refusé.
 */
export type DenialEvent =
  | "access.denied"
  | "application.key_rejected"
  | "node.token_rejected"
  | "node.agent_token_rejected";

export interface Denial {
  event: DenialEvent;
  /** Le compte refusé, quand il est connu ; `null` pour un appelant anonyme. */
  actorId: string | null;
  actorType: "user" | "api_key" | "system";
  /** Nom affiché. Déduit du compte quand il y en a un. */
  actorLabel?: string;
  origin: RequestOrigin;
  /**
   * Ce que le refus visait — serveur, permission, préfixe de la clé
   * présentée. **Jamais un secret** : cette ligne est lue par le personnel,
   * exportée, conservée.
   */
  properties?: Record<string, unknown>;
}

/** Fenêtre de regroupement, et de remise à zéro du plafond. */
const WINDOW_MS = 10 * 60_000;
/** Lignes écrites au plus par fenêtre, tous refus confondus. */
const MAX_LINES_PER_WINDOW = 300;
/** Au-delà, les plus anciens regroupements sont oubliés : la mémoire reste bornée. */
const MAX_TRACKED = 10_000;

/**
 * Journal des refus (NC-12).
 *
 * Les gardes et le contrôle d'accès aux serveurs refusaient en silence : un
 * jeton de node volé essayé d'ailleurs, un compte qui parcourt les
 * identifiants de serveur, une clé révoquée que la boutique présente encore
 * — rien ne s'en voyait. Chaque refus passe désormais ici.
 *
 * **Le journal ne doit pas se laisser remplir.** Un script qui boucle sur un
 * jeton périmé écrirait une ligne par requête et noierait ce qu'on cherche.
 * Deux freins, en mémoire comme le compteur SFTP (l'API est un seul
 * processus) :
 *
 * - **regroupement** : un même refus (même événement, même appelant, même
 *   adresse, même route, même cible) ne s'écrit qu'à sa 1ʳᵉ, 10ᵉ, 100ᵉ…
 *   occurrence dans la fenêtre, la ligne portant le compte. Le volume reste
 *   lisible : dix mille essais tiennent en cinq lignes ;
 * - **plafond** : au plus `MAX_LINES_PER_WINDOW` lignes par fenêtre. Un
 *   balayage depuis des milliers d'adresses donne autant de refus distincts,
 *   que le regroupement ne réunit pas ; le dépassement part dans les journaux
 *   du processus, une fois.
 *
 * **N'échoue jamais, et ne se fait pas attendre** : les appelants le lancent
 * sans `await`. Un refus reste un refus même si le journal est plein, et sa
 * durée ne doit rien dire de ce qui s'écrit — un inconnu et un jeton faux
 * doivent toujours coûter le même temps.
 *
 * Aucune ligne n'est rattachée à un serveur (`server_id` nul, la cible est
 * dans les propriétés) : le journal d'un serveur est lu par son propriétaire,
 * qui y lirait le nom d'un tiers ayant tenté d'y entrer — et un identifiant
 * de serveur inventé ferait échouer l'écriture. Ces lignes relèvent du
 * journal de la plateforme.
 */
@Injectable()
export class DenialLogService {
  /** Publique pour qu'un test puisse la museler sans contourner le type. */
  readonly logger = new Logger(DenialLogService.name);
  private readonly seen = new Map<string, { since: number; count: number }>();
  private windowStart = 0;
  private written = 0;
  private overflowSaid = false;

  constructor(@Inject(ActivityService) private readonly activity: ActivityService) {}

  async record(denial: Denial): Promise<void> {
    try {
      const count = this.admit(keyOf(denial), Date.now());
      if (count === null) return;

      await this.activity.record({
        event: denial.event,
        serverId: null,
        actorId: denial.actorId,
        actorType: denial.actorType,
        actorLabel:
          denial.actorLabel ??
          (denial.actorId ? await this.activity.labelFor(denial.actorId) : "Appelant inconnu"),
        ip: denial.origin.ip,
        properties: {
          route: denial.origin.route,
          ...denial.properties,
          ...(count > 1 ? { occurrences: count } : {}),
        },
      });
    } catch (error) {
      this.logger.error(
        `Refus « ${denial.event} » non consigné — ${
          error instanceof Error ? error.message : "erreur inconnue"
        }`,
      );
    }
  }

  /**
   * Faut-il écrire ce refus ? Rend son rang dans la fenêtre, ou `null`.
   */
  private admit(key: string, now: number): number | null {
    if (now - this.windowStart > WINDOW_MS) {
      this.windowStart = now;
      this.written = 0;
      this.overflowSaid = false;
      this.sweep(now);
    } else if (this.seen.size >= MAX_TRACKED) {
      this.sweep(now);
    }

    let entry = this.seen.get(key);
    if (!entry || now - entry.since > WINDOW_MS) {
      entry = { since: now, count: 0 };
      this.seen.set(key, entry);
    }
    entry.count += 1;
    if (!isPowerOfTen(entry.count)) return null;

    if (this.written >= MAX_LINES_PER_WINDOW) {
      if (!this.overflowSaid) {
        this.overflowSaid = true;
        this.logger.warn(
          `Plus de ${MAX_LINES_PER_WINDOW} refus en dix minutes : les suivants ne sont plus consignés jusqu'à la fin de la fenêtre.`,
        );
      }
      return null;
    }

    this.written += 1;
    return entry.count;
  }

  /** Oublie les regroupements expirés ; au besoin, les plus anciens. */
  private sweep(now: number): void {
    for (const [key, entry] of this.seen) {
      if (now - entry.since > WINDOW_MS) this.seen.delete(key);
    }
    for (const key of this.seen.keys()) {
      if (this.seen.size < MAX_TRACKED) break;
      this.seen.delete(key);
    }
  }
}

/** Ce qui fait de deux refus « le même ». */
function keyOf(denial: Denial): string {
  return [
    denial.event,
    denial.actorId ?? "",
    denial.origin.ip ?? "",
    denial.origin.route,
    JSON.stringify(denial.properties ?? {}),
  ].join("|");
}

/** 1, 10, 100… — calculé en entiers : `Math.log10(1000)` n'est pas toujours 3. */
function isPowerOfTen(n: number): boolean {
  let p = 1;
  while (p < n) p *= 10;
  return p === n;
}
