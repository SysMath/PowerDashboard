import { RUNTIME_STATE_FRESH_WINDOW } from "@gamedashboard/contracts";
import {
  allocations,
  type Database,
  eggs,
  nodes,
  serverSubusers,
  servers,
} from "@gamedashboard/db";
import { Inject, Injectable } from "@nestjs/common";
import { eq, or, sql } from "drizzle-orm";
import { DATABASE } from "../../common/database.provider";

export interface ClientServer {
  id: string;
  shortId: string;
  name: string;
  description: string | null;
  address: string;
  nodeName: string;
  /**
   * Depuis quand la machine qui héberge ce serveur ne répond plus.
   *
   * `null` quand elle répond. Renseigné, il change la lecture de tout le
   * reste : `runtimeState` et les mesures ne sont pas « zéro », ils sont
   * **inconnus**, et c'est cela qu'il faut dire.
   */
  nodeUnreachableSince: string | null;
  game: string;
  memoryMaxMb: number;
  diskMaxMb: number;
  cpuMaxPct: number;
  /** État de gestion, ou `null` quand rien n'est en cours (§8.2). */
  state: string | null;
  /**
   * État du conteneur au dernier relevé — « running », « offline »… ou `null`.
   *
   * Distinct de `state`, et c'est tout l'objet : `state` dit ce que **le
   * panel** est en train de faire au serveur, celui-ci dit ce que **le daemon**
   * a observé. Les confondre, c'est ce qui faisait afficher « hors ligne » sur
   * la liste un serveur parfaitement en marche.
   */
  runtimeState: string | null;
  /** Consommation au dernier relevé. `null` veut dire « pas mesuré », pas zéro. */
  cpuPct: number | null;
  memoryMb: number | null;
  diskMb: number | null;
  /**
   * Joueurs connectés d'après la dernière sonde de jeu, ou `null`.
   *
   * `null` veut dire « pas mesuré » — serveur à l'arrêt, jeu sans sonde, ou
   * sonde qui n'a pas abouti. Le confondre avec zéro afficherait « 0 joueur »
   * sur un serveur plein dont on n'a simplement pas de nouvelles.
   */
  players: number | null;
  maxPlayers: number | null;
  isOwner: boolean;
}

/** Voir `RUNTIME_STATE_FRESH_WINDOW` : la fenêtre est partagée avec l'administration. */
const FRESH_WINDOW = RUNTIME_STATE_FRESH_WINDOW;

@Injectable()
export class ClientServersService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Serveurs accessibles à un utilisateur.
   *
   * La condition d'accès est appliquée par la requête elle-même, et non par un
   * filtre appliqué après coup sur une liste complète : un oubli de filtre en
   * mémoire passe les tests et fuite en production, alors qu'une clause absente
   * ici se voit immédiatement.
   *
   * Deux titres d'accès : être propriétaire, ou être sous-utilisateur ayant
   * accepté l'invitation. Une invitation en attente ne donne aucun droit.
   */
  async forUser(userId: string): Promise<ClientServer[]> {
    return this.rows(
      or(
        eq(servers.ownerId, userId),
        sql`${serverSubusers.userId} = ${userId} and ${serverSubusers.acceptedAt} is not null`,
      ),
      userId,
    );
  }

  /**
   * La requête, une fois, pour les deux usages.
   *
   * `condition` dit **quels** serveurs, `viewerId` seulement pour qui l'on
   * calcule `isOwner`. Les séparer est le point : lister n'est pas ouvrir, et
   * mêler les deux avait fait passer la lecture unitaire par le filtre de la
   * liste — donc refuser un serveur à qui avait le droit de le gérer.
   */
  private async rows(
    condition: ReturnType<typeof or> | ReturnType<typeof eq>,
    viewerId: string,
  ): Promise<ClientServer[]> {
    const rows = await this.db
      .selectDistinct({
        id: servers.id,
        shortId: servers.uuidShort,
        name: servers.name,
        description: servers.description,
        ip: allocations.ip,
        ipAlias: allocations.ipAlias,
        port: allocations.port,
        nodeName: nodes.name,
        nodeFqdn: nodes.fqdn,
        /*
         * Depuis quand la machine ne répond plus, ou `null` si elle répond.
         *
         * Le panel le savait déjà — la veille des nodes l'écrit — et ne le
         * disait à personne. Le client voyait « Hors ligne », ce qui est une
         * affirmation sur son serveur alors que nous n'en savons rien : la
         * machine est muette, le conteneur tourne peut-être encore.
         */
        nodeUnreachableSince: nodes.unreachableSince,
        game: eggs.name,
        memoryMaxMb: servers.memoryMb,
        diskMaxMb: servers.diskMb,
        cpuMaxPct: servers.cpuPct,
        state: servers.state,
        ownerId: servers.ownerId,
        /*
         * Le dernier relevé, et lui seul.
         *
         * Lu en sous-requêtes plutôt que joint : `server_metrics` est une
         * histoire, et une jointure ordinaire multiplierait chaque serveur par
         * son nombre de mesures. Chacune s'appuie sur l'index
         * `(server_id, at)` et ne lit qu'une ligne.
         *
         * C'est aussi la seule source honnête de l'état d'exécution : le panel
         * ne le recopie **pas** sur `servers.state`, qui porte l'état de
         * gestion. La liste le devinait donc, et devinait « hors ligne ».
         */
        runtimeState: sql<string | null>`(
          select m.state from server_metrics m
          where m.server_id = ${servers.id} and m.at > now() - ${FRESH_WINDOW}::interval
          order by m.at desc limit 1
        )`,
        cpuPct: sql<number | null>`(
          select m.cpu_pct from server_metrics m
          where m.server_id = ${servers.id} and m.at > now() - ${FRESH_WINDOW}::interval
          order by m.at desc limit 1
        )`,
        memBytes: sql<number | null>`(
          select m.mem_bytes::float8 from server_metrics m
          where m.server_id = ${servers.id} and m.at > now() - ${FRESH_WINDOW}::interval
          order by m.at desc limit 1
        )`,
        diskBytes: sql<number | null>`(
          select m.disk_bytes::float8 from server_metrics m
          where m.server_id = ${servers.id} and m.at > now() - ${FRESH_WINDOW}::interval
          order by m.at desc limit 1
        )`,
        /*
         * Seules les sondes **abouties** comptent. Une sonde manquée n'apprend
         * rien sur le nombre de joueurs, et laisser passer son `null` dirait la
         * même chose — mais l'écrire ainsi rend la règle explicite.
         */
        players: sql<number | null>`(
          select (h.query_payload ->> 'playersOnline')::int from server_health h
          where h.server_id = ${servers.id}
            and h.reachable
            and h.at > now() - ${FRESH_WINDOW}::interval
          order by h.at desc limit 1
        )`,
        maxPlayers: sql<number | null>`(
          select (h.query_payload ->> 'playersMax')::int from server_health h
          where h.server_id = ${servers.id}
            and h.reachable
            and h.at > now() - ${FRESH_WINDOW}::interval
          order by h.at desc limit 1
        )`,
      })
      .from(servers)
      .innerJoin(allocations, eq(servers.allocationId, allocations.id))
      .innerJoin(nodes, eq(servers.nodeId, nodes.id))
      .innerJoin(eggs, eq(servers.eggId, eggs.id))
      .leftJoin(serverSubusers, eq(serverSubusers.serverId, servers.id))
      .where(condition);

    return rows.map((row) => ({
      id: row.id,
      shortId: row.shortId,
      name: row.name,
      description: row.description,
      address: `${publicHost(row)}:${row.port}`,
      nodeName: row.nodeName,
      nodeUnreachableSince: row.nodeUnreachableSince,
      game: row.game,
      memoryMaxMb: row.memoryMaxMb,
      diskMaxMb: row.diskMaxMb,
      cpuMaxPct: row.cpuMaxPct,
      state: row.state,
      runtimeState: row.runtimeState,
      cpuPct: row.cpuPct,
      // Les octets deviennent des mégaoctets ici, parce que c'est l'unité de
      // toutes les limites affichées à côté. La table, elle, garde les octets.
      memoryMb: row.memBytes === null ? null : Math.round(row.memBytes / 1024 / 1024),
      diskMb: row.diskBytes === null ? null : Math.round(row.diskBytes / 1024 / 1024),
      players: row.players,
      maxPlayers: row.maxPlayers,
      isOwner: row.ownerId === viewerId,
    }));
  }

  /**
   * Un serveur précis, si l'utilisateur y a accès.
   *
   * Le contrôle passe par `forUser` plutôt que par une requête distincte : deux
   * implémentations de la même règle d'accès finiraient par diverger, et c'est
   * toujours celle de la lecture unitaire qu'on oublie de resserrer.
   *
   * `null` et non une exception : le contrôleur traduit en 404, sans distinguer
   * « ce serveur n'existe pas » de « il ne vous appartient pas ». Toute
   * distinction permettrait d'énumérer les serveurs des autres.
   */
  async forUserById(userId: string, serverId: string): Promise<ClientServer | null> {
    const accessible = await this.forUser(userId);
    return accessible.find((server) => server.id === serverId) ?? null;
  }

  /**
   * Un serveur, **sans condition de propriété**.
   *
   * Lister et ouvrir ne sont pas la même question, et les confondre a coûté un
   * défaut : « mes serveurs » doit rester la liste de ce qui est à moi — un
   * administrateur n'a pas à y voir tout le parc — mais ouvrir un serveur
   * précis relève du droit d'accès, que `ServerAccessService` sait seul
   * arbitrer. La lecture unitaire passait par la liste, si bien qu'un
   * administrateur et un revendeur se voyaient répondre « Serveur
   * introuvable » sur un serveur qu'ils avaient le droit de gérer — et dont
   * toutes les autres routes leur obéissaient déjà.
   *
   * **L'accès doit donc être vérifié par l'appelant** avant d'appeler cette
   * méthode. Elle ne contrôle rien : c'est une lecture.
   */
  async byId(serverId: string, viewerId: string): Promise<ClientServer | null> {
    const rows = await this.rows(eq(servers.id, serverId), viewerId);
    return rows[0] ?? null;
  }

  /** La machine du serveur, pour ce qu'elle offre. Gardée hors de la vue client. */
  async nodeOf(serverId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ nodeId: servers.nodeId })
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);
    return row?.nodeId ?? null;
  }

  /**
   * Les commandes que l'egg du serveur propose à la console.
   *
   * Même règle que `byId` : l'accès est vérifié par l'appelant. Une liste vide
   * pour un serveur inconnu plutôt qu'une erreur — l'appelant a déjà répondu
   * 404 s'il le fallait.
   */
  async consoleCommands(serverId: string): Promise<string[]> {
    const [row] = await this.db
      .select({ commands: eggs.consoleCommands })
      .from(servers)
      .innerJoin(eggs, eq(servers.eggId, eggs.id))
      .where(eq(servers.id, serverId))
      .limit(1);
    return row?.commands ?? [];
  }
}

/**
 * L'adresse à donner à un joueur.
 *
 * `0.0.0.0` est une consigne d'écoute — « toutes les interfaces » — et non une
 * adresse : l'afficher fait recopier à un client quelque chose qui ne se
 * connecte nulle part. Le nom du node est alors ce qu'il faut lire, puisque
 * c'est la machine qui publie le port.
 */
function publicHost(row: { ip: string; ipAlias: string | null; nodeFqdn: string }): string {
  const bindAll = row.ip === "0.0.0.0" || row.ip === "::";
  return row.ipAlias ?? (bindAll ? row.nodeFqdn : row.ip);
}
