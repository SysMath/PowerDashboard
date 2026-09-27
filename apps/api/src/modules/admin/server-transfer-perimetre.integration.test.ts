import {
  allocations,
  type Database,
  nodeResellerShares,
  servers,
  serverTransfers,
  users,
} from "@gamedashboard/db";
import { ConflictException, Logger } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedLocation, seedNode, seedServer, seedUser } from "../../test/fixtures";
import { sousDomainesInertes } from "../../test/sous-domaines";
import {
  createThrowawayDatabase,
  HAS_DATABASE,
  NO_DATABASE_REASON,
  type ThrowawayDatabase,
} from "../../test/throwaway-database";
import type { NotificationsService } from "../notifications/notifications.service";
import { WebhookEmitterService } from "../webhooks/webhook-emitter.service";
import type { WingsClientService } from "../wings/wings-client.service";
import type { WingsTokenService } from "../wings/wings-token.service";
import { ServerTransferService } from "./server-transfer.service";

/**
 * Un transfert ne fait pas sortir un serveur du périmètre de son revendeur
 * (audit ASVS, doute D-10).
 *
 * Le rattachement d'un serveur (`servers.reseller_id`) décide de ce qu'un
 * revendeur voit et de la part qui compte sa consommation. Le transfert, lui,
 * ne regardait que la maintenance du node d'arrivée : l'administration pouvait
 * poser le serveur d'un client du revendeur A sur la machine confiée en entier
 * au revendeur B — qui l'administre et en lit les disques —, ou sur une
 * machine partagée où A n'a aucune part, où plus rien ne comptait sa
 * consommation.
 *
 * Les daemons sont des doublures : seul le panel est sous test.
 */
describe.skipIf(!HAS_DATABASE)("ServerTransferService : périmètre des revendeurs", () => {
  let throwaway: ThrowawayDatabase;
  let db: Database;
  let service: ServerTransferService;

  let locationId: string;
  let revendeurA: string;
  let revendeurB: string;
  let machineA: string;

  beforeAll(async () => {
    Logger.overrideLogger(false);
    throwaway = await createThrowawayDatabase();
    db = throwaway.db;

    service = new ServerTransferService(
      db,
      {
        startTransfer: async () => undefined,
        deleteServerOnNode: async () => undefined,
      } as unknown as WingsClientService,
      {
        transferGrant: async () => ({ token: "jeton", url: "https://arrivee.test/transfer" }),
      } as unknown as WingsTokenService,
      { notifyServerOwner: async () => undefined } as unknown as NotificationsService,
      new WebhookEmitterService(db),
      sousDomainesInertes(),
    );
  }, 60_000);

  afterAll(async () => {
    await throwaway?.drop();
  });

  beforeEach(async () => {
    await db.execute(
      sql.raw(
        `truncate table server_transfers, node_reseller_shares, servers, allocations, eggs, nests, nodes, locations, users cascade`,
      ),
    );
    locationId = await seedLocation(db);
    revendeurA = await revendeur();
    revendeurB = await revendeur();
    machineA = await seedNode(db, { locationId, name: "MACHINE-A", ownerId: revendeurA });
  });

  async function revendeur(): Promise<string> {
    const id = await seedUser(db);
    await db.update(users).set({ role: "reseller" }).where(eq(users.id, id));
    return id;
  }

  /** Un serveur de client, rattaché à `resellerId`, sur `nodeId`. */
  async function serveur(nodeId: string, resellerId: string | null): Promise<string> {
    const id = await seedServer(db, { nodeId, ownerId: await seedUser(db) });
    await db.update(servers).set({ resellerId }).where(eq(servers.id, id));
    return id;
  }

  /** Un node d'arrivée avec un port libre. */
  async function arrivee(ownerId: string | null): Promise<string> {
    const nodeId = await seedNode(db, { locationId, ownerId });
    await db.insert(allocations).values({ nodeId, ip: "127.0.0.2", port: 30_000 });
    return nodeId;
  }

  async function transferts(serverId: string): Promise<number> {
    const rows = await db
      .select({ id: serverTransfers.id })
      .from(serverTransfers)
      .where(eq(serverTransfers.serverId, serverId));
    return rows.length;
  }

  it("refuse la machine confiée en entier à un autre revendeur, et ne touche à rien", async () => {
    const serverId = await serveur(machineA, revendeurA);
    const machineB = await arrivee(revendeurB);

    await expect(service.start(serverId, machineB)).rejects.toBeInstanceOf(ConflictException);

    const [server] = await db
      .select({ nodeId: servers.nodeId, state: servers.state })
      .from(servers)
      .where(eq(servers.id, serverId));
    expect(server).toEqual({ nodeId: machineA, state: null });
    expect(await transferts(serverId)).toBe(0);
  });

  it("refuse une machine partagée où le revendeur n'a pas de part", async () => {
    const serverId = await serveur(machineA, revendeurA);
    const partagee = await arrivee(null);
    await db
      .insert(nodeResellerShares)
      .values({ nodeId: partagee, resellerId: revendeurB, memoryMb: 8192, diskMb: 102_400 });

    await expect(service.start(serverId, partagee)).rejects.toBeInstanceOf(ConflictException);
    expect(await transferts(serverId)).toBe(0);
  });

  it("accepte une machine partagée où le revendeur a sa part", async () => {
    const serverId = await serveur(machineA, revendeurA);
    const partagee = await arrivee(null);
    await db
      .insert(nodeResellerShares)
      .values({ nodeId: partagee, resellerId: revendeurA, memoryMb: 8192, diskMb: 102_400 });

    await service.start(serverId, partagee);
    expect(await transferts(serverId)).toBe(1);
  });

  it("accepte une autre machine du même revendeur", async () => {
    const serverId = await serveur(machineA, revendeurA);

    await service.start(serverId, await arrivee(revendeurA));
    expect(await transferts(serverId)).toBe(1);
  });

  it("refuse de poser un serveur de la plateforme sur la machine d'un revendeur", async () => {
    const serverId = await serveur(await seedNode(db, { locationId }), null);

    await expect(service.start(serverId, await arrivee(revendeurB))).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(await transferts(serverId)).toBe(0);
  });

  it("laisse un serveur de la plateforme aller d'une machine de la plateforme à l'autre", async () => {
    const serverId = await serveur(await seedNode(db, { locationId }), null);

    await service.start(serverId, await arrivee(null));
    expect(await transferts(serverId)).toBe(1);
  });
});

if (!HAS_DATABASE) console.warn(NO_DATABASE_REASON);
