import { type Database, eggs, servers } from "@gamedashboard/db";
import { NotFoundException } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedLocation, seedNode, seedServer, seedUser } from "../../test/fixtures";
import {
  createThrowawayDatabase,
  HAS_DATABASE,
  NO_DATABASE_REASON,
  type ThrowawayDatabase,
} from "../../test/throwaway-database";
import type { DenialLogService } from "../activity/denial-log.service";
import type { AuthenticatedRequest } from "../auth/session.guard";
import { ClientController } from "./client.controller";
import { ClientServersService } from "./client-servers.service";
import { ServerAccessService } from "./server-access.service";

const silence = { record: async () => {} } as unknown as DenialLogService;

/**
 * Les commandes que l'egg propose à la console (PLAN §10.2), lues par la
 * route `GET servers/:id/commands` contre une vraie base.
 */
describe.skipIf(!HAS_DATABASE)("commandes de console d'un serveur (intégration)", () => {
  let throwaway: ThrowawayDatabase;
  let db: Database;
  let controller: ClientController;
  let ownerId: string;
  let strangerId: string;
  let serverId: string;

  const requete = (id: string) =>
    ({ user: { id }, scopes: null }) as unknown as AuthenticatedRequest;

  beforeAll(async () => {
    throwaway = await createThrowawayDatabase();
    db = throwaway.db;
    const unused = {} as never;
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
      unused,
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
    const locationId = await seedLocation(db);
    ownerId = await seedUser(db);
    strangerId = await seedUser(db);
    const nodeId = await seedNode(db, { locationId });
    serverId = await seedServer(db, { nodeId, ownerId });
  });

  it("rend les commandes déclarées par l'egg, dans leur ordre", async () => {
    const [row] = await db
      .select({ eggId: servers.eggId })
      .from(servers)
      .where(eq(servers.id, serverId));
    await db
      .update(eggs)
      .set({ consoleCommands: ["say <message>", "list"] })
      .where(eq(eggs.id, row?.eggId as string));

    const { data } = await controller.consoleCommands(requete(ownerId), serverId);
    expect(data.commands).toEqual(["say <message>", "list"]);
  });

  it("rend une liste vide pour un egg qui n'en déclare pas", async () => {
    const { data } = await controller.consoleCommands(requete(ownerId), serverId);
    expect(data.commands).toEqual([]);
  });

  it("répond 404 à qui n'a pas accès au serveur, comme pour sa fiche", async () => {
    await expect(controller.consoleCommands(requete(strangerId), serverId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

if (!HAS_DATABASE) console.warn(NO_DATABASE_REASON);
