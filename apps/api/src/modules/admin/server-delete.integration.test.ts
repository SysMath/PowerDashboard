import { backups, type Database, servers } from "@gamedashboard/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { seedLocation, seedNode, seedServer, seedUser } from "../../test/fixtures";
import { sousDomainesInertes } from "../../test/sous-domaines";
import {
  createThrowawayDatabase,
  HAS_DATABASE,
  type ThrowawayDatabase,
} from "../../test/throwaway-database";
import type { SessionRepository } from "../auth/session.repository";
import type { S3Service } from "../storage/s3.service";
import type { WebhookEmitterService } from "../webhooks/webhook-emitter.service";
import { type WingsClientService, WingsUnavailableError } from "../wings/wings-client.service";
import type { WingsTokenService } from "../wings/wings-token.service";
import { AdminActionsService } from "./admin-actions.service";

/**
 * Suppression d'un serveur : ses archives distantes partent avec lui.
 *
 * La base oublie les sauvegardes en cascade. Sans passage par le
 * compartiment, celles qui y étaient déposées restaient facturées sans plus
 * apparaître nulle part — une fuite qui ne se découvre qu'à la facture.
 */
describe.skipIf(!HAS_DATABASE)("AdminActionsService.deleteServer (intégration)", () => {
  let throwaway: ThrowawayDatabase;
  let db: Database;
  let serverId: string;

  const wings = { deleteServer: vi.fn(async () => undefined) };
  const s3 = {
    keyFor: vi.fn(async (serveur: string, sauvegarde: string) => `${serveur}/${sauvegarde}.tar.gz`),
    discard: vi.fn(async () => undefined),
  };
  let service: AdminActionsService;
  const sousDomaines = sousDomainesInertes();

  beforeAll(async () => {
    throwaway = await createThrowawayDatabase();
    db = throwaway.db;
    service = new AdminActionsService(
      db,
      wings as unknown as WingsClientService,
      {} as SessionRepository,
      { emit: async () => undefined } as unknown as WebhookEmitterService,
      {} as WingsTokenService,
      s3 as unknown as S3Service,
      sousDomaines,
    );
  }, 60_000);

  afterAll(async () => {
    await throwaway?.drop();
  });

  beforeEach(async () => {
    await db.execute(
      sql.raw(
        `truncate table backups, servers, allocations, eggs, nests, nodes, locations, users cascade`,
      ),
    );
    vi.clearAllMocks();
    const locationId = await seedLocation(db);
    const nodeId = await seedNode(db, { locationId });
    serverId = await seedServer(db, { nodeId, ownerId: await seedUser(db) });
  });

  async function sauvegarde(disk: "local" | "s3", uploadId: string | null = null) {
    const [row] = await db
      .insert(backups)
      .values({ serverId, name: "Nuit", disk, uploadId })
      .returning({ id: backups.id });
    if (!row) throw new Error("sauvegarde non créée");
    return row.id;
  }

  it("efface du compartiment les archives distantes, et elles seules", async () => {
    const terminee = await sauvegarde("s3");
    const enCours = await sauvegarde("s3", "depot-ouvert");
    await sauvegarde("local");

    await service.deleteServer(serverId);

    expect(s3.discard).toHaveBeenCalledTimes(2);
    expect(s3.discard).toHaveBeenCalledWith(`${serverId}/${terminee}.tar.gz`, null);
    expect(s3.discard).toHaveBeenCalledWith(`${serverId}/${enCours}.tar.gz`, "depot-ouvert");
    expect(await db.select().from(servers).where(eq(servers.id, serverId))).toEqual([]);
    // Le sous-domaine du serveur disparaît avec lui, sans attendre le balayage.
    expect(sousDomaines.departing).toHaveBeenCalledWith(expect.anything(), serverId);
    expect(sousDomaines.sweepSoon).toHaveBeenCalled();
  });

  it("n'efface rien quand le node ne répond pas : le serveur reste", async () => {
    await sauvegarde("s3");
    wings.deleteServer.mockRejectedValueOnce(new WingsUnavailableError("N1", "délai dépassé"));

    await expect(service.deleteServer(serverId)).rejects.toBeInstanceOf(WingsUnavailableError);
    expect(s3.discard).not.toHaveBeenCalled();
    expect(sousDomaines.sweepSoon).not.toHaveBeenCalled();
    expect(await db.select().from(servers).where(eq(servers.id, serverId))).toHaveLength(1);
  });
});
