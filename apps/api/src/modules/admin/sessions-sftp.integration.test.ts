import { type Database, serverSubusers, servers } from "@gamedashboard/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { seedLocation, seedNode, seedServer, seedUser } from "../../test/fixtures";
import {
  createThrowawayDatabase,
  HAS_DATABASE,
  type ThrowawayDatabase,
} from "../../test/throwaway-database";
import type { SessionRepository } from "../auth/session.repository";
import type { ServerInvitesService } from "../client/server-invites.service";
import { SubusersService } from "../client/subusers.service";
import type { SubdomainsService } from "../dns/subdomains.service";
import type { NotificationsService } from "../notifications/notifications.service";
import type { S3Service } from "../storage/s3.service";
import type { WebhookEmitterService } from "../webhooks/webhook-emitter.service";
import type { WingsClientService } from "../wings/wings-client.service";
import { WingsTokenService } from "../wings/wings-token.service";
import { AdminActionsService } from "./admin-actions.service";

/**
 * Retirer un sous-utilisateur ou suspendre un serveur coupe aussi le SFTP.
 *
 * Les deux gestes ne révoquaient que les jetons de console. La base refusait
 * ensuite toute nouvelle connexion SFTP, mais une session déjà ouverte
 * gardait les fichiers du serveur jusqu'à ce que son client se déconnecte :
 * l'invité retiré, ou le client suspendu pour impayé, pouvait continuer à
 * tout télécharger et tout modifier. `POST /api/deauthorize-user` de Wings
 * est la seule route qui coupe une session SFTP. Seul le daemon est une
 * doublure.
 */
describe.skipIf(!HAS_DATABASE)("sessions SFTP coupées (intégration)", () => {
  let throwaway: ThrowawayDatabase;
  let db: Database;
  let serverId: string;
  let autreServeur: string;
  let titulaire: string;
  let invite: string;
  let enAttente: string;

  const wings = {
    syncServer: vi.fn(async (_serverId: string) => undefined),
    denyWebsocketTokens: vi.fn(async () => undefined),
    deauthorizeUser: vi.fn(async (_serverId: string, _userId: string) => undefined),
  };
  const webhooks = { emit: vi.fn(async () => undefined) };

  function actions(): AdminActionsService {
    return new AdminActionsService(
      db,
      wings as unknown as WingsClientService,
      {} as SessionRepository,
      webhooks as unknown as WebhookEmitterService,
      new WingsTokenService(db),
      {} as S3Service,
      // La suspension ne touche pas aux sous-domaines.
      {} as SubdomainsService,
    );
  }

  function subusers(): SubusersService {
    return new SubusersService(
      db,
      wings as unknown as WingsClientService,
      new WingsTokenService(db),
      {} as NotificationsService,
      {} as ServerInvitesService,
    );
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
      sql.raw(
        `truncate table activity_logs, servers, allocations, eggs, nests, nodes, locations, users cascade`,
      ),
    );
    vi.clearAllMocks();
    wings.deauthorizeUser.mockReset();
    wings.deauthorizeUser.mockResolvedValue(undefined);

    titulaire = await seedUser(db);
    invite = await seedUser(db);
    enAttente = await seedUser(db);
    const nodeId = await seedNode(db, { locationId: await seedLocation(db) });
    serverId = await seedServer(db, { nodeId, ownerId: titulaire });
    autreServeur = await seedServer(db, { nodeId, ownerId: titulaire });
    await db.insert(serverSubusers).values([
      { serverId, userId: invite, acceptedAt: new Date().toISOString() },
      { serverId, userId: enAttente },
      // Invité ailleurs, sur un serveur du même titulaire : pas concerné.
      { serverId: autreServeur, userId: enAttente },
    ]);
  });

  describe("suspension", () => {
    it("coupe les sessions du titulaire et de chaque sous-utilisateur, sur ce serveur seulement", async () => {
      const bilan = await actions().setServerSuspended(serverId, true, "Impayé");

      expect(bilan).toEqual({ sessionsNotClosed: 0 });
      expect(wings.deauthorizeUser.mock.calls.map(([srv]) => srv)).toEqual([
        serverId,
        serverId,
        serverId,
      ]);
      expect(wings.deauthorizeUser.mock.calls.map(([, userId]) => userId).sort()).toEqual(
        [titulaire, invite, enAttente].sort(),
      );
    });

    it("un node muet n'empêche pas la suspension, et les comptes restés ouverts sont comptés", async () => {
      wings.deauthorizeUser.mockImplementation(async (_srv: string, userId: string) => {
        if (userId !== invite) throw new Error("node injoignable");
      });

      const bilan = await actions().setServerSuspended(serverId, true, "Impayé");

      expect(bilan).toEqual({ sessionsNotClosed: 2 });
      const [row] = await db
        .select({ state: servers.state })
        .from(servers)
        .where(eq(servers.id, serverId));
      expect(row?.state).toBe("suspended");
      expect(webhooks.emit).toHaveBeenCalledWith("server.suspended", {
        serverId,
        reason: "Impayé",
      });
    });

    it("rétablir ne coupe rien", async () => {
      const bilan = await actions().setServerSuspended(serverId, false, "");

      expect(bilan).toEqual({ sessionsNotClosed: 0 });
      expect(wings.deauthorizeUser).not.toHaveBeenCalled();
    });
  });

  describe("retrait d'un sous-utilisateur", () => {
    async function acces(userId: string): Promise<string> {
      const [row] = await db
        .select({ id: serverSubusers.id })
        .from(serverSubusers)
        .where(eq(serverSubusers.userId, userId))
        .limit(1);
      return row?.id ?? "";
    }

    it("coupe la session SFTP de la personne retirée, et d'elle seule", async () => {
      const retour = await subusers().remove(serverId, await acces(invite));

      expect(retour).toEqual({ sessionClosed: true });
      expect(wings.deauthorizeUser.mock.calls).toEqual([[serverId, invite]]);
      expect(
        await db.select().from(serverSubusers).where(eq(serverSubusers.userId, invite)),
      ).toEqual([]);
    });

    it("un node muet n'empêche pas le retrait, et la réponse le dit", async () => {
      wings.deauthorizeUser.mockRejectedValue(new Error("node injoignable"));

      const retour = await subusers().remove(serverId, await acces(invite));

      expect(retour).toEqual({ sessionClosed: false });
      expect(
        await db.select().from(serverSubusers).where(eq(serverSubusers.userId, invite)),
      ).toEqual([]);
    });
  });
});
