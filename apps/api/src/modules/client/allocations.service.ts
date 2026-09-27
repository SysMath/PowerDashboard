import { allocations, type Database, servers } from "@gamedashboard/db";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, count, eq, isNull, sql } from "drizzle-orm";
import { DATABASE } from "../../common/database.provider";
import { SubdomainsService } from "../dns/subdomains.service";
import { WingsClientService } from "../wings/wings-client.service";

export interface ClientAllocation {
  id: string;
  ip: string;
  alias: string | null;
  port: number;
  notes: string | null;
  isPrimary: boolean;
}

/**
 * Ports attribués à un serveur.
 *
 * Un port n'est pas créé : il est **pris** dans le stock du node, puis rendu.
 * La nuance compte — le stock appartient à l'administrateur, et un client ne
 * peut pas décider d'écouter sur un port que personne ne lui a ouvert.
 */
@Injectable()
export class AllocationsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(WingsClientService) private readonly wings: WingsClientService,
    @Inject(SubdomainsService) private readonly subdomains: SubdomainsService,
  ) {}

  async list(serverId: string): Promise<ClientAllocation[]> {
    const [server] = await this.db
      .select({ primaryId: servers.allocationId })
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);

    const rows = await this.db
      .select()
      .from(allocations)
      .where(eq(allocations.serverId, serverId))
      .orderBy(asc(allocations.ip), asc(allocations.port));

    return rows.map((row) => ({
      id: row.id,
      ip: row.ip,
      alias: row.ipAlias,
      port: row.port,
      notes: row.notes,
      isPrimary: row.id === server?.primaryId,
    }));
  }

  async quota(serverId: string): Promise<{ used: number; limit: number }> {
    const [[used], [server]] = await Promise.all([
      this.db.select({ n: count() }).from(allocations).where(eq(allocations.serverId, serverId)),
      this.db
        .select({ limit: servers.allocationLimit })
        .from(servers)
        .where(eq(servers.id, serverId)),
    ]);
    return { used: used?.n ?? 0, limit: server?.limit ?? 0 };
  }

  /**
   * Prend un port libre sur le node du serveur.
   *
   * Le client ne choisit pas lequel : le laisser désigner un port lui
   * permettrait de viser celui d'un voisin, ou un port du système que
   * l'administrateur n'a pas mis dans le stock.
   *
   * L'attribution passe par un `UPDATE … WHERE server_id IS NULL` unique plutôt
   * que par une lecture suivie d'une écriture : deux demandes simultanées
   * liraient sinon le même port libre, et la seconde écraserait la première.
   */
  async claim(serverId: string): Promise<ClientAllocation> {
    /*
     * Le compte et la prise dans la même transaction, sous le verrou de la
     * ligne du serveur.
     *
     * Le verrou du port pris ne suffisait pas : il empêche deux demandes de
     * prendre le **même** port, pas de dépasser le quota. Cinq demandes
     * lancées ensemble lisaient toutes « 1 sur 2 », hors transaction, et
     * toutes passaient. Verrouiller le serveur les met en file : la seconde
     * relit le compte une fois la première validée.
     */
    const claimed = await this.db.transaction(async (tx) => {
      const [server] = await tx
        .select({ nodeId: servers.nodeId, limit: servers.allocationLimit })
        .from(servers)
        .where(eq(servers.id, serverId))
        .limit(1)
        .for("update");
      if (!server) throw new NotFoundException("Serveur introuvable.");

      const [counted] = await tx
        .select({ n: count() })
        .from(allocations)
        .where(eq(allocations.serverId, serverId));
      const used = counted?.n ?? 0;
      if (used >= server.limit) {
        throw new ConflictException(
          server.limit === 0
            ? "Ce serveur n'a pas de quota de ports."
            : `Quota atteint (${used}/${server.limit}). Libérez un port avant d'en prendre un autre.`,
        );
      }

      const [row] = await tx
        .update(allocations)
        .set({ serverId, updatedAt: new Date().toISOString() })
        .where(
          sql`${allocations.id} = (
            select ${allocations.id} from ${allocations}
            where ${allocations.nodeId} = ${server.nodeId} and ${allocations.serverId} is null
            order by ${allocations.port}
            limit 1
            for update skip locked
          )`,
        )
        .returning();

      if (!row) {
        throw new ConflictException("Aucun port disponible sur ce node. Contactez le support.");
      }
      return row;
    });

    await this.sync(serverId);

    return {
      id: claimed.id,
      ip: claimed.ip,
      alias: claimed.ipAlias,
      port: claimed.port,
      notes: claimed.notes,
      isPrimary: false,
    };
  }

  /**
   * Désigne le port principal.
   *
   * C'est celui que le jeu écoute et que le daemon inscrit dans la
   * configuration du conteneur. Le changer exige donc une resynchronisation,
   * faute de quoi le serveur continuerait d'écouter l'ancien.
   */
  async setPrimary(serverId: string, allocationId: string): Promise<void> {
    await this.mustOwn(serverId, allocationId);
    await this.db
      .update(servers)
      .set({ allocationId, updatedAt: new Date().toISOString() })
      .where(eq(servers.id, serverId));

    await this.sync(serverId);
    // Le sous-domaine vise le port principal : il le suit.
    void this.subdomains.refresh(serverId);
  }

  async setNotes(serverId: string, allocationId: string, notes: string | null): Promise<void> {
    await this.mustOwn(serverId, allocationId);
    // Pas de resynchronisation : une note est un texte du panel, que le daemon
    // ne lit jamais. L'appeler ici ferait redémarrer un aller-retour réseau
    // pour rien, et ferait croire que le commentaire touche au conteneur.
    await this.db
      .update(allocations)
      .set({ notes, updatedAt: new Date().toISOString() })
      .where(eq(allocations.id, allocationId));
  }

  /**
   * Rend un port au node.
   *
   * Le port principal est refusé : le serveur n'aurait plus d'adresse, et le
   * daemon ne saurait plus quoi publier. Il faut d'abord en désigner un autre.
   */
  async release(serverId: string, allocationId: string): Promise<void> {
    const [server] = await this.db
      .select({ primaryId: servers.allocationId })
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);

    if (server?.primaryId === allocationId) {
      throw new ConflictException(
        "Ce port est le port principal. Désignez-en un autre avant de le libérer.",
      );
    }

    await this.mustOwn(serverId, allocationId);
    await this.db
      .update(allocations)
      .set({ serverId: null, notes: null, updatedAt: new Date().toISOString() })
      .where(and(eq(allocations.id, allocationId), eq(allocations.serverId, serverId)));

    await this.sync(serverId);
  }

  /**
   * Prévient le daemon, sans faire échouer l'opération s'il ne répond pas.
   *
   * La base fait foi : le port est attribué, que le node soit joignable ou non.
   * Remonter l'échec ferait croire que l'attribution n'a pas eu lieu, et
   * inviterait à la refaire — en consommant un deuxième port. Le daemon relit
   * de toute façon sa configuration au démarrage suivant.
   */
  private async sync(serverId: string): Promise<void> {
    await this.wings.syncServer(serverId).catch(() => undefined);
  }

  /** L'allocation doit appartenir à *ce* serveur, condition comprise dans la requête. */
  private async mustOwn(serverId: string, allocationId: string) {
    const [row] = await this.db
      .select({ id: allocations.id })
      .from(allocations)
      .where(and(eq(allocations.id, allocationId), eq(allocations.serverId, serverId)))
      .limit(1);

    if (!row) throw new NotFoundException("Port introuvable sur ce serveur.");
    return row;
  }

  /** Ports encore libres sur le node, pour annoncer le stock avant de cliquer. */
  async availableOnNode(serverId: string): Promise<number> {
    const [server] = await this.db
      .select({ nodeId: servers.nodeId })
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);
    if (!server) return 0;

    const [row] = await this.db
      .select({ n: count() })
      .from(allocations)
      .where(and(eq(allocations.nodeId, server.nodeId), isNull(allocations.serverId)));

    return row?.n ?? 0;
  }
}
