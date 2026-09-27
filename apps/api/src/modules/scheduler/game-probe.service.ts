import { Socket } from "node:net";
import type { GameQueryProtocol } from "@gamedashboard/contracts";
import {
  MISSES_BEFORE_ALERT,
  outageDuration,
  reachabilityTransition,
} from "@gamedashboard/contracts";
import {
  allocations,
  type Database,
  eggs,
  eggVariables,
  nests,
  nodes,
  serverHealth,
  servers,
  serverVariables,
} from "@gamedashboard/db";
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { and, desc, eq, gte, inArray, isNotNull, notInArray, sql } from "drizzle-orm";
import { battre } from "../../common/background-tick";
import { DATABASE } from "../../common/database.provider";
import { NotificationsService } from "../notifications/notifications.service";
import { queryA2s, queryCfx } from "./game-query.transport";
import type { GameStatus } from "./game-status";
import {
  buildStatusRequest,
  type MinecraftStatus,
  readStatusResponse,
  STATUS_FRAME_MAX_BYTES,
} from "./minecraft-ping";
import { probePlan } from "./probe-plan";

/**
 * La sonde de jeu : le serveur répond-il aux joueurs ?
 *
 * Wings sait si un **conteneur** tourne, et c'est tout ce qu'il sait. Un
 * conteneur en marche dont le monde ne charge pas, dont le port n'est pas
 * publié, ou qui s'est figé sur une corruption de chunk, reste « running »
 * pour le daemon alors qu'aucun joueur ne peut entrer. Le relevé de
 * consommation ne le verra pas davantage : le processus consomme, justement.
 *
 * La seule façon honnête de savoir si un serveur de jeu répond est de lui
 * parler **comme un joueur le ferait** — d'où cette sonde, qui ouvre une
 * connexion sur le port public et exécute la poignée de main du protocole.
 *
 * Deux règles la gouvernent :
 *
 * 1. **Elle ne sonde que ce qui est censé tourner.** Un serveur à l'arrêt ne
 *    répond pas, et l'écrire à la minute remplirait la table de « injoignable »
 *    parfaitement attendus, au milieu desquels une vraie panne serait invisible.
 * 2. **Elle n'écrit que dans `server_health`.** Le nombre de joueurs pourrait
 *    aussi aller dans `server_metrics.players`, mais cette table a déjà son
 *    auteur — le relevé de consommation — et deux plumes sur une même colonne
 *    finissent toujours par écrire l'une sur l'autre.
 */

/**
 * Cadence de la sonde.
 *
 * La même minute que le relevé de consommation, et pour la même raison : c'est
 * la granularité en deçà de laquelle on mesure le bruit plutôt que l'état. Elle
 * suit aussi le relevé de près, puisqu'elle s'appuie sur lui pour savoir quels
 * serveurs tournent.
 */
const TICK_MS = 60_000;

/**
 * Ce qu'on accorde à un serveur pour dire bonjour.
 *
 * Trois secondes : la poignée de main d'état est une lecture de fichier en
 * mémoire, elle ne calcule rien. Un serveur qui met plus longtemps est un
 * serveur saturé — précisément ce que cette sonde doit rapporter, et non
 * attendre.
 */
const TIMEOUT_MS = 3_000;

/**
 * Fenêtre des sondes retenues pour décider d'une panne : les trois dernières
 * minutes et une marge pour un tour en retard.
 */
const RECENT_WINDOW_MS = 5 * 60_000;

/** Sondes menées de front. Une connexion TCP coûte peu, mais pas rien. */
const CONCURRENCY = 16;

/**
 * Fraîcheur exigée du relevé qui dit « ce serveur tourne ».
 *
 * Trois minutes, soit trois tours : assez pour qu'un relevé manqué n'éteigne
 * pas la sonde, assez court pour qu'un serveur arrêté cesse vite d'être
 * interrogé.
 */
const RUNNING_WINDOW = "3 minutes";

interface ProbeTarget {
  id: string;
  name: string;
  host: string;
  /** Port de jeu, celui que les joueurs connaissent : c'est lui que cite l'alerte. */
  port: number;
  protocol: GameQueryProtocol;
  /** Port interrogé : le port de jeu ou le port de requête (A2S). */
  queryPort: number;
}

@Injectable()
export class GameProbeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GameProbeService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => battre(this.logger, "game-probe", () => this.tick()), TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Un tour : sonder les serveurs de jeu qui sont censés répondre. */
  async tick(now: Date = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const targets = await this.targets();
      // Même sans cible : un serveur tombé puis arrêté doit être levé.
      await this.forgetStopped(targets.map((target) => target.id));
      if (targets.length === 0) return;

      let silent = 0;
      for (let start = 0; start < targets.length; start += CONCURRENCY) {
        const batch = targets.slice(start, start + CONCURRENCY);
        const results = await Promise.all(batch.map((target) => this.probe(target, now)));
        silent += results.filter((status) => status === null).length;
      }

      await this.alert(targets, now);

      if (silent > 0) {
        this.logger.warn(
          `Sonde de jeu : ${targets.length - silent} serveur(s) ont répondu, ${silent} non.`,
        );
      }
    } catch (error) {
      // Un tour raté ne tue pas le minuteur : le suivant réessaiera.
      this.logger.error(`Tour de sonde interrompu : ${describe(error)}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * Prévient quand un serveur tombe ou revient.
   *
   * La décision vient des dernières sondes de chaque cible, pas du seul tour
   * en cours (`reachabilityTransition`) : une sonde manquée ne suffit pas.
   * `servers.unreachable_since` porte l'état entre deux tours, et seule sa
   * **transition** notifie : une panne de trois heures fait un message à
   * l'entrée et un à la sortie, pas cent quatre-vingts.
   */
  private async alert(targets: ProbeTarget[], now: Date): Promise<void> {
    const ids = targets.map((target) => target.id);
    const known = await this.db
      .select({ id: servers.id, since: servers.unreachableSince })
      .from(servers)
      .where(inArray(servers.id, ids));
    const since = new Map(known.map((row) => [row.id, row.since]));

    for (const target of targets) {
      const recent = await this.db
        .select({ reachable: serverHealth.reachable })
        .from(serverHealth)
        .where(
          and(
            eq(serverHealth.serverId, target.id),
            // Les sondes de ce passage seulement : des échecs d'hier, avant un
            // arrêt, ne doivent pas compter pour la panne d'aujourd'hui.
            gte(serverHealth.at, new Date(now.getTime() - RECENT_WINDOW_MS).toISOString()),
          ),
        )
        .orderBy(desc(serverHealth.at))
        .limit(MISSES_BEFORE_ALERT);

      const down = since.get(target.id) ?? null;
      const transition = reachabilityTransition(
        recent.map((row) => row.reachable),
        down !== null,
      );

      if (transition === "down") {
        await this.db
          .update(servers)
          .set({ unreachableSince: now.toISOString() })
          .where(eq(servers.id, target.id));
        await this.notifications.notifyServerOwner(target.id, {
          type: "server.unreachable",
          title: `${target.name} ne répond plus`,
          body: `Le serveur tourne mais ne répond plus aux joueurs sur ${target.host}:${target.port} depuis ${MISSES_BEFORE_ALERT} minutes. Consultez sa console.`,
          level: "danger",
        });
      } else if (transition === "up" && down !== null) {
        await this.db
          .update(servers)
          .set({ unreachableSince: null })
          .where(eq(servers.id, target.id));
        await this.notifications.notifyServerOwner(target.id, {
          type: "server.recovered",
          title: `${target.name} répond de nouveau`,
          body: `Le serveur est de nouveau joignable, après ${outageDuration(new Date(down), now)} d'interruption.`,
          level: "success",
        });
      }
    }
  }

  /**
   * Lève sans bruit la panne d'un serveur qui n'est plus censé tourner.
   *
   * Arrêté par son propriétaire, il ne répond pas, et c'est normal : garder la
   * marque ferait annoncer un « retour » au prochain démarrage, pour une panne
   * que personne n'a subie depuis l'arrêt.
   */
  private async forgetStopped(running: string[]): Promise<void> {
    await this.db
      .update(servers)
      .set({ unreachableSince: null })
      .where(
        running.length === 0
          ? isNotNull(servers.unreachableSince)
          : and(isNotNull(servers.unreachableSince), notInArray(servers.id, running)),
      );
  }

  /**
   * Les serveurs à sonder.
   *
   * Le protocole et le port viennent de `probePlan` : ce que l'egg déclare
   * (`game_query`), sinon le jeu reconnu à son nom — Minecraft, jeux Steam
   * (A2S), FiveM et RedM. Ce qui n'est pas reconnu n'est pas sondé : parler le
   * protocole de Minecraft à un serveur de Rust ne dirait rien de sa santé.
   *
   * L'adresse sondée est celle que les joueurs emploient, alias compris. C'est
   * le seul sens utile de « joignable » : un serveur qui répond sur la boucle
   * locale du node mais pas sur son adresse publique est injoignable pour ceux
   * qui comptent.
   */
  private async targets(): Promise<ProbeTarget[]> {
    const rows = await this.db
      .select({
        id: servers.id,
        name: servers.name,
        image: servers.dockerImage,
        startup: servers.startup,
        eggName: eggs.name,
        declared: eggs.gameQuery,
        nestName: nests.name,
        ip: allocations.ip,
        ipAlias: allocations.ipAlias,
        port: allocations.port,
        fqdn: nodes.fqdn,
      })
      .from(servers)
      .innerJoin(eggs, eq(servers.eggId, eggs.id))
      .innerJoin(nests, eq(eggs.nestId, nests.id))
      .innerJoin(nodes, eq(servers.nodeId, nodes.id))
      .innerJoin(allocations, eq(servers.allocationId, allocations.id))
      .where(
        and(
          eq(nodes.maintenanceMode, false),
          /*
           * Sonder ce qui tourne, et le savoir du relevé de consommation.
           *
           * Le panel ne connaît pas l'état du conteneur — il ne le duplique
           * pas, délibérément. Le relevé, lui, l'inscrit dans chaque mesure :
           * s'appuyer dessus évite un second aller-retour vers Wings à la
           * minute, et lie naturellement la sonde à ce que le daemon a dit en
           * dernier.
           */
          sql`exists (
            select 1 from server_metrics m
            where m.server_id = ${servers.id}
              and m.state = 'running'
              and m.at > now() - ${RUNNING_WINDOW}::interval
          )`,
        ),
      );
    if (rows.length === 0) return [];

    // Les variables portent le port de requête (`QUERY_PORT`…) : lues en une
    // fois pour tous les serveurs du tour.
    const values = await this.db
      .select({
        serverId: serverVariables.serverId,
        name: eggVariables.envVariable,
        value: serverVariables.value,
      })
      .from(serverVariables)
      .innerJoin(eggVariables, eq(serverVariables.eggVariableId, eggVariables.id))
      .where(
        inArray(
          serverVariables.serverId,
          rows.map((row) => row.id),
        ),
      );
    // Les ports alloués bornent ceux que les variables peuvent désigner.
    const allocated = await this.db
      .select({ serverId: allocations.serverId, port: allocations.port })
      .from(allocations)
      .where(
        inArray(
          allocations.serverId,
          rows.map((row) => row.id),
        ),
      );
    const ports = new Map<string, number[]>();
    for (const entry of allocated) {
      if (!entry.serverId) continue;
      ports.set(entry.serverId, [...(ports.get(entry.serverId) ?? []), entry.port]);
    }

    const variables = new Map<string, Record<string, string>>();
    for (const entry of values) {
      const own = variables.get(entry.serverId) ?? {};
      own[entry.name] = entry.value;
      variables.set(entry.serverId, own);
    }

    return rows.flatMap((row) => {
      const plan = probePlan({
        eggName: row.eggName,
        nestName: row.nestName,
        image: row.image,
        startup: row.startup,
        declared: row.declared,
        variables: variables.get(row.id) ?? {},
        port: row.port,
        ports: ports.get(row.id) ?? [row.port],
      });
      return plan
        ? [
            {
              id: row.id,
              name: row.name,
              host: probeHost(row),
              port: row.port,
              protocol: plan.protocol,
              queryPort: plan.port,
            },
          ]
        : [];
    });
  }

  /**
   * Une sonde, et la ligne qu'elle laisse.
   *
   * Contrairement à la sonde des nodes, l'échec **s'écrit** : c'est ici
   * l'information même. Un serveur que le daemon dit en marche et qui ne
   * répond pas à ses joueurs est exactement ce qu'on cherche à rendre visible,
   * et le passer sous silence reviendrait à ne rien sonder du tout.
   */
  private async probe(target: ProbeTarget, now: Date): Promise<GameStatus | null> {
    const status = await query(target).catch(() => null);

    await this.db.insert(serverHealth).values({
      serverId: target.id,
      at: now.toISOString(),
      reachable: status !== null,
      // Rien plutôt qu'un objet vide : une sonde qui n'a pas abouti n'a rien
      // appris, et un `{}` en base se lit comme un serveur sans joueurs.
      queryPayload: status ?? null,
    });

    return status;
  }
}

/** Le protocole du jeu, sur le port qu'il écoute. */
function query(target: ProbeTarget): Promise<GameStatus | null> {
  switch (target.protocol) {
    case "a2s":
      return queryA2s(target.host, target.queryPort);
    case "cfx":
      return queryCfx(target.host, target.queryPort);
    default:
      return ping(target.host, target.queryPort);
  }
}

/**
 * L'adresse à laquelle on frappe.
 *
 * Celle des joueurs, alias compris : c'est le seul sens utile de « joignable ».
 * Un serveur qui répond sur la boucle locale du node mais pas sur son adresse
 * publique est injoignable pour ceux qui comptent.
 *
 * `0.0.0.0` est une consigne d'écoute, pas une adresse : un egg qui fait
 * écouter le conteneur sur toutes les interfaces range cette valeur dans
 * l'allocation, et s'y connecter viserait la machine du panel elle-même. Le
 * nom du node reste alors la seule adresse qui ait un sens.
 */
export function probeHost(row: { ip: string; ipAlias: string | null; fqdn: string }): string {
  const bindAll = row.ip === "0.0.0.0" || row.ip === "::";
  return row.ipAlias ?? (bindAll ? row.fqdn : row.ip);
}

/**
 * La poignée de main d'état, en clair.
 *
 * Le protocole tient en deux temps : on envoie la poignée de main suivie de la
 * demande d'état, le serveur répond par un JSON. La réponse arrive rarement en
 * un seul paquet, d'où l'accumulation : conclure au premier morceau donnerait
 * « injoignable » pour un serveur qui répondait très bien.
 *
 * Rend `null` dès que quelque chose cloche — délai, port fermé, interlocuteur
 * qui n'est pas un serveur Minecraft. Aucun de ces cas n'est distingué, parce
 * qu'aucun ne change ce qu'il faut en dire : les joueurs n'entrent pas.
 */
export function ping(
  host: string,
  port: number,
  timeoutMs = TIMEOUT_MS,
): Promise<MinecraftStatus | null> {
  return new Promise((resolve) => {
    const socket = new Socket();
    let chunks = Buffer.alloc(0);
    let settled = false;

    const finish = (status: MinecraftStatus | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(echeance);
      socket.destroy();
      resolve(status);
    };

    // Échéance fixe, comme pour A2S et FiveM, et non `socket.setTimeout` : ce
    // dernier ne mesure que l'inactivité et repart à chaque octet reçu. Un
    // serveur qui en envoyait un toutes les deux secondes tenait la sonde sans
    // fin, et avec elle tout le lot — donc la surveillance du parc entier.
    const echeance = setTimeout(() => finish(null), timeoutMs);
    socket.on("error", () => finish(null));
    // Fin de flux sans réponse exploitable : le serveur a raccroché.
    socket.on("close", () => finish(null));

    socket.on("data", (chunk) => {
      chunks = Buffer.concat([chunks, chunk]);
      if (chunks.length > STATUS_FRAME_MAX_BYTES) return finish(null);
      const status = readStatusResponse(chunks);
      // `null` signifie « trame encore incomplète » : on attend la suite
      // jusqu'au délai, plutôt que de conclure sur un début de JSON.
      if (status) finish(status);
    });

    socket.connect(port, host, () => {
      socket.write(buildStatusRequest(host, port));
    });
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
