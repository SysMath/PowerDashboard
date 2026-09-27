import { servers } from "@gamedashboard/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedLocation, seedNode, seedServer, seedUser } from "./fixtures";
import {
  createThrowawayDatabase,
  HAS_DATABASE,
  NO_DATABASE_REASON,
  type ThrowawayDatabase,
} from "./throwaway-database";

/**
 * Les serveurs de test d'un même fichier ne se disputent jamais un port.
 *
 * Le défaut : chaque port était tiré au hasard parmi 5 000, et deux serveurs
 * sur le même node finissaient par tomber sur le même — un échec
 * `allocation_node_ip_port_unique` au hasard des suites (`server-resize`,
 * sous-domaines).
 */
describe.skipIf(!HAS_DATABASE)("seedServer", () => {
  let throwaway: ThrowawayDatabase;

  beforeAll(async () => {
    throwaway = await createThrowawayDatabase();
  }, 60_000);

  afterAll(async () => {
    await throwaway?.drop();
  });

  it("donne à chaque serveur d'un node un port à lui", async () => {
    const db = throwaway.db;
    const ownerId = await seedUser(db);
    const nodeId = await seedNode(db, { locationId: await seedLocation(db) });
    for (let i = 0; i < 300; i++) await seedServer(db, { nodeId, ownerId });
    expect(await db.$count(servers)).toBe(300);
  }, 60_000);
});

if (!HAS_DATABASE) console.warn(NO_DATABASE_REASON);
