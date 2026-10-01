import {
  type AgentSnapshotReport,
  DEFAULT_SNAPSHOT_POLICY,
  AgentSnapshotReport as ReportSchema,
} from "@gamedashboard/contracts";
import {
  type Database,
  nodeAgents,
  servers,
  settings,
  snapshotOrders,
  volumeSnapshots,
} from "@gamedashboard/db";
import { ConflictException, HttpException, NotFoundException } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedLocation, seedNode, seedServer, seedUser } from "../../test/fixtures";
import {
  createThrowawayDatabase,
  HAS_DATABASE,
  type ThrowawayDatabase,
} from "../../test/throwaway-database";
import { PlatformSettingsService } from "../admin/platform-settings.service";
import { NodeAgentRepository } from "../node-agent/node-agent.repository";
import { NodeCapabilitiesService } from "../node-agent/node-capabilities.service";
import { SnapshotPolicyService } from "./snapshot-policy.service";
import { ORDER_TIMEOUT_MS, SnapshotsService } from "./snapshots.service";

process.env.APP_SECRET_KEY ??= "clé de test des instantanés, factice et assez longue";

const T1 = "gd-20260930T120000.000Z";
const T2 = "gd-20260930T130000.000Z";
const T3 = "gd-20260930T140000.000Z";

/**
 * Instantanés côté panel contre une vraie base (ADR 0009) : le registre suit
 * les rapports de l'agent, les ordres partent et reviennent, et chaque
 * écriture respecte `nodeCapabilities()` et les réglages du node.
 */
describe.skipIf(!HAS_DATABASE)("instantanés (intégration)", () => {
  let throwaway: ThrowawayDatabase;
  let db: Database;
  let service: SnapshotsService;
  let policies: SnapshotPolicyService;
  let agents: NodeAgentRepository;
  let nodeId: string;
  let serverId: string;
  let otherServerId: string;
  let ownerId: string;

  beforeAll(async () => {
    throwaway = await createThrowawayDatabase();
    db = throwaway.db;
    agents = new NodeAgentRepository(db);
    policies = new SnapshotPolicyService(db);
    const capabilities = new NodeCapabilitiesService(agents, new PlatformSettingsService(db));
    service = new SnapshotsService(db, policies, capabilities);
  }, 60_000);

  afterAll(async () => {
    await throwaway?.drop();
  });

  beforeEach(async () => {
    await db.execute(
      sql.raw(
        "truncate table settings, snapshot_orders, volume_snapshot_pins, volume_snapshots, node_snapshots, node_agents, servers, allocations, eggs, nests, nodes, locations, users cascade",
      ),
    );
    nodeId = await seedNode(db, { locationId: await seedLocation(db) });
    ownerId = await seedUser(db);
    serverId = await seedServer(db, { nodeId, ownerId });
    otherServerId = await seedServer(db, { nodeId, ownerId });
    await agent();
  });

  /** Un agent qui parle, fonction « instantanes » active. */
  async function agent(seenMsAgo = 5_000, functions = ["instantanes"]) {
    await agents.issueToken(nodeId);
    const seen = new Date(Date.now() - seenMsAgo).toISOString();
    await db
      .update(nodeAgents)
      .set({ functions, functionsSeen: { instantanes: seen }, lastSeenAt: seen })
      .where(eq(nodeAgents.nodeId, nodeId));
  }

  function rapport(over: Partial<AgentSnapshotReport> = {}): AgentSnapshotReport {
    return ReportSchema.parse({
      version: "1.0.0",
      systeme: "btrfs",
      espace: { total: 1000, libre: 600 },
      suspendu: false,
      instantanes: [
        { nom: T1, pris_le: "2026-09-30T12:00:00Z", serveurs: [serverId, otherServerId] },
        { nom: T2, pris_le: "2026-09-30T13:00:00Z", serveurs: [serverId], octets: 42 },
      ],
      ordres: [],
      ...over,
    });
  }

  it("tient le registre d'après l'agent, sans rien supprimer", async () => {
    await service.applyReport(nodeId, rapport());
    // T1 disparaît de la machine, T3 apparaît.
    await service.applyReport(
      nodeId,
      rapport({
        instantanes: [
          { nom: T2, pris_le: "2026-09-30T13:00:00Z", serveurs: [serverId], octets: 42 },
          { nom: T3, pris_le: "2026-09-30T14:00:00Z", serveurs: [otherServerId], octets: null },
        ],
      }),
    );
    const rows = await db.select().from(volumeSnapshots).orderBy(volumeSnapshots.name);
    expect(rows.map((r) => [r.name, r.goneAt !== null])).toEqual([
      [T1, true],
      [T2, false],
      [T3, false],
    ]);

    const { data, meta } = await service.listForServer(serverId);
    expect(data.map((s) => s.name)).toEqual([T2]);
    expect(data[0]).toMatchObject({ cause: "auto", bytes: 42, pinned: false });
    expect(meta).toMatchObject({ writable: true, pinLimit: 3, pinned: 0, pending: false });
    expect(meta.status).toMatchObject({ filesystem: "btrfs", freeBytes: 600, suspended: false });
  });

  it("accepte le rapport tel que Go l'écrit (listes nulles)", () => {
    const brut = {
      version: "1.0.0",
      systeme: "",
      motif: "system.data n'est ni btrfs ni ZFS",
      suspendu: false,
      instantanes: null,
      ordres: null,
    };
    expect(ReportSchema.parse(brut)).toMatchObject({ instantanes: [], ordres: [] });
  });

  it("ne tient pas pour disparus les instantanés d'une machine qui ne sait plus les lister", async () => {
    await service.applyReport(nodeId, rapport());
    await service.applyReport(
      nodeId,
      rapport({ systeme: "", motif: "sous-volume introuvable", instantanes: [] }),
    );
    const vivants = await db
      .select()
      .from(volumeSnapshots)
      .where(sql`${volumeSnapshots.goneAt} is null`);
    expect(vivants).toHaveLength(2);
    expect((await service.status(nodeId)).reason).toBe("sous-volume introuvable");
    await expect(service.take(serverId, ownerId)).rejects.toThrow(/sous-volume introuvable/);
  });

  it("prend un instantané manuel : un ordre, rendu par l'agent, qui porte sa cause", async () => {
    await service.applyReport(nodeId, rapport());
    const premier = await service.take(serverId, ownerId);
    // Deux clics : une seule demande.
    expect(await service.take(serverId, ownerId)).toEqual({ ...premier, existing: true });

    const etat = await service.agentState(nodeId);
    expect(etat.ordres).toEqual([{ id: premier.orderId, type: "prendre", serveur: serverId }]);
    expect(etat.reglages).toEqual({
      actif: true,
      niveaux: [
        { intervalle_s: 3600, retention_s: 86_400 },
        { intervalle_s: 86_400, retention_s: 604_800 },
      ],
      duree_max_s: 30 * 86_400,
      seuil_libre_pct: 15,
      regroupement_s: 60,
    });

    const rendu = rapport({
      instantanes: [
        ...rapport().instantanes,
        { nom: T3, pris_le: new Date().toISOString(), serveurs: [serverId], octets: null },
      ],
      ordres: [{ id: premier.orderId, etat: "reussi", instantane: T3 }],
    });
    await service.applyReport(nodeId, rendu);

    const [pris] = await db.select().from(volumeSnapshots).where(eq(volumeSnapshots.name, T3));
    expect(pris).toMatchObject({ cause: "manual", serverId, requestedBy: ownerId });
    // Gardé un jour sans épinglage, et plus d'ordre en attente.
    const apres = await service.agentState(nodeId);
    expect(apres.gardes).toContain(T3);
    expect(apres.ordres).toEqual([]);

    // Le délai entre deux demandes manuelles est tenu.
    await expect(service.take(serverId, ownerId)).rejects.toBeInstanceOf(HttpException);
  });

  it("clôt en échec un ordre resté sans compte rendu", async () => {
    await service.applyReport(nodeId, rapport());
    const { orderId } = await service.take(serverId, ownerId);
    await db
      .update(snapshotOrders)
      .set({ createdAt: new Date(Date.now() - ORDER_TIMEOUT_MS - 1000).toISOString() })
      .where(eq(snapshotOrders.id, orderId));
    expect((await service.agentState(nodeId)).ordres).toEqual([]);
    const [order] = await db.select().from(snapshotOrders).where(eq(snapshotOrders.id, orderId));
    expect(order?.state).toBe("failed");
  });

  it("épingle dans la limite du serveur, et l'agent reçoit les épinglés", async () => {
    await service.applyReport(nodeId, rapport());
    await db.update(servers).set({ snapshotLimit: 1 }).where(eq(servers.id, serverId));
    await service.pin(serverId, T1, "avant la mise à jour", ownerId);
    // Même instantané une seconde fois : le libellé change, la limite tient.
    await service.pin(serverId, T1, "avant la 1.21", ownerId);
    await expect(service.pin(serverId, T2, null, ownerId)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect((await service.agentState(nodeId)).gardes).toEqual([T1]);

    const { data } = await service.listForServer(serverId);
    expect(data.find((s) => s.name === T1)).toMatchObject({
      pinned: true,
      pinLabel: "avant la 1.21",
    });

    await service.unpin(serverId, T1);
    await service.pin(serverId, T2, null, ownerId);
    expect((await service.agentState(nodeId)).gardes).toEqual([T2]);
  });

  it("n'épingle pas un instantané qui ne contient pas le serveur", async () => {
    await service.applyReport(nodeId, rapport());
    await expect(service.pin(otherServerId, T2, null, ownerId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("suit nodeCapabilities : absente sans agent, lisible mais figée quand l'agent se tait", async () => {
    await service.applyReport(nodeId, rapport());
    await agent(10 * 60_000);
    const { meta } = await service.listForServer(serverId);
    expect(meta.writable).toBe(false);
    await expect(service.take(serverId, ownerId)).rejects.toBeInstanceOf(ConflictException);

    await agents.remove(nodeId);
    await expect(service.listForServer(serverId)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("coupée pour la plateforme : aucune prise automatique, seules les destructions partent", async () => {
    await service.applyReport(nodeId, rapport());
    const { orderId } = await service.take(serverId, ownerId);
    const detruire = await service.destroy(nodeId, T1, ownerId);
    await db.insert(settings).values({ key: "agent.instantanes", value: false });

    const etat = await service.agentState(nodeId);
    expect(etat.reglages.actif).toBe(false);
    expect(etat.ordres.map((o) => o.id)).toEqual([detruire.orderId]);
    expect(etat.ordres.map((o) => o.id)).not.toContain(orderId);
  });

  it("applique les réglages propres d'un node, puis le rend aux défauts", async () => {
    await policies.saveDefaults({ ...DEFAULT_SNAPSHOT_POLICY, maxAgeDays: 14 });
    expect((await service.agentState(nodeId)).reglages.duree_max_s).toBe(14 * 86_400);

    await policies.saveForNode(nodeId, {
      ...DEFAULT_SNAPSHOT_POLICY,
      levels: [{ intervalMinutes: 15, retentionHours: 6, enabled: true }],
      enabled: true,
    });
    expect((await service.agentState(nodeId)).reglages.niveaux).toEqual([
      { intervalle_s: 900, retention_s: 21_600 },
    ]);

    await policies.saveForNode(nodeId, null);
    expect((await policies.forNode(nodeId)).custom).toBe(false);
    expect((await service.agentState(nodeId)).reglages.duree_max_s).toBe(14 * 86_400);
  });

  it("refuse des réglages hors des bornes de l'agent", async () => {
    await expect(
      policies.saveForNode(nodeId, { ...DEFAULT_SNAPSHOT_POLICY, maxAgeDays: 120 }),
    ).rejects.toThrow();
    await expect(
      policies.saveForNode(nodeId, {
        ...DEFAULT_SNAPSHOT_POLICY,
        levels: [{ intervalMinutes: 60, retentionHours: 24 * 40, enabled: true }],
      }),
    ).rejects.toThrow(/durée maximale/);
  });

  it("fait détruire un instantané et retire ses épinglages", async () => {
    await service.applyReport(nodeId, rapport());
    await service.pin(serverId, T1, null, ownerId);
    const receipt = await service.destroy(nodeId, T1, ownerId);
    expect(await service.destroy(nodeId, T1, ownerId)).toEqual({ ...receipt, existing: true });
    const etat = await service.agentState(nodeId);
    expect(etat.gardes).toEqual([]);
    expect(etat.ordres).toEqual([{ id: receipt.orderId, type: "detruire", instantane: T1 }]);
  });
});
