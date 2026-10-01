import {
  type AgentOrderKind,
  type AgentSnapshotOrder,
  type AgentSnapshotReport,
  type AgentSnapshotState,
  agentSettingsFromPolicy,
  type NodeSnapshotStatus,
  type ServerSnapshotsMeta,
  type ServerSnapshotView,
  SNAPSHOT_REQUESTED_KEEP_HOURS,
  type SnapshotCause,
  SnapshotCause as SnapshotCauseSchema,
} from "@gamedashboard/contracts";
import {
  type Database,
  nodeSnapshots,
  servers,
  snapshotOrders,
  volumeSnapshotPins,
  volumeSnapshots,
} from "@gamedashboard/db";
import {
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, desc, eq, gt, inArray, isNull, lt, notInArray, sql } from "drizzle-orm";
import { DATABASE } from "../../common/database.provider";
import { NodeCapabilitiesService } from "../node-agent/node-capabilities.service";
import { SnapshotPolicyService } from "./snapshot-policy.service";

/** Un ordre sans compte rendu au-delà est clos en échec : l'agent s'est tu. */
export const ORDER_TIMEOUT_MS = 30 * 60_000;
/** Au plus, par relevé, pour tenir dans les bornes de l'agent (`OrdresMax`). */
const ORDERS_PER_STATE = 100;

const EXPIRED = "L'agent de node n'a pas rendu compte de cet ordre à temps.";

export interface OrderReceipt {
  orderId: string;
  /** Déjà demandée et pas encore faite : rien de neuf n'a été créé. */
  existing: boolean;
}

/**
 * Instantanés de volumes côté panel (ADR 0009) : le registre tenu d'après
 * les rapports de l'agent, les ordres qu'il tire, et ce que clients et
 * administration en voient.
 *
 * Ce que le node offre se décide par `NodeCapabilitiesService` et nulle part
 * ailleurs ; ce que la machine sait faire (btrfs, ZFS, espace libre) se lit
 * dans le dernier rapport de l'agent.
 */
@Injectable()
export class SnapshotsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(SnapshotPolicyService) private readonly policies: SnapshotPolicyService,
    @Inject(NodeCapabilitiesService) private readonly capabilities: NodeCapabilitiesService,
  ) {}

  /* --- Côté agent ----------------------------------------------------------- */

  /**
   * Ce que l'agent applique : réglages, instantanés à garder, ordres.
   *
   * Fonction coupée (interrupteur global, réglage du node) : aucune prise
   * automatique, et seules les destructions partent, pour que l'agent puisse
   * encore libérer la place que le panel lui demande de libérer.
   */
  async agentState(nodeId: string): Promise<AgentSnapshotState> {
    const [{ policy }, capability] = await Promise.all([
      this.policies.forNode(nodeId),
      this.capabilities.forNode(nodeId).then((c) => c.instantanes),
    ]);
    const active = capability.offered && policy.enabled;
    await this.expireOrders(nodeId);

    const pinned = await this.db
      .selectDistinct({ name: volumeSnapshots.name })
      .from(volumeSnapshotPins)
      .innerJoin(volumeSnapshots, eq(volumeSnapshots.id, volumeSnapshotPins.snapshotId))
      .where(and(eq(volumeSnapshots.nodeId, nodeId), isNull(volumeSnapshots.goneAt)));

    // Manuels et de sûreté : gardés un jour, épinglés ou non.
    const requested = await this.db
      .select({ name: volumeSnapshots.name })
      .from(volumeSnapshots)
      .where(
        and(
          eq(volumeSnapshots.nodeId, nodeId),
          isNull(volumeSnapshots.goneAt),
          inArray(volumeSnapshots.cause, ["manual", "safety"]),
          gt(
            volumeSnapshots.takenAt,
            new Date(Date.now() - SNAPSHOT_REQUESTED_KEEP_HOURS * 3_600_000).toISOString(),
          ),
        ),
      );

    const pending = await this.db
      .select()
      .from(snapshotOrders)
      .where(and(eq(snapshotOrders.nodeId, nodeId), eq(snapshotOrders.state, "pending")))
      .orderBy(asc(snapshotOrders.createdAt))
      .limit(ORDERS_PER_STATE);

    const ordres: AgentSnapshotOrder[] = pending
      .filter((order) => active || order.kind === "detruire")
      .map((order) => ({
        id: order.id,
        type: order.kind as AgentOrderKind,
        ...(order.serverId ? { serveur: order.serverId } : {}),
        ...(order.snapshotName ? { instantane: order.snapshotName } : {}),
      }));

    return {
      reglages: agentSettingsFromPolicy(policy, active),
      gardes: [...new Set([...pinned, ...requested].map((row) => row.name))],
      ordres,
    };
  }

  /**
   * Range un rapport de l'agent, en une transaction : état de la machine,
   * registre des instantanés (l'agent fait foi), résultats des ordres.
   */
  async applyReport(nodeId: string, report: AgentSnapshotReport): Promise<void> {
    const now = new Date().toISOString();
    await this.db.transaction(async (tx) => {
      const status = {
        filesystem: report.systeme === "" ? null : report.systeme,
        reason: report.systeme === "" ? (report.motif ?? "Instantanés impossibles.") : null,
        totalBytes: report.espace?.total ?? null,
        freeBytes: report.espace?.libre ?? null,
        suspended: report.suspendu,
        reportedAt: now,
      };
      await tx
        .insert(nodeSnapshots)
        .values({ nodeId, ...status })
        .onConflictDoUpdate({ target: nodeSnapshots.nodeId, set: { ...status, updatedAt: now } });

      // Sans système d'instantanés, l'agent n'a rien listé : ce n'est pas
      // une disparition, et le registre reste tel quel.
      if (report.systeme !== "") {
        const names = report.instantanes.map((s) => s.nom);
        for (const snapshot of report.instantanes) {
          await tx
            .insert(volumeSnapshots)
            .values({
              nodeId,
              name: snapshot.nom,
              takenAt: new Date(snapshot.pris_le).toISOString(),
              servers: snapshot.serveurs,
              bytes: snapshot.octets ?? null,
            })
            .onConflictDoUpdate({
              target: [volumeSnapshots.nodeId, volumeSnapshots.name],
              set: {
                servers: snapshot.serveurs,
                bytes: snapshot.octets ?? null,
                goneAt: null,
                updatedAt: now,
              },
            });
        }
        await tx
          .update(volumeSnapshots)
          .set({ goneAt: now, updatedAt: now })
          .where(
            and(
              eq(volumeSnapshots.nodeId, nodeId),
              isNull(volumeSnapshots.goneAt),
              names.length > 0 ? notInArray(volumeSnapshots.name, names) : sql`true`,
            ),
          );
      }

      for (const result of report.ordres) {
        const [order] = await tx
          .update(snapshotOrders)
          .set({
            state: result.etat === "reussi" ? "done" : "failed",
            result: result.instantane ?? null,
            error: result.etat === "echoue" ? (result.erreur ?? "Échec sans détail.") : null,
            completedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(snapshotOrders.id, result.id),
              eq(snapshotOrders.nodeId, nodeId),
              eq(snapshotOrders.state, "pending"),
            ),
          )
          .returning();
        // Un instantané pris pour quelqu'un porte sa cause et son demandeur.
        if (order?.cause && result.instantane) {
          await tx
            .update(volumeSnapshots)
            .set({
              cause: SnapshotCauseSchema.parse(order.cause),
              serverId: order.serverId,
              requestedBy: order.requestedBy,
              updatedAt: now,
            })
            .where(
              and(
                eq(volumeSnapshots.nodeId, nodeId),
                eq(volumeSnapshots.name, result.instantane),
                eq(volumeSnapshots.cause, "auto"),
              ),
            );
        }
      }
    });
  }

  /** Ordres restés sans compte rendu : clos en échec. */
  async expireOrders(nodeId: string): Promise<void> {
    const now = new Date();
    await this.db
      .update(snapshotOrders)
      .set({
        state: "failed",
        error: EXPIRED,
        completedAt: now.toISOString(),
        updatedAt: now.toISOString(),
      })
      .where(
        and(
          eq(snapshotOrders.nodeId, nodeId),
          eq(snapshotOrders.state, "pending"),
          lt(snapshotOrders.createdAt, new Date(now.getTime() - ORDER_TIMEOUT_MS).toISOString()),
        ),
      );
  }

  /* --- Côté serveur --------------------------------------------------------- */

  private async server(serverId: string) {
    const [row] = await this.db
      .select({ id: servers.id, nodeId: servers.nodeId, snapshotLimit: servers.snapshotLimit })
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);
    if (!row) throw new NotFoundException("Serveur introuvable.");
    return row;
  }

  async status(nodeId: string): Promise<NodeSnapshotStatus> {
    const [row] = await this.db
      .select()
      .from(nodeSnapshots)
      .where(eq(nodeSnapshots.nodeId, nodeId))
      .limit(1);
    return {
      filesystem: (row?.filesystem as NodeSnapshotStatus["filesystem"]) ?? null,
      reason: row?.reason ?? (row?.reportedAt ? null : "L'agent n'a encore rien rapporté."),
      freeBytes: row?.freeBytes ?? null,
      totalBytes: row?.totalBytes ?? null,
      suspended: row?.suspended ?? false,
      reportedAt: row?.reportedAt ?? null,
    };
  }

  /**
   * Les instantanés du node **actuel** du serveur qui le contiennent. Après
   * un transfert, ceux de l'ancien node ne servent plus et n'apparaissent
   * plus (ADR 0009) ; la rotation de l'ancien node les emporte.
   */
  async listForServer(
    serverId: string,
  ): Promise<{ data: ServerSnapshotView[]; meta: ServerSnapshotsMeta }> {
    const server = await this.server(serverId);
    const capability = await this.capabilities.require(server.nodeId, "instantanes", "read");
    const [{ policy }, status] = await Promise.all([
      this.policies.forNode(server.nodeId),
      this.status(server.nodeId),
    ]);
    await this.expireOrders(server.nodeId);

    const rows = await this.db
      .select({
        name: volumeSnapshots.name,
        takenAt: volumeSnapshots.takenAt,
        cause: volumeSnapshots.cause,
        bytes: volumeSnapshots.bytes,
        pinLabel: volumeSnapshotPins.label,
        pinnedAt: volumeSnapshotPins.createdAt,
      })
      .from(volumeSnapshots)
      .leftJoin(
        volumeSnapshotPins,
        and(
          eq(volumeSnapshotPins.snapshotId, volumeSnapshots.id),
          eq(volumeSnapshotPins.serverId, serverId),
        ),
      )
      .where(
        and(
          eq(volumeSnapshots.nodeId, server.nodeId),
          isNull(volumeSnapshots.goneAt),
          sql`${serverId}::uuid = any(${volumeSnapshots.servers})`,
        ),
      )
      .orderBy(desc(volumeSnapshots.takenAt));

    const maxAgeMs = policy.maxAgeDays * 86_400_000;
    const data: ServerSnapshotView[] = rows.map((row) => ({
      name: row.name,
      takenAt: new Date(row.takenAt).toISOString(),
      cause: SnapshotCauseSchema.catch("auto").parse(row.cause),
      expiresAt: new Date(new Date(row.takenAt).getTime() + maxAgeMs).toISOString(),
      pinned: row.pinnedAt !== null,
      pinLabel: row.pinLabel,
      bytes: row.bytes,
    }));

    const [pending] = await this.db
      .select({ id: snapshotOrders.id })
      .from(snapshotOrders)
      .where(
        and(
          eq(snapshotOrders.serverId, serverId),
          eq(snapshotOrders.kind, "prendre"),
          eq(snapshotOrders.state, "pending"),
        ),
      )
      .limit(1);

    return {
      data,
      meta: {
        status,
        writable: capability.writable && policy.enabled && status.filesystem !== null,
        manualAllowed: policy.manualAllowed,
        pinLimit: server.snapshotLimit ?? policy.defaultPinLimit,
        pinned: data.filter((s) => s.pinned).length,
        pending: pending !== undefined,
        nextManualAt: await this.nextManualAt(serverId, policy.manualCooldownMinutes),
      },
    };
  }

  private async nextManualAt(serverId: string, cooldownMinutes: number): Promise<string | null> {
    if (cooldownMinutes <= 0) return null;
    const [last] = await this.db
      .select({ at: snapshotOrders.createdAt })
      .from(snapshotOrders)
      .where(
        and(
          eq(snapshotOrders.serverId, serverId),
          eq(snapshotOrders.kind, "prendre"),
          eq(snapshotOrders.cause, "manual"),
        ),
      )
      .orderBy(desc(snapshotOrders.createdAt))
      .limit(1);
    if (!last) return null;
    const next = new Date(last.at).getTime() + cooldownMinutes * 60_000;
    return next > Date.now() ? new Date(next).toISOString() : null;
  }

  /** Refuse une écriture que la machine ne peut pas servir, avec la raison. */
  private async requireWritable(nodeId: string) {
    await this.capabilities.require(nodeId, "instantanes", "write");
    const [{ policy }, status] = await Promise.all([
      this.policies.forNode(nodeId),
      this.status(nodeId),
    ]);
    if (!policy.enabled) {
      throw new ConflictException("Les instantanés sont désactivés sur cette machine.");
    }
    if (!status.filesystem) {
      throw new ConflictException(
        status.reason ?? "Cette machine ne peut pas prendre d'instantané.",
      );
    }
    return { policy, status };
  }

  /**
   * Demande un instantané manuel : pris par l'agent à son relevé suivant.
   *
   * Une demande déjà en attente pour ce serveur est rendue telle quelle :
   * cliquer deux fois ne prend pas deux instantanés.
   */
  async take(serverId: string, requestedBy: string | null): Promise<OrderReceipt> {
    const server = await this.server(serverId);
    const { policy, status } = await this.requireWritable(server.nodeId);
    if (!policy.manualAllowed) {
      throw new ConflictException("Les instantanés manuels ne sont pas permis sur cette machine.");
    }
    if (status.suspended) {
      throw new ConflictException(
        "Espace disque insuffisant sur la machine : les instantanés sont suspendus.",
      );
    }
    await this.expireOrders(server.nodeId);
    const [pending] = await this.db
      .select({ id: snapshotOrders.id })
      .from(snapshotOrders)
      .where(
        and(
          eq(snapshotOrders.serverId, serverId),
          eq(snapshotOrders.kind, "prendre"),
          eq(snapshotOrders.state, "pending"),
        ),
      )
      .limit(1);
    if (pending) return { orderId: pending.id, existing: true };

    const next = await this.nextManualAt(serverId, policy.manualCooldownMinutes);
    if (next) {
      throw new HttpException(
        `Un instantané vient d'être demandé pour ce serveur. Nouvelle demande possible à partir de ${next}.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const [order] = await this.db
      .insert(snapshotOrders)
      .values({
        nodeId: server.nodeId,
        kind: "prendre",
        cause: "manual" satisfies SnapshotCause,
        serverId,
        requestedBy,
      })
      .returning({ id: snapshotOrders.id });
    return { orderId: (order as { id: string }).id, existing: false };
  }

  private async snapshotOf(serverId: string, nodeId: string, name: string) {
    const [row] = await this.db
      .select({ id: volumeSnapshots.id })
      .from(volumeSnapshots)
      .where(
        and(
          eq(volumeSnapshots.nodeId, nodeId),
          eq(volumeSnapshots.name, name),
          isNull(volumeSnapshots.goneAt),
          sql`${serverId}::uuid = any(${volumeSnapshots.servers})`,
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException("Instantané introuvable pour ce serveur.");
    return row;
  }

  /**
   * Épingle un instantané pour ce serveur, dans la limite du serveur.
   * L'agent le garde hors rotation, jamais au-delà de la durée maximale.
   */
  async pin(serverId: string, name: string, label: string | null, by: string | null) {
    const server = await this.server(serverId);
    await this.capabilities.require(server.nodeId, "instantanes", "read");
    const snapshot = await this.snapshotOf(serverId, server.nodeId, name);
    const { policy } = await this.policies.forNode(server.nodeId);
    const limit = server.snapshotLimit ?? policy.defaultPinLimit;

    await this.db.transaction(async (tx) => {
      // Le serveur verrouillé : deux épinglages simultanés ne dépassent pas la limite.
      await tx
        .select({ id: servers.id })
        .from(servers)
        .where(eq(servers.id, serverId))
        .for("update");
      const [{ count } = { count: 0 }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(volumeSnapshotPins)
        .innerJoin(volumeSnapshots, eq(volumeSnapshots.id, volumeSnapshotPins.snapshotId))
        .where(
          and(
            eq(volumeSnapshotPins.serverId, serverId),
            eq(volumeSnapshots.nodeId, server.nodeId),
            isNull(volumeSnapshots.goneAt),
            sql`${volumeSnapshotPins.snapshotId} <> ${snapshot.id}`,
          ),
        );
      if (count >= limit) {
        throw new ConflictException(
          `Limite atteinte : ${limit} instantané${limit > 1 ? "s" : ""} épinglé${limit > 1 ? "s" : ""} au plus pour ce serveur.`,
        );
      }
      await tx
        .insert(volumeSnapshotPins)
        .values({ snapshotId: snapshot.id, serverId, label, createdBy: by })
        .onConflictDoUpdate({
          target: [volumeSnapshotPins.snapshotId, volumeSnapshotPins.serverId],
          set: { label, updatedAt: new Date().toISOString() },
        });
    });
  }

  async unpin(serverId: string, name: string): Promise<void> {
    const server = await this.server(serverId);
    await this.capabilities.require(server.nodeId, "instantanes", "read");
    const snapshot = await this.snapshotOf(serverId, server.nodeId, name);
    await this.db
      .delete(volumeSnapshotPins)
      .where(
        and(
          eq(volumeSnapshotPins.snapshotId, snapshot.id),
          eq(volumeSnapshotPins.serverId, serverId),
        ),
      );
  }

  /* --- Administration ------------------------------------------------------- */

  async listForNode(nodeId: string) {
    const rows = await this.db
      .select({
        name: volumeSnapshots.name,
        takenAt: volumeSnapshots.takenAt,
        cause: volumeSnapshots.cause,
        bytes: volumeSnapshots.bytes,
        servers: volumeSnapshots.servers,
        pins: sql<number>`(select count(*)::int from ${volumeSnapshotPins} where ${volumeSnapshotPins.snapshotId} = ${volumeSnapshots.id})`,
      })
      .from(volumeSnapshots)
      .where(and(eq(volumeSnapshots.nodeId, nodeId), isNull(volumeSnapshots.goneAt)))
      .orderBy(desc(volumeSnapshots.takenAt));
    return rows.map((row) => ({
      ...row,
      takenAt: new Date(row.takenAt).toISOString(),
      serverCount: row.servers.length,
    }));
  }

  /**
   * Fait détruire un instantané par l'agent. Ses épinglages tombent tout de
   * suite : un instantané qu'on fait détruire ne se garde plus.
   */
  async destroy(nodeId: string, name: string, by: string | null): Promise<OrderReceipt> {
    const [snapshot] = await this.db
      .select({ id: volumeSnapshots.id })
      .from(volumeSnapshots)
      .where(
        and(
          eq(volumeSnapshots.nodeId, nodeId),
          eq(volumeSnapshots.name, name),
          isNull(volumeSnapshots.goneAt),
        ),
      )
      .limit(1);
    if (!snapshot) throw new NotFoundException("Instantané introuvable sur ce node.");
    await this.capabilities.require(nodeId, "instantanes", "read");

    const [pending] = await this.db
      .select({ id: snapshotOrders.id })
      .from(snapshotOrders)
      .where(
        and(
          eq(snapshotOrders.nodeId, nodeId),
          eq(snapshotOrders.kind, "detruire"),
          eq(snapshotOrders.snapshotName, name),
          inArray(snapshotOrders.state, ["pending"]),
        ),
      )
      .limit(1);
    await this.db.delete(volumeSnapshotPins).where(eq(volumeSnapshotPins.snapshotId, snapshot.id));
    if (pending) return { orderId: pending.id, existing: true };

    const [order] = await this.db
      .insert(snapshotOrders)
      .values({ nodeId, kind: "detruire", snapshotName: name, requestedBy: by })
      .returning({ id: snapshotOrders.id });
    return { orderId: (order as { id: string }).id, existing: false };
  }
}
