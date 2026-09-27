import { allocations, type Database, servers, serverTransfers } from "@gamedashboard/db";
import { Logger } from "@nestjs/common";
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
import { ServerTransferService, STALE_REASON, TRANSFER_STALE_MS } from "./server-transfer.service";

/**
 * Transferts perdus, contre une vraie base.
 *
 * Le défaut corrigé : un transfert dont aucun daemon ne rapportait l'issue
 * laissait le serveur en « transfert » pour toujours. Et la correction ouvre
 * une course qu'il faut tenir fermée : le balayage peut clore un transfert à
 * l'instant où son accusé de réception arrive. Les deux se jouent dans des
 * verrous PostgreSQL — une doublure de base ne prouverait rien.
 *
 * Les daemons sont des doublures : seul le panel est sous test.
 */
describe.skipIf(!HAS_DATABASE)("ServerTransferService (intégration)", () => {
  let throwaway: ThrowawayDatabase;
  let db: Database;
  let service: ServerTransferService;
  const sousDomaines = sousDomainesInertes();
  let notified: string[];

  let serverId: string;
  let fromNodeId: string;
  let toNodeId: string;
  let arrivalId: string;

  beforeAll(async () => {
    Logger.overrideLogger(false);
    throwaway = await createThrowawayDatabase();
    db = throwaway.db;

    const notifications = {
      notifyServerOwner: async (_id: string, input: { type: string }) => {
        notified.push(input.type);
      },
    } as unknown as NotificationsService;
    const wings = {
      startTransfer: async () => undefined,
      deleteServerOnNode: async () => undefined,
    } as unknown as WingsClientService;
    const tokens = {
      transferGrant: async () => ({ token: "jeton", url: "https://arrivee.test/transfer" }),
    } as unknown as WingsTokenService;

    service = new ServerTransferService(
      db,
      wings,
      tokens,
      notifications,
      new WebhookEmitterService(db),
      sousDomaines,
    );
  }, 60_000);

  afterAll(async () => {
    await throwaway?.drop();
  });

  beforeEach(async () => {
    await db.execute(
      sql.raw(
        `truncate table server_transfers, servers, allocations, eggs, nests, nodes, locations, users cascade`,
      ),
    );
    notified = [];

    const locationId = await seedLocation(db);
    fromNodeId = await seedNode(db, { locationId, name: "DEPART" });
    toNodeId = await seedNode(db, { locationId, name: "ARRIVEE" });
    serverId = await seedServer(db, { nodeId: fromNodeId, ownerId: await seedUser(db) });

    const [free] = await db
      .insert(allocations)
      .values({ nodeId: toNodeId, ip: "127.0.0.2", port: 30_000 })
      .returning({ id: allocations.id });
    if (!free) throw new Error("port d'arrivée non créé");
    arrivalId = free.id;

    await service.start(serverId, toNodeId);
  });

  /** Recule le début du transfert, comme si l'horloge avait tourné. */
  async function age(ms: number): Promise<void> {
    await db.execute(
      sql`update server_transfers set created_at = now() - ${`${ms} milliseconds`}::interval`,
    );
  }

  async function state() {
    const [server] = await db
      .select({ nodeId: servers.nodeId, state: servers.state, allocationId: servers.allocationId })
      .from(servers)
      .where(eq(servers.id, serverId));
    const [transfer] = await db
      .select({ state: serverTransfers.state, reason: serverTransfers.failureReason })
      .from(serverTransfers)
      .where(eq(serverTransfers.serverId, serverId));
    const [arrival] = await db
      .select({ serverId: allocations.serverId })
      .from(allocations)
      .where(eq(allocations.id, arrivalId));
    return { server, transfer, arrival };
  }

  it("clôt un transfert resté sans nouvelles au-delà du délai, et rend le serveur", async () => {
    await age(TRANSFER_STALE_MS + 60_000);

    expect(await service.expireStale()).toBe(1);

    const { server, transfer, arrival } = await state();
    expect(server).toMatchObject({ nodeId: fromNodeId, state: null });
    expect(transfer).toEqual({ state: "failed", reason: STALE_REASON });
    expect(arrival?.serverId).toBeNull();
    expect(notified).toEqual(["server.transfer_failed"]);
  });

  it("laisse courir un transfert encore dans le délai", async () => {
    await age(TRANSFER_STALE_MS - 60_000);

    expect(await service.expireStale()).toBe(0);

    const { server, transfer, arrival } = await state();
    expect(server?.state).toBe("transferring");
    expect(transfer?.state).toBe("running");
    expect(arrival?.serverId).toBe(serverId);
  });

  it("ignore un accusé de réception arrivé après la clôture", async () => {
    await age(TRANSFER_STALE_MS + 60_000);
    await service.expireStale();

    sousDomaines.refresh.mockClear();
    await service.complete(serverId);

    const { server, transfer } = await state();
    expect(server).toMatchObject({ nodeId: fromNodeId, state: null });
    expect(transfer?.state).toBe("failed");
    // Le serveur n'a pas bougé : son sous-domaine non plus.
    expect(sousDomaines.refresh).not.toHaveBeenCalled();
  });

  it("ne défait pas un transfert conclu entre la lecture et le retour en arrière", async () => {
    /*
     * La fenêtre de la course, ouverte à la main : le balayage a lu le
     * transfert « en cours », puis l'accusé de réception l'a conclu, puis le
     * retour en arrière part avec sa lecture périmée. Laisser deux promesses
     * se croiser ne l'ouvre presque jamais ; la rejouer dans l'ordre l'ouvre
     * à chaque fois.
     */
    const [running] = await db
      .select({ id: serverTransfers.id })
      .from(serverTransfers)
      .where(eq(serverTransfers.serverId, serverId));
    if (!running) throw new Error("transfert absent");

    await service.complete(serverId);
    const undone = await (
      service as unknown as {
        rollback(transferId: string, serverId: string, reason: string): Promise<boolean>;
      }
    ).rollback(running.id, serverId, STALE_REASON);

    expect(undone).toBe(false);
    const { server, transfer, arrival } = await state();
    expect(transfer).toEqual({ state: "completed", reason: null });
    expect(server).toMatchObject({ nodeId: toNodeId, state: null, allocationId: arrivalId });
    // Le port d'arrivée est la seule adresse du serveur : il ne doit pas être rendu.
    expect(arrival?.serverId).toBe(serverId);
  });

  it("fait suivre le sous-domaine au serveur transféré", async () => {
    sousDomaines.refresh.mockClear();
    await service.complete(serverId);
    expect(sousDomaines.refresh).toHaveBeenCalledWith(serverId);
  });
});

if (!HAS_DATABASE) console.warn(NO_DATABASE_REASON);
