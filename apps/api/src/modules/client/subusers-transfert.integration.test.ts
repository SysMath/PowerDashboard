import { type Database, serverSubusers, servers, users } from "@gamedashboard/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { seedLocation, seedNode, seedServer, seedUser } from "../../test/fixtures";
import {
  createThrowawayDatabase,
  HAS_DATABASE,
  type ThrowawayDatabase,
} from "../../test/throwaway-database";
import { AdminServerService } from "../admin/admin-server.service";
import type { NotificationsService } from "../notifications/notifications.service";
import type { WingsClientService } from "../wings/wings-client.service";
import { WingsTokenService } from "../wings/wings-token.service";
import type { DatabasesService } from "./databases.service";
import type { ServerInvitesService } from "./server-invites.service";
import { SubusersService } from "./subusers.service";

/**
 * Un invité ajouté pendant un changement de titulaire ne survit pas.
 *
 * `invite` contrôlait les droits de l'auteur, puis insérait l'accès, hors de
 * tout verrou. L'ancien titulaire qui passait le contrôle juste avant le
 * transfert insérait son second compte juste après le retrait des invités :
 * ce compte gardait l'accès au serveur du nouveau. L'ajout prend désormais le
 * verrou du serveur que prend le transfert, et relit les droits sous lui.
 */
describe.skipIf(!HAS_DATABASE)("invité ajouté pendant un transfert (intégration)", () => {
  let throwaway: ThrowawayDatabase;
  let db: Database;
  let invites: SubusersService;
  let serverId: string;
  let ancien: string;
  let second: string;
  let nouveau: string;
  let adresse: string;

  const notifications = { notify: vi.fn(async () => undefined) };

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
    notifications.notify.mockClear();
    invites = new SubusersService(
      db,
      {} as WingsClientService,
      new WingsTokenService(db),
      notifications as unknown as NotificationsService,
      {} as ServerInvitesService,
    );
    ancien = await seedUser(db);
    second = await seedUser(db);
    nouveau = await seedUser(db);
    const [ligne] = await db.select({ email: users.email }).from(users).where(eq(users.id, second));
    adresse = ligne?.email ?? "";
    const nodeId = await seedNode(db, { locationId: await seedLocation(db) });
    serverId = await seedServer(db, { nodeId, ownerId: ancien });
  });

  async function enAttenteDeVerrou(): Promise<number> {
    const resultat = (await db.execute(
      sql`select count(*)::int as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`,
    )) as unknown as { n: number }[] | { rows: { n: number }[] };
    const lignes = Array.isArray(resultat) ? resultat : resultat.rows;
    return lignes[0]?.n ?? 0;
  }

  async function acces(): Promise<unknown[]> {
    return db.select().from(serverSubusers).where(eq(serverSubusers.serverId, serverId));
  }

  it("attend la fin d'un transfert en cours avant d'insérer, puis refuse l'ancien titulaire", async () => {
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

    const ajout = invites.invite(serverId, ancien, adresse, ["files.read"]);
    ajout.catch(() => undefined);
    // Sans le verrou, l'accès était déjà là, accordé par l'ancien titulaire.
    await vi.waitFor(async () => expect(await enAttenteDeVerrou()).toBeGreaterThan(0));
    expect(await acces()).toEqual([]);
    liberer();
    await transfert;

    // Le transfert fait, l'ancien titulaire n'accorde plus rien.
    await expect(ajout).rejects.toThrow("que vous n'avez pas");
    expect(await acces()).toEqual([]);
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it("lancés ensemble, l'ajout et le transfert ne laissent aucun accès", async () => {
    const service = new AdminServerService(
      db,
      {
        denyWebsocketTokens: vi.fn(async () => undefined),
        deauthorizeUser: vi.fn(async () => undefined),
      } as unknown as WingsClientService,
      new WingsTokenService(db),
      { rotatePassword: vi.fn() } as unknown as DatabasesService,
    );

    await Promise.allSettled([
      invites.invite(serverId, ancien, adresse, ["files.read"]),
      service.setOwner(serverId, nouveau, {
        event: "admin.server_owner_changed",
        actorId: null,
        actorType: "user",
        actorLabel: "admin@gamedashboard.test",
        ip: null,
      }),
    ]);

    expect(await acces()).toEqual([]);
  });

  it("hors transfert, le titulaire ajoute toujours son invité", async () => {
    const cree = await invites.invite(serverId, ancien, adresse, ["files.read"]);

    expect(cree).toMatchObject({ userId: second });
    expect(await acces()).toHaveLength(1);
    expect(notifications.notify).toHaveBeenCalledTimes(1);
  });
});
