import { createHash } from "node:crypto";
import { type Database, serverInvites, serverSubusers, servers } from "@gamedashboard/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { seedLocation, seedNode, seedServer, seedUser } from "../../test/fixtures";
import {
  createThrowawayDatabase,
  HAS_DATABASE,
  type ThrowawayDatabase,
} from "../../test/throwaway-database";
import { ActivityService } from "../activity/activity.service";
import { AdminServerService } from "../admin/admin-server.service";
import type { PlatformSettingsService } from "../admin/platform-settings.service";
import type { MailerService } from "../mail/mailer.service";
import type { BrandingService } from "../reseller/branding.service";
import type { WingsClientService } from "../wings/wings-client.service";
import { WingsTokenService } from "../wings/wings-token.service";
import type { DatabasesService } from "./databases.service";
import { ServerInvitesService } from "./server-invites.service";

/**
 * Une invitation acceptée pendant un changement de titulaire ne survit pas.
 *
 * `accept` consommait l'invitation, puis créait l'accès, sans rien verrouiller.
 * Un second compte que l'ancien titulaire s'était invité, accepté entre la
 * lecture du titulaire et le retrait des invités par le transfert, gardait
 * l'accès au serveur du nouveau : exactement ce que « tout nettoyer » visait.
 * L'acceptation prend désormais le verrou du serveur que prend le transfert.
 */
describe.skipIf(!HAS_DATABASE)("invitation acceptée pendant un transfert (intégration)", () => {
  let throwaway: ThrowawayDatabase;
  let db: Database;
  let invitations: ServerInvitesService;
  let serverId: string;
  let ancien: string;
  let second: string;
  let nouveau: string;

  const JETON = "jeton-d-invitation-assez-long";

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
    invitations = new ServerInvitesService(
      db,
      {} as MailerService,
      {} as PlatformSettingsService,
      {} as BrandingService,
    );
    ancien = await seedUser(db);
    second = await seedUser(db);
    nouveau = await seedUser(db);
    const nodeId = await seedNode(db, { locationId: await seedLocation(db) });
    serverId = await seedServer(db, { nodeId, ownerId: ancien });
    await db.insert(serverInvites).values({
      serverId,
      email: "second@exemple.fr",
      tokenHash: createHash("sha256").update(JETON).digest("hex"),
      permissions: ["files.read"],
      invitedBy: ancien,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
  });

  async function enAttenteDeVerrou(): Promise<number> {
    const resultat = (await db.execute(
      sql`select count(*)::int as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`,
    )) as unknown as { n: number }[] | { rows: { n: number }[] };
    const lignes = Array.isArray(resultat) ? resultat : resultat.rows;
    return lignes[0]?.n ?? 0;
  }

  it("attend la fin d'un transfert en cours avant de rien consommer, puis le trouve fait", async () => {
    let liberer: () => void = () => undefined;
    const retenue = new Promise<void>((resolve) => {
      liberer = resolve;
    });
    let signaler: () => void = () => undefined;
    const verrouille = new Promise<void>((resolve) => {
      signaler = resolve;
    });
    // Un transfert en cours : il a pris la ligne du serveur et changé de titulaire.
    const transfert = db.transaction(async (tx) => {
      await tx.select().from(servers).where(eq(servers.id, serverId)).for("update");
      await tx.update(servers).set({ ownerId: nouveau }).where(eq(servers.id, serverId));
      signaler();
      await retenue;
    });
    await verrouille;

    const acceptation = invitations.accept(JETON, second, "second@exemple.fr");
    acceptation.catch(() => undefined);
    // Sans le verrou, l'acceptation passait ici, avec l'ancien titulaire.
    await vi.waitFor(async () => expect(await enAttenteDeVerrou()).toBeGreaterThan(0));
    const [invitation] = await db
      .select({ acceptedAt: serverInvites.acceptedAt })
      .from(serverInvites)
      .where(eq(serverInvites.serverId, serverId));
    expect(invitation?.acceptedAt).toBeNull();
    liberer();
    await transfert;

    // Le transfert fait, l'invitation de l'ancien titulaire n'engage plus personne.
    await expect(acceptation).rejects.toThrow("n'est plus valable");
    expect(
      await db.select().from(serverSubusers).where(eq(serverSubusers.serverId, serverId)),
    ).toEqual([]);
  });

  it("lancés ensemble, l'acceptation et le transfert ne laissent aucun accès", async () => {
    const wings = {
      denyWebsocketTokens: vi.fn(async () => undefined),
      deauthorizeUser: vi.fn(async () => undefined),
    };
    const service = new AdminServerService(
      db,
      wings as unknown as WingsClientService,
      new WingsTokenService(db),
      { rotatePassword: vi.fn() } as unknown as DatabasesService,
      new ActivityService(db),
    );

    await Promise.allSettled([
      invitations.accept(JETON, second, "second@exemple.fr"),
      service.setOwner(serverId, nouveau, {
        event: "admin.server_owner_changed",
        actorId: null,
        actorType: "user",
        actorLabel: "admin@gamedashboard.test",
        ip: null,
      }),
    ]);

    // Quel que soit l'ordre, le second compte de l'ancien titulaire n'a pas
    // d'accès au serveur du nouveau.
    expect(
      await db.select().from(serverSubusers).where(eq(serverSubusers.serverId, serverId)),
    ).toEqual([]);
  });
});
