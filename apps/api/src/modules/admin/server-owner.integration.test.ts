import { type Database, servers } from "@gamedashboard/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { seedLocation, seedNode, seedServer, seedUser } from "../../test/fixtures";
import {
  createThrowawayDatabase,
  HAS_DATABASE,
  type ThrowawayDatabase,
} from "../../test/throwaway-database";
import type { WingsClientService } from "../wings/wings-client.service";
import { WingsTokenService } from "../wings/wings-token.service";
import { AdminServerService } from "./admin-server.service";

/**
 * Changer le propriétaire d'un serveur ferme les consoles de l'ancien.
 *
 * Un jeton de console vit dix minutes et Wings ne revérifie pas qui le porte.
 * La suspension et le retrait d'un sous-utilisateur révoquaient déjà ; le
 * changement de propriétaire, non : l'ancien propriétaire gardait la console
 * d'un serveur qui n'était plus le sien. Le registre des jetons est le vrai ;
 * seul le daemon est une doublure.
 */
describe.skipIf(!HAS_DATABASE)("AdminServerService.setOwner (intégration)", () => {
  let throwaway: ThrowawayDatabase;
  let db: Database;
  let serverId: string;
  let ancien: string;
  let invite: string;
  let nouveau: string;

  const wings = { denyWebsocketTokens: vi.fn(async () => undefined) };
  let tokens: WingsTokenService;
  let service: AdminServerService;

  /** Inscrit un jeton vivant, comme `websocketGrant` l'aurait fait. */
  function jeton(jti: string, userId: string): void {
    (
      tokens as unknown as {
        issued: { jti: string; serverId: string; userId: string; expiresAt: number }[];
      }
    ).issued.push({ jti, serverId, userId, expiresAt: Math.floor(Date.now() / 1000) + 600 });
  }

  beforeAll(async () => {
    throwaway = await createThrowawayDatabase();
    db = throwaway.db;
  }, 60_000);

  afterAll(async () => {
    await throwaway?.drop();
  });

  beforeEach(async () => {
    await db.execute(
      sql.raw(`truncate table servers, allocations, eggs, nests, nodes, locations, users cascade`),
    );
    vi.clearAllMocks();

    tokens = new WingsTokenService(db);
    service = new AdminServerService(db, wings as unknown as WingsClientService, tokens);

    ancien = await seedUser(db);
    invite = await seedUser(db);
    nouveau = await seedUser(db);
    const nodeId = await seedNode(db, { locationId: await seedLocation(db) });
    serverId = await seedServer(db, { nodeId, ownerId: ancien });
  });

  it("révoque les jetons de console de l'ancien propriétaire", async () => {
    jeton("console-ancien", ancien);
    await service.setOwner(serverId, nouveau);

    expect(wings.denyWebsocketTokens).toHaveBeenCalledWith(serverId, ["console-ancien"]);
    const [row] = await db
      .select({ ownerId: servers.ownerId })
      .from(servers)
      .where(eq(servers.id, serverId));
    expect(row?.ownerId).toBe(nouveau);
  });

  it("laisse leur console aux sous-utilisateurs, qui restent invités", async () => {
    jeton("console-ancien", ancien);
    jeton("console-invite", invite);
    await service.setOwner(serverId, nouveau);

    expect(wings.denyWebsocketTokens).toHaveBeenCalledWith(serverId, ["console-ancien"]);
    expect(tokens.revocableFor(serverId, invite)).toEqual(["console-invite"]);
  });

  it("n'échoue pas quand le node ne répond pas : la base fait foi", async () => {
    jeton("console-ancien", ancien);
    wings.denyWebsocketTokens.mockRejectedValueOnce(new Error("node injoignable"));

    await expect(service.setOwner(serverId, nouveau)).resolves.toBeUndefined();
  });

  it("refuse un identifiant illisible sans le confier à la base, qui rendait une erreur 500", async () => {
    await expect(service.setOwner(serverId, "nimporte-quoi")).rejects.toThrow(
      "Compte destinataire inconnu.",
    );
    await expect(service.setOwner("nimporte-quoi", nouveau)).rejects.toThrow(
      "Serveur introuvable.",
    );
  });
});
