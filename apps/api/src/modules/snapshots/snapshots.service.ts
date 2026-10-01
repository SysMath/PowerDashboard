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
  backups,
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
import { and, asc, desc, eq, gt, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { DATABASE } from "../../common/database.provider";
import { ActivityService } from "../activity/activity.service";
import { NodeCapabilitiesService } from "../node-agent/node-capabilities.service";
import { type BackupReport, RemoteBackupService } from "../remote/remote-backup.service";
import { WingsClientService } from "../wings/wings-client.service";
import { SnapshotPolicyService } from "./snapshot-policy.service";

/** Un ordre sans compte rendu au-delà est clos en échec : l'agent s'est tu. */
export const ORDER_TIMEOUT_MS = 30 * 60_000;
/**
 * Pour une restauration ou une archive, qui recopient ou compressent tout un
 * serveur : le délai des restaurations de Wings (`RESTORE_STALE_MS`).
 */
export const LONG_ORDER_TIMEOUT_MS = 6 * 60 * 60_000;
const LONG_ORDERS = ["restaurer", "archiver"];
/** L'agent refuse une liste d'exclusions plus longue (`ExclusionsMax`). */
const EXCLUSIONS_MAX = 64 << 10;
/** Au plus, par relevé, pour tenir dans les bornes de l'agent (`OrdresMax`). */
const ORDERS_PER_STATE = 100;

/**
 * Délai laissé à Wings pour arrêter le serveur avant une restauration. Au-delà,
 * la restauration est abandonnée et le serveur rendu (ADR 0009) : jamais de
 * `kill` pour forcer, ce serait perdre ce que le jeu n'a pas encore écrit.
 */
export const RESTORE_STOP_TIMEOUT_MS = 3 * 60_000;
/** Un ordre « en attente de l'arrêt » resté là : le panel a redémarré entre-temps. */
const WAITING_TIMEOUT_MS = RESTORE_STOP_TIMEOUT_MS + 2 * 60_000;
const STOP_POLL_MS = 2_000;

/**
 * Attente de l'instantané de sûreté avant une restauration de sauvegarde :
 * deux relevés de l'agent (15 s chacun) et de la marge. Au-delà, la
 * restauration part sans lui, et le journal du serveur le dit.
 */
export const BACKUP_SAFETY_WAIT_MS = 40_000;
const SAFETY_POLL_MS = 1_000;

const EXPIRED = "L'agent de node n'a pas rendu compte de cet ordre à temps.";
const NOT_STOPPED = "Le serveur ne s'est pas arrêté à temps : restauration abandonnée.";

type Pause = (ms: number) => Promise<void>;
const pauseReelle: Pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

type FinishedOrder = typeof snapshotOrders.$inferSelect & {
  safety: string | null;
  /** L'agent a commencé le dépôt S3 : Wings ne peut plus reprendre la sauvegarde. */
  uploadStarted?: boolean;
};

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
    @Inject(WingsClientService) private readonly wings: WingsClientService,
    @Inject(ActivityService) private readonly activity: ActivityService,
    @Inject(RemoteBackupService) private readonly remoteBackups: RemoteBackupService,
  ) {}

  /** Remplacés dans les tests, qui n'attendent pas. */
  pause: Pause = pauseReelle;
  stopTimeoutMs = RESTORE_STOP_TIMEOUT_MS;
  safetyWaitMs = BACKUP_SAFETY_WAIT_MS;

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
    // Coupée : une archive en attente revient à Wings plutôt que d'attendre.
    if (!active) await this.abandonArchives(nodeId, "Instantanés coupés sur ce node.");

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

    const archives = pending.filter((order) => order.kind === "archiver" && order.backupId);
    const exclusions = new Map(
      archives.length === 0
        ? []
        : (
            await this.db
              .select({ id: backups.id, ignored: backups.ignoredFiles })
              .from(backups)
              .where(
                inArray(
                  backups.id,
                  archives.map((order) => order.backupId as string),
                ),
              )
          ).map((row) => [row.id, row.ignored.join("\n")]),
    );

    const ordres: AgentSnapshotOrder[] = pending
      .filter((order) => active || order.kind === "detruire")
      .map((order) => ({
        id: order.id,
        type: order.kind as AgentOrderKind,
        ...(order.serverId ? { serveur: order.serverId } : {}),
        ...(order.snapshotName ? { instantane: order.snapshotName } : {}),
        ...(order.backupId
          ? {
              sauvegarde: order.backupId,
              exclusions: exclusions.get(order.backupId) ?? "",
            }
          : {}),
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
    const finished: FinishedOrder[] = [];
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
        if (order) {
          finished.push({
            ...order,
            safety: result.instantane ?? null,
            uploadStarted: result.depot_commence === true,
          });
        }
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
    for (const order of finished) {
      await this.settleRestore(order);
      await this.settleArchive(nodeId, order);
    }
  }

  /**
   * Ordres restés sans compte rendu : clos en échec. Une restauration close
   * ainsi rend son serveur.
   */
  async expireOrders(nodeId: string): Promise<void> {
    const now = new Date();
    const closed = await this.db
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
          or(
            and(
              eq(snapshotOrders.state, "pending"),
              notInArray(snapshotOrders.kind, LONG_ORDERS),
              lt(
                snapshotOrders.createdAt,
                new Date(now.getTime() - ORDER_TIMEOUT_MS).toISOString(),
              ),
            ),
            and(
              eq(snapshotOrders.state, "pending"),
              inArray(snapshotOrders.kind, LONG_ORDERS),
              lt(
                snapshotOrders.createdAt,
                new Date(now.getTime() - LONG_ORDER_TIMEOUT_MS).toISOString(),
              ),
            ),
            and(
              eq(snapshotOrders.state, "waiting"),
              lt(
                snapshotOrders.createdAt,
                new Date(now.getTime() - WAITING_TIMEOUT_MS).toISOString(),
              ),
            ),
          ),
        ),
      )
      .returning();
    for (const order of closed) {
      await this.settleRestore({ ...order, safety: null });
      await this.settleArchive(nodeId, { ...order, safety: null });
    }
  }

  /**
   * Balayage de fond : les ordres de tous les nodes, même d'un agent qui ne
   * tire plus rien (une restauration resterait sinon en `restoring`).
   */
  async sweep(): Promise<void> {
    const rows = await this.db
      .selectDistinct({ nodeId: snapshotOrders.nodeId })
      .from(snapshotOrders)
      .where(inArray(snapshotOrders.state, ["pending", "waiting"]));
    for (const { nodeId } of rows) await this.expireOrders(nodeId);
  }

  /** Archives pas encore faites rendues à Wings, avec la raison. */
  private async abandonArchives(nodeId: string, error: string): Promise<void> {
    const now = new Date().toISOString();
    const closed = await this.db
      .update(snapshotOrders)
      .set({ state: "failed", error, completedAt: now, updatedAt: now })
      .where(
        and(
          eq(snapshotOrders.nodeId, nodeId),
          eq(snapshotOrders.kind, "archiver"),
          eq(snapshotOrders.state, "pending"),
        ),
      )
      .returning();
    for (const order of closed) await this.settleArchive(nodeId, { ...order, safety: null });
  }

  /**
   * Fin d'une archive tirée d'un instantané (ADR 0009).
   *
   * Réussie : la sauvegarde a déjà été close par le compte rendu de dépôt,
   * reçu avant celui de l'ordre ; il reste à noter l'instantané d'origine.
   * Échouée **avant le dépôt** : Wings fait la sauvegarde, comme sans agent,
   * et la ligne le dit (`source`). Échouée pendant le dépôt : la sauvegarde
   * est close en échec par le même code que pour Wings, qui abandonne le
   * dépôt fractionné et prévient le titulaire.
   */
  private async settleArchive(nodeId: string, order: FinishedOrder): Promise<void> {
    if (order.kind !== "archiver" || !order.backupId || !order.serverId) return;
    const backupId = order.backupId;
    if (order.state === "done") {
      await this.db
        .update(backups)
        .set({ snapshotName: order.result, updatedAt: new Date().toISOString() })
        .where(eq(backups.id, backupId));
      return;
    }
    const [backup] = await this.db
      .select({
        completedAt: backups.completedAt,
        uploadId: backups.uploadId,
        ignored: backups.ignoredFiles,
      })
      .from(backups)
      .where(eq(backups.id, backupId))
      .limit(1);
    if (!backup || backup.completedAt !== null) return;

    const closeFailed = () =>
      this.remoteBackups.complete(nodeId, backupId, { successful: false } satisfies BackupReport);
    if (order.uploadStarted || backup.uploadId) {
      await closeFailed();
      return;
    }
    await this.db
      .update(backups)
      .set({ source: "wings", updatedAt: new Date().toISOString() })
      .where(eq(backups.id, backupId));
    try {
      await this.wings.createBackup(order.serverId, backupId, backup.ignored, "s3");
    } catch {
      await closeFailed();
    }
  }

  /**
   * Fin d'une restauration d'instantané, réussie ou non : le serveur est
   * rendu (état `restoring` levé, et lui seul) et l'issue va au journal du
   * serveur. Une fois seulement, quand l'état est effectivement levé.
   */
  private async settleRestore(order: FinishedOrder): Promise<void> {
    if (order.kind !== "restaurer" || !order.serverId) return;
    const released = await this.db
      .update(servers)
      .set({ state: null, updatedAt: new Date().toISOString() })
      .where(and(eq(servers.id, order.serverId), eq(servers.state, "restoring")))
      .returning({ id: servers.id });
    if (released.length === 0) return;
    const ok = order.state === "done";
    await this.activity.record({
      event: ok ? "snapshot.restore_completed" : "snapshot.restore_failed",
      serverId: order.serverId,
      actorId: null,
      actorType: "system",
      actorLabel: "Agent de node",
      properties: {
        name: order.snapshotName,
        safety: order.safety,
        ...(ok ? {} : { error: order.error }),
      },
    });
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
          eq(snapshotOrders.cause, "manual"),
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

  /**
   * Restaure le serveur depuis un instantané (ADR 0009), orchestré par le
   * panel :
   *
   * 1. le serveur passe en `restoring` (démarrage, fichiers et SFTP refusés),
   *    seulement s'il n'a aucun autre état ;
   * 2. l'ordre est créé « en attente de l'arrêt », invisible pour l'agent ;
   * 3. Wings reçoit `stop` ; l'ordre ne part vers l'agent que quand Wings
   *    donne le serveur arrêté, sinon il échoue et le serveur est rendu ;
   * 4. l'agent prend un instantané de sûreté, recopie, et rend compte :
   *    `applyReport` rend le serveur, qui reste arrêté.
   *
   * Rend dès l'étape 2 ; la suite se lit dans la liste et le journal.
   */
  async restore(serverId: string, name: string, requestedBy: string | null) {
    const server = await this.server(serverId);
    const { status } = await this.requireWritable(server.nodeId);
    if (status.suspended) {
      throw new ConflictException(
        "Espace disque insuffisant sur la machine : l'instantané de sûreté ne peut pas être pris.",
      );
    }
    await this.snapshotOf(serverId, server.nodeId, name);

    const [claimed] = await this.db
      .update(servers)
      .set({ state: "restoring", updatedAt: new Date().toISOString() })
      .where(and(eq(servers.id, serverId), isNull(servers.state)))
      .returning({ id: servers.id });
    if (!claimed) {
      throw new ConflictException(
        "Ce serveur est occupé par une autre opération. Réessayez quand elle sera terminée.",
      );
    }
    const [order] = await this.db
      .insert(snapshotOrders)
      .values({
        nodeId: server.nodeId,
        kind: "restaurer",
        cause: "safety" satisfies SnapshotCause,
        serverId,
        snapshotName: name,
        state: "waiting",
        requestedBy,
      })
      .returning({ id: snapshotOrders.id });
    const orderId = (order as { id: string }).id;

    // Sans attendre : l'arrêt d'un serveur de jeu prend le temps qu'il prend.
    // Si le panel s'arrête entre-temps, `expireOrders` rend le serveur.
    void this.releaseWhenStopped(orderId, serverId).catch(() =>
      this.failWaiting(orderId, "Arrêt du serveur impossible à suivre."),
    );
    return { orderId };
  }

  /** Étape 3 : l'ordre part vers l'agent une fois le serveur arrêté. */
  async releaseWhenStopped(orderId: string, serverId: string): Promise<void> {
    await this.wings.power(serverId, "stop").catch(() => undefined);
    const deadline = Date.now() + this.stopTimeoutMs;
    for (;;) {
      const state = await this.wings
        .resources(serverId)
        .then((r) => r.state)
        .catch(() => null);
      if (state === "offline") {
        // Seulement s'il attend encore : clos entre-temps (expiré), le
        // serveur a déjà été rendu, et rien ne part.
        await this.db
          .update(snapshotOrders)
          .set({ state: "pending", updatedAt: new Date().toISOString() })
          .where(and(eq(snapshotOrders.id, orderId), eq(snapshotOrders.state, "waiting")));
        return;
      }
      if (Date.now() >= deadline) {
        await this.failWaiting(orderId, NOT_STOPPED);
        return;
      }
      await this.pause(STOP_POLL_MS);
    }
  }

  private async failWaiting(orderId: string, error: string): Promise<void> {
    const now = new Date().toISOString();
    const [order] = await this.db
      .update(snapshotOrders)
      .set({ state: "failed", error, completedAt: now, updatedAt: now })
      .where(and(eq(snapshotOrders.id, orderId), eq(snapshotOrders.state, "waiting")))
      .returning();
    if (order) await this.settleRestore({ ...order, safety: null });
  }

  /**
   * Instantané de sûreté avant une restauration de **sauvegarde** (ADR 0009,
   * « une restauration de sauvegarde gagne un instantané de sûreté »).
   *
   * Seulement là où la fonction est offerte et possible ; ailleurs, rien. Le
   * serveur est déjà en `restoring` quand elle est appelée : rien ne l'écrit
   * pendant l'attente. Bornée (`BACKUP_SAFETY_WAIT_MS`) : l'agent qui tarde
   * ne bloque pas la restauration demandée, il est seulement dit au journal.
   * Rend le nom de l'instantané, ou `null`.
   */
  async safetyBeforeBackupRestore(serverId: string, backupId: string): Promise<string | null> {
    const server = await this.server(serverId);
    const capability = (await this.capabilities.forNode(server.nodeId)).instantanes;
    if (!capability.writable) return null;
    const [{ policy }, status] = await Promise.all([
      this.policies.forNode(server.nodeId),
      this.status(server.nodeId),
    ]);
    if (!policy.enabled || !status.filesystem || status.suspended) return null;

    const [order] = await this.db
      .insert(snapshotOrders)
      .values({
        nodeId: server.nodeId,
        kind: "prendre",
        cause: "safety" satisfies SnapshotCause,
        serverId,
      })
      .returning({ id: snapshotOrders.id });
    const orderId = (order as { id: string }).id;

    const deadline = Date.now() + this.safetyWaitMs;
    let row: typeof snapshotOrders.$inferSelect | undefined;
    for (;;) {
      [row] = await this.db
        .select()
        .from(snapshotOrders)
        .where(eq(snapshotOrders.id, orderId))
        .limit(1);
      if (row?.state !== "pending" || Date.now() >= deadline) break;
      await this.pause(SAFETY_POLL_MS);
    }
    const safety = row?.state === "done" ? row.result : null;
    if (row?.state === "pending") {
      // Trop tard : pris pendant la restauration, il ne garderait pas
      // l'état d'avant. L'ordre est retiré ; s'il est déjà parti, l'agent
      // le prendra quand même, sans que le panel le range comme sûreté.
      const now = new Date().toISOString();
      await this.db
        .update(snapshotOrders)
        .set({
          state: "failed",
          error: "Abandonné : la restauration n'attend plus.",
          completedAt: now,
          updatedAt: now,
        })
        .where(and(eq(snapshotOrders.id, orderId), eq(snapshotOrders.state, "pending")));
    }
    await this.activity.record({
      event: "backup.restore_safety",
      serverId,
      actorId: null,
      actorType: "system",
      actorLabel: "Agent de node",
      properties: safety
        ? { backupId, name: safety }
        : { backupId, name: null, error: row?.error ?? "L'agent n'a pas répondu à temps." },
    });
    return safety;
  }

  /**
   * Fait tirer d'un instantané l'archive S3 d'une sauvegarde qui vient d'être
   * créée (ADR 0009), là où c'est possible : fonction offerte et allumée,
   * réglage « S3 depuis un instantané », système d'instantanés, espace libre.
   * Rend faux sinon, et la sauvegarde reste à Wings.
   */
  async archiveBackup(serverId: string, backupId: string): Promise<boolean> {
    const server = await this.server(serverId);
    const capability = (await this.capabilities.forNode(server.nodeId)).instantanes;
    if (!capability.writable) return false;
    const [{ policy }, status] = await Promise.all([
      this.policies.forNode(server.nodeId),
      this.status(server.nodeId),
    ]);
    if (!policy.enabled || !policy.s3FromSnapshot || !status.filesystem || status.suspended) {
      return false;
    }
    const [backup] = await this.db
      .select({ ignored: backups.ignoredFiles })
      .from(backups)
      .where(and(eq(backups.id, backupId), eq(backups.serverId, serverId)))
      .limit(1);
    if (!backup || backup.ignored.join("\n").length > EXCLUSIONS_MAX) return false;

    await this.db.transaction(async (tx) => {
      await tx
        .update(backups)
        .set({ source: "snapshot", updatedAt: new Date().toISOString() })
        .where(eq(backups.id, backupId));
      await tx
        .insert(snapshotOrders)
        .values({ nodeId: server.nodeId, kind: "archiver", serverId, backupId });
    });
    return true;
  }

  /**
   * Le dépôt S3 d'une archive, demandé par l'agent : seulement pour une
   * sauvegarde que ce node doit tirer d'un instantané, ordre envoyé et pas
   * encore rendu. Le reste est le code des dépôts de Wings
   * (`RemoteBackupService`), mêmes réponses, mêmes contrôles.
   */
  async openArchiveUpload(nodeId: string, backupId: string, size: number) {
    await this.requireArchiveOrder(nodeId, backupId);
    return this.remoteBackups.openUpload(nodeId, backupId, size);
  }

  async completeArchive(nodeId: string, backupId: string, report: BackupReport): Promise<void> {
    await this.requireArchiveOrder(nodeId, backupId);
    await this.remoteBackups.complete(nodeId, backupId, report);
  }

  private async requireArchiveOrder(nodeId: string, backupId: string): Promise<void> {
    const [row] = await this.db
      .select({ id: snapshotOrders.id })
      .from(snapshotOrders)
      .innerJoin(backups, eq(backups.id, snapshotOrders.backupId))
      .where(
        and(
          eq(snapshotOrders.nodeId, nodeId),
          eq(snapshotOrders.backupId, backupId),
          eq(snapshotOrders.kind, "archiver"),
          eq(snapshotOrders.state, "pending"),
          eq(backups.source, "snapshot"),
        ),
      )
      .limit(1);
    // 404, définitif pour l'agent, comme pour Wings.
    if (!row) throw new NotFoundException("Sauvegarde introuvable.");
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
