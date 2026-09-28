import type { ConsumptionDay } from "@gamedashboard/contracts";
import {
  activityLogs,
  type Database,
  serverConsumptionDays,
  serverMetrics,
  servers,
} from "@gamedashboard/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedLocation, seedNode, seedServer, seedUser } from "../../test/fixtures";
import {
  createThrowawayDatabase,
  HAS_DATABASE,
  NO_DATABASE_REASON,
  type ThrowawayDatabase,
} from "../../test/throwaway-database";
import { ActivityService } from "../activity/activity.service";
import { AdminConsumptionController } from "../admin/admin-consumption.controller";
import type { AdminRequest } from "../admin/admin-input";
import { ConsumptionService } from "./consumption.service";
import { ConsumptionRollupService } from "./consumption-rollup.service";

/**
 * La consommation journalière, contre une vraie base.
 *
 * Tout ce qui compte vit dans le SQL : le découpage en jours UTC, les écarts
 * de compteurs réseau et leurs remises à zéro, les moyennes restreintes au
 * serveur démarré, l'`upsert` qui ne réécrit pas le titulaire d'une journée
 * close. Une doublure ne dirait rien de tout cela.
 */
describe.skipIf(!HAS_DATABASE)("consommation journalière (intégration)", () => {
  let throwaway: ThrowawayDatabase;
  let db: Database;
  let rollup: ConsumptionRollupService;
  let consumption: ConsumptionService;
  let ownerId: string;
  let nodeId: string;
  let serverId: string;

  /** Le 3 mars à midi : la veille (2 mars) n'est pas encore close. */
  const NOW = new Date("2026-03-03T12:00:00.000Z");
  const PERIOD = { from: "2026-03-01", to: "2026-03-03" };

  beforeAll(async () => {
    throwaway = await createThrowawayDatabase();
    db = throwaway.db;
    rollup = new ConsumptionRollupService(db);
    consumption = new ConsumptionService(db);
  }, 60_000);

  afterAll(async () => {
    await throwaway?.drop();
  });

  beforeEach(async () => {
    await db.execute(
      sql.raw(
        "truncate table activity_logs, server_consumption_days, server_metrics, servers, allocations, eggs, nests, nodes, locations, users cascade",
      ),
    );
    const locationId = await seedLocation(db);
    ownerId = await seedUser(db);
    nodeId = await seedNode(db, { locationId, lastHeartbeatAt: NOW.toISOString() });
    serverId = await seedServer(db, { nodeId, ownerId });
  });

  async function releve(
    at: string,
    valeurs: Partial<{
      serverId: string;
      state: string;
      cpuPct: number;
      memBytes: number;
      diskBytes: number;
      netRx: number;
      netTx: number;
      players: number | null;
    }> = {},
  ): Promise<void> {
    await db.insert(serverMetrics).values({
      serverId: valeurs.serverId ?? serverId,
      at: new Date(at).toISOString(),
      state: valeurs.state ?? "running",
      cpuPct: valeurs.cpuPct ?? 0,
      memBytes: valeurs.memBytes ?? 0,
      diskBytes: valeurs.diskBytes ?? 0,
      netRx: valeurs.netRx ?? 0,
      netTx: valeurs.netTx ?? 0,
      players: valeurs.players ?? null,
    });
  }

  async function lire(filters: Parameters<ConsumptionService["page"]>[0] = { period: PERIOD }) {
    const rows: ConsumptionDay[] = [];
    for await (const row of consumption.all(filters, NOW)) rows.push(row);
    return rows;
  }

  function jour(rows: ConsumptionDay[], day: string, id = serverId): ConsumptionDay {
    const row = rows.find((r) => r.day === day && r.serverId === id);
    if (!row) throw new Error(`aucune journée ${day} pour ${id}`);
    return row;
  }

  it("moyenne le processeur et la mémoire sur le seul serveur démarré", async () => {
    // Wings rend des zéros pour un conteneur arrêté : les compter ferait
    // passer pour peu gourmand un serveur qu'on éteint simplement la nuit.
    await releve("2026-03-02T10:00:00Z", { cpuPct: 40, memBytes: 1000, diskBytes: 500 });
    await releve("2026-03-02T10:01:00Z", { cpuPct: 80, memBytes: 3000, diskBytes: 700 });
    await releve("2026-03-02T10:02:00Z", { state: "offline", diskBytes: 700 });

    await rollup.rollup("2026-03-01", NOW);
    const row = jour(await lire(), "2026-03-02");

    expect(row).toMatchObject({
      samples: 3,
      onlineSamples: 2,
      cpuAvgPct: 60,
      cpuMaxPct: 80,
      memoryAvgBytes: 2000,
      memoryMaxBytes: 3000,
      diskMaxBytes: 700,
      memoryLimitMb: 2048,
      diskLimitMb: 10_240,
      complete: true,
    });
  });

  it("laisse nuls le processeur et la mémoire d'une journée entièrement éteinte", async () => {
    await releve("2026-03-02T08:00:00Z", { state: "offline", diskBytes: 900 });

    await rollup.rollup("2026-03-01", NOW);
    const row = jour(await lire(), "2026-03-02");

    expect(row.onlineSamples).toBe(0);
    expect(row.cpuAvgPct).toBeNull();
    expect(row.memoryMaxBytes).toBeNull();
    // Le disque, lui, existe serveur arrêté.
    expect(row.diskMaxBytes).toBe(900);
  });

  it("additionne les écarts de compteurs réseau, remises à zéro comprises", async () => {
    /*
     * Wings rend des octets cumulés depuis le démarrage du conteneur. Le
     * premier relevé ne compte rien (on ignore d'où il part) ; un compteur
     * qui redescend a été remis à zéro, et tout ce qu'il affiche a été
     * échangé depuis.
     */
    await releve("2026-03-02T10:00:00Z", { netRx: 1_000, netTx: 100 });
    await releve("2026-03-02T10:01:00Z", { netRx: 1_500, netTx: 300 });
    await releve("2026-03-02T10:02:00Z", { netRx: 200, netTx: 50 });
    await releve("2026-03-02T10:03:00Z", { netRx: 700, netTx: 60 });

    await rollup.rollup("2026-03-01", NOW);
    const row = jour(await lire(), "2026-03-02");

    expect(row.networkRxBytes).toBe(500 + 200 + 500);
    expect(row.networkTxBytes).toBe(200 + 50 + 10);
  });

  it("compte à minuit l'écart au dernier relevé de la veille, et le range au jour UTC", async () => {
    await releve("2026-03-01T23:59:00Z", { netRx: 5_000_000_000 });
    await releve("2026-03-02T00:00:00Z", { netRx: 5_000_004_000 });

    await rollup.rollup("2026-03-02", NOW);
    const rows = await lire();

    // Au-delà de 2 Gio : les colonnes sont des `bigint`, relus sans perte.
    expect(jour(rows, "2026-03-02").networkRxBytes).toBe(4_000);
    // Le 1er n'a pas été recalculé : le tour partait du 2.
    expect(rows.some((r) => r.day === "2026-03-01")).toBe(false);
  });

  it("découpe le rattrapage par journée sans rien perdre ni déborder", async () => {
    // Le relevé de minuit pile appartient au lendemain : lu avec la journée
    // précédente, il écrirait une journée partielle à la place de la sienne.
    await releve("2026-03-01T23:59:00Z", { netRx: 1_000 });
    await releve("2026-03-02T00:00:00Z", { netRx: 1_500 });
    await releve("2026-03-02T00:01:00Z", { netRx: 2_000 });
    await releve("2026-03-03T09:00:00Z");

    expect(await rollup.rollupByDay("2026-03-01", NOW)).toBe(3);
    const rows = await lire();

    expect(jour(rows, "2026-03-01").samples).toBe(1);
    expect(jour(rows, "2026-03-02")).toMatchObject({ samples: 2, networkRxBytes: 1_000 });
    expect(jour(rows, "2026-03-03").samples).toBe(1);
  });

  it("marque incomplète la journée en cours", async () => {
    await releve("2026-03-03T09:00:00Z");
    await rollup.rollup("2026-03-01", NOW);
    expect(jour(await lire(), "2026-03-03").complete).toBe(false);
  });

  it("recalcule sans doubler, et garde au titulaire d'avant les journées closes", async () => {
    /*
     * Le rattrapage de trente jours repasse à chaque démarrage. Il ne doit ni
     * additionner deux fois une journée, ni attribuer au titulaire
     * d'aujourd'hui ce qu'a consommé celui d'avant un transfert.
     */
    await releve("2026-03-01T10:00:00Z", { cpuPct: 10 });
    await releve("2026-03-02T10:00:00Z", { cpuPct: 20 });
    await rollup.rollup("2026-03-01", NOW);

    const repreneur = await seedUser(db);
    await db.update(servers).set({ ownerId: repreneur }).where(eq(servers.id, serverId));
    await releve("2026-03-01T10:01:00Z", { cpuPct: 30 });
    await releve("2026-03-02T10:01:00Z", { cpuPct: 40 });
    await releve("2026-03-03T10:00:00Z", { cpuPct: 5 });
    await rollup.rollup("2026-03-01", NOW);

    const rows = await lire();
    expect(rows.filter((r) => r.serverId === serverId)).toHaveLength(3);
    // Journées passées : mesures recalculées, titulaire d'alors conservé —
    // la veille comprise, que le transfert de ce matin ne réécrit pas.
    expect(jour(rows, "2026-03-01")).toMatchObject({ ownerId, samples: 2, cpuAvgPct: 20 });
    expect(jour(rows, "2026-03-02")).toMatchObject({ ownerId, samples: 2, cpuAvgPct: 30 });
    // La journée en cours suit le titulaire actuel.
    expect(jour(rows, "2026-03-03").ownerId).toBe(repreneur);
  });

  it("garde la consommation d'un serveur supprimé", async () => {
    // Un serveur supprimé le 15 a consommé du 1er au 15 : c'est ce que la
    // dernière facture doit lire.
    await releve("2026-03-02T10:00:00Z", { cpuPct: 50 });
    await rollup.rollup("2026-03-01", NOW);
    await db.delete(servers).where(eq(servers.id, serverId));

    const rows = await lire();
    expect(jour(rows, "2026-03-02")).toMatchObject({
      cpuAvgPct: 50,
      serverName: "Serveur de test",
    });
  });

  it("nomme le titulaire du jour, avec son identifiant chez le facturier", async () => {
    await db.execute(sql`update users set external_id = 'client-42' where id = ${ownerId}`);
    await releve("2026-03-02T10:00:00Z");
    await rollup.rollup("2026-03-01", NOW);

    const row = jour(await lire(), "2026-03-02");
    expect(row.ownerId).toBe(ownerId);
    expect(row.ownerExternalId).toBe("client-42");
    expect(row.ownerEmail).toMatch(/@gamedashboard\.test$/);
  });

  describe("les périmètres", () => {
    let revendeur: string;
    let autre: string;

    beforeEach(async () => {
      revendeur = await seedUser(db);
      await db.update(servers).set({ resellerId: revendeur }).where(eq(servers.id, serverId));
      autre = await seedServer(db, { nodeId, ownerId: await seedUser(db) });
      await releve("2026-03-02T10:00:00Z");
      await releve("2026-03-02T10:00:00Z", { serverId: autre });
      await rollup.rollup("2026-03-01", NOW);
    });

    it("un revendeur ne lit que les journées de son parc", async () => {
      const rows = await lire({ period: PERIOD, scope: { resellerId: revendeur } });
      expect(rows.map((r) => r.serverId)).toEqual([serverId]);
    });

    it("filtrer un serveur hors du périmètre rend une liste vide, pas ses journées", async () => {
      const rows = await lire({
        period: PERIOD,
        serverId: autre,
        scope: { resellerId: revendeur },
      });
      expect(rows).toEqual([]);
    });

    it("la page d'un serveur ne lit que ce serveur", async () => {
      const rows = await lire({ period: PERIOD, scope: { serverId: autre } });
      expect(rows.map((r) => r.serverId)).toEqual([autre]);
    });

    it("borne la lecture à la période", async () => {
      expect(await lire({ period: { from: "2026-03-03", to: "2026-03-03" } })).toEqual([]);
    });

    it("rend l'administration entière, triée par jour puis par serveur", async () => {
      const rows = await lire();
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.serverId)).toEqual([serverId, autre].sort());
    });
  });

  it("consigne l'export de l'administration au journal, en base", async () => {
    // Non-régression ASVS 8.3.5 : le fichier nomme chaque client, sa sortie
    // doit se lire au journal de la plateforme.
    const activity = new ActivityService(db);
    const controller = new AdminConsumptionController(consumption, activity);
    const reply = { header: () => reply, send: () => undefined };

    await controller.export(
      {
        user: { id: ownerId, email: "admin@exemple.fr" },
        ip: "192.0.2.7",
        headers: {},
      } as unknown as AdminRequest,
      { from: "2026-03-01", to: "2026-03-03", format: "csv" },
      reply,
    );

    const [trace] = await db
      .select()
      .from(activityLogs)
      .where(eq(activityLogs.event, "admin.consumption_exported"));
    expect(trace).toMatchObject({
      actorId: ownerId,
      ip: "192.0.2.7",
      properties: { format: "csv", from: "2026-03-01", to: "2026-03-03", filters: {} },
    });
  });

  it("écrit dans la table que la rétention surveille", async () => {
    await releve("2026-03-02T10:00:00Z");
    expect(await rollup.rollup("2026-03-01", NOW)).toBe(1);
    const [row] = await db.select().from(serverConsumptionDays);
    expect(row?.day).toBe("2026-03-02");
  });
});

// Vitest n'affiche pas la raison d'un `skipIf` : on la dit une fois.
if (!HAS_DATABASE) console.warn(NO_DATABASE_REASON);
