import { allocations, type Database, servers } from "@gamedashboard/db";
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
import type { WingsClientService } from "../wings/wings-client.service";
import { AllocationsService } from "./allocations.service";

/**
 * Le quota de ports tient sous des demandes simultanées.
 *
 * Même défaut que les quotas de NC-08, relevé en les corrigeant : `claim`
 * comptait les ports du serveur **hors transaction**, puis prenait un port
 * libre. Le verrou ne portait que sur la ligne du port pris, pas sur le
 * compte : cinq demandes lancées ensemble lisaient toutes « 1 sur 2 », et
 * toutes passaient. Le quota que l'hébergeur vend se dépassait d'un clic
 * répété.
 */
describe.skipIf(!HAS_DATABASE)("AllocationsService.claim sous concurrence (intégration)", () => {
  let throwaway: ThrowawayDatabase;
  let db: Database;
  let service: AllocationsService;
  let serverId: string;
  const sousDomaines = sousDomainesInertes();

  beforeAll(async () => {
    Logger.overrideLogger(false);
    throwaway = await createThrowawayDatabase();
    db = throwaway.db;
    // La resynchronisation avec le daemon n'est pas le sujet.
    service = new AllocationsService(
      db,
      {
        syncServer: async () => undefined,
      } as unknown as WingsClientService,
      sousDomaines,
    );
  }, 60_000);

  afterAll(async () => {
    await throwaway?.drop();
  });

  beforeEach(async () => {
    await db.execute(
      sql.raw("truncate table servers, allocations, eggs, nests, nodes, locations, users cascade"),
    );
    const nodeId = await seedNode(db, { locationId: await seedLocation(db) });
    // Un port déjà pris (le principal), un quota de deux : il en reste un.
    serverId = await seedServer(db, { nodeId, ownerId: await seedUser(db) });
    await db.update(servers).set({ allocationLimit: 2 }).where(eq(servers.id, serverId));
    // La fixture pose le port principal sans le rattacher : il doit compter.
    const [principal] = await db
      .select({ id: servers.allocationId })
      .from(servers)
      .where(eq(servers.id, serverId));
    await db
      .update(allocations)
      .set({ serverId })
      .where(eq(allocations.id, principal?.id as string));
    await db
      .insert(allocations)
      .values(
        [1, 2, 3, 4, 5, 6].map((index) => ({ nodeId, ip: "127.0.0.3", port: 40_000 + index })),
      );
  });

  it("n'accorde qu'un port de plus, même à cinq demandes simultanées", async () => {
    const issues = await Promise.allSettled(
      Array.from({ length: 5 }, () => service.claim(serverId)),
    );

    expect(issues.filter((issue) => issue.status === "fulfilled")).toHaveLength(1);
    for (const issue of issues) {
      if (issue.status === "rejected") expect(issue.reason).toBeInstanceOf(ConflictException);
    }
    expect(await service.quota(serverId)).toEqual({ used: 2, limit: 2 });
  });

  it("prévient le sous-domaine quand le port principal change", async () => {
    const accorde = await service.claim(serverId);
    sousDomaines.refresh.mockClear();
    await service.setPrimary(serverId, accorde.id);
    expect(sousDomaines.refresh).toHaveBeenCalledWith(serverId);
  });
});

if (!HAS_DATABASE) console.warn(NO_DATABASE_REASON);
