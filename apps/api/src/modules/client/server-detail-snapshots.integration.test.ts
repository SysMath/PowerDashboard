import type { Database } from "@gamedashboard/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedLocation, seedNode, seedServer, seedUser } from "../../test/fixtures";
import {
  createThrowawayDatabase,
  HAS_DATABASE,
  type ThrowawayDatabase,
} from "../../test/throwaway-database";
import type { DenialLogService } from "../activity/denial-log.service";
import type { AuthenticatedRequest } from "../auth/session.guard";
import type { NodeCapabilitiesService } from "../node-agent/node-capabilities.service";
import { ClientController } from "./client.controller";
import { ClientServersService } from "./client-servers.service";
import { ServerAccessService } from "./server-access.service";

const silence = { record: async () => {} } as unknown as DenialLogService;

/**
 * La fiche d'un serveur dit si sa machine offre les instantanés (ADR 0009) :
 * c'est ce qui fait apparaître l'onglet, et il ne doit l'être que là où
 * l'API servira ses routes.
 */
describe.skipIf(!HAS_DATABASE)("fiche serveur et instantanés (intégration)", () => {
  let throwaway: ThrowawayDatabase;
  let db: Database;
  let controller: ClientController;
  let ownerId: string;
  let serverId: string;
  let nodeId: string;
  let offeredOn: string | null;
  const asked: string[] = [];

  const requete = (id: string) =>
    ({ user: { id }, scopes: null }) as unknown as AuthenticatedRequest;

  beforeAll(async () => {
    throwaway = await createThrowawayDatabase();
    db = throwaway.db;
    const unused = {} as never;
    const capabilities = {
      forNode: async (id: string) => {
        asked.push(id);
        return { instantanes: { offered: id === offeredOn } };
      },
    } as unknown as NodeCapabilitiesService;
    controller = new ClientController(
      new ClientServersService(db),
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      new ServerAccessService(db, silence),
      capabilities,
    );
  }, 60_000);

  afterAll(async () => {
    await throwaway?.drop();
  });

  beforeEach(async () => {
    await db.execute(
      sql.raw(
        "truncate table server_subusers, servers, allocations, eggs, nests, nodes, locations, users cascade",
      ),
    );
    asked.length = 0;
    const locationId = await seedLocation(db);
    ownerId = await seedUser(db);
    nodeId = await seedNode(db, { locationId });
    serverId = await seedServer(db, { nodeId, ownerId });
  });

  it("porte l'onglet quand la machine du serveur offre la fonction", async () => {
    offeredOn = nodeId;
    const { data } = await controller.server(requete(ownerId), serverId);
    expect(data.snapshots).toBe(true);
    expect(asked).toEqual([nodeId]);
  });

  it("ne le porte pas ailleurs", async () => {
    offeredOn = null;
    const { data } = await controller.server(requete(ownerId), serverId);
    expect(data.snapshots).toBe(false);
  });
});
