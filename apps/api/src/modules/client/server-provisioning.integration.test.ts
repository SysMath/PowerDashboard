import { randomBytes } from "node:crypto";
import {
  allocations,
  type Database,
  eggs,
  nests,
  resellerCustomers,
  resellerQuotas,
  serverSubusers,
  servers,
  users,
} from "@gamedashboard/db";
import { ConflictException, ForbiddenException } from "@nestjs/common";
import { count, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { seedLocation, seedNode, seedServer, seedUser } from "../../test/fixtures";
import {
  createThrowawayDatabase,
  HAS_DATABASE,
  type ThrowawayDatabase,
} from "../../test/throwaway-database";
import type { PlatformSettingsService } from "../admin/platform-settings.service";
import { ResellerQuotaService } from "../reseller/reseller-quota.service";
import type { WebhookEmitterService } from "../webhooks/webhook-emitter.service";
import type { WingsClientService } from "../wings/wings-client.service";
import type { CatalogueService } from "./catalogue.service";
import { ServerProvisioningService } from "./server-provisioning.service";

/**
 * L'enveloppe du revendeur, à la création, contre une vraie base.
 *
 * Le quota compte en SQL (consommation relevée, sinon limites) : une doublure
 * de base vérifierait surtout qu'elle est d'accord avec elle-même. Le
 * catalogue, le daemon et les rappels sont des doublures — seule la règle
 * « ce qui se rattache au revendeur tient dans son enveloppe » est sous test.
 */
describe.skipIf(!HAS_DATABASE)("ServerProvisioningService — enveloppe du revendeur", () => {
  let throwaway: ThrowawayDatabase;
  let db: Database;
  let service: ServerProvisioningService;

  let revendeur: string;
  let client: string;
  let nodeId: string;
  let locationId: string;
  let eggId: string;

  const OFFRE = {
    id: "offre-test",
    name: "Offre de test",
    memoryMb: 2048,
    diskMb: 10_240,
    cpuPct: 100,
    swapMb: 0,
    backups: 1,
    databases: 0,
    allocations: 1,
    priceLabel: "—",
  };

  const platform = { boolean: vi.fn(async () => false) };

  const catalogue = {
    plans: vi.fn(async () => [OFFRE]),
    pickNode: vi.fn(async () => nodeId),
    pickNodeForReseller: vi.fn(async () => nodeId),
    nodeCapacity: vi.fn(async () => ({
      id: nodeId,
      ownerId: revendeur,
      maintenanceMode: false,
      freePorts: 50,
      freeMemoryMb: 1_000_000,
      freeDiskMb: 10_000_000,
    })),
  };

  beforeAll(async () => {
    throwaway = await createThrowawayDatabase();
    db = throwaway.db;
    service = new ServerProvisioningService(
      db,
      catalogue as unknown as CatalogueService,
      { createServer: async () => undefined } as unknown as WingsClientService,
      new ResellerQuotaService(db),
      { emit: async () => undefined } as unknown as WebhookEmitterService,
      platform as unknown as PlatformSettingsService,
    );
  }, 60_000);

  afterAll(async () => {
    await throwaway?.drop();
  });

  beforeEach(async () => {
    await db.execute(
      sql.raw(
        `truncate table reseller_quotas, servers, allocations, eggs, nests, nodes, locations, users cascade`,
      ),
    );
    vi.clearAllMocks();
    // Rétablie à chaque test : l'essai de concurrence la remplace.
    platform.boolean.mockImplementation(async () => false);

    revendeur = await seedUser(db);
    await db.update(users).set({ role: "reseller" }).where(eq(users.id, revendeur));
    client = await seedUser(db);

    locationId = await seedLocation(db);
    nodeId = await seedNode(db, { locationId, ownerId: revendeur });

    // Un serveur déjà rattaché au revendeur : l'enveloppe n'en admet qu'un.
    const existant = await seedServer(db, { nodeId, ownerId: client });
    await db.update(servers).set({ resellerId: revendeur }).where(eq(servers.id, existant));
    await db
      .insert(resellerQuotas)
      .values({ userId: revendeur, memoryMb: null, diskMb: null, serversMax: 1 });

    // Des ports libres en nombre : c'est l'enveloppe qui doit refuser, pas le stock.
    await db
      .insert(allocations)
      .values(Array.from({ length: 8 }, (_, i) => ({ nodeId, ip: "127.0.0.1", port: 30_000 + i })));

    const [nest] = await db
      .insert(nests)
      .values({ name: `Famille ${randomBytes(3).toString("hex")}` })
      .returning({ id: nests.id });
    const [egg] = await db
      .insert(eggs)
      .values({
        nestId: nest?.id ?? "",
        name: "Jeu de test",
        startup: "./start",
        installContainer: "debian:bookworm-slim",
        dockerImages: { Debian: "debian:bookworm-slim" },
        enabled: true,
      })
      .returning({ id: eggs.id });
    eggId = egg?.id ?? "";
  });

  async function serveursDuRevendeur(): Promise<number> {
    const [row] = await db
      .select({ n: count() })
      .from(servers)
      .where(eq(servers.resellerId, revendeur));
    return row?.n ?? 0;
  }

  it("refuse une commande guidée passée pour un revendeur dont l'enveloppe est pleine", async () => {
    await expect(
      service.create(
        { id: client, role: "user", onBehalfOf: revendeur },
        { eggId, name: "Commande", variables: {}, planId: OFFRE.id, locationId },
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(await serveursDuRevendeur()).toBe(1);
  });

  it("laisse passer la même commande quand l'enveloppe a de la place", async () => {
    await db
      .update(resellerQuotas)
      .set({ serversMax: 2 })
      .where(eq(resellerQuotas.userId, revendeur));

    await service.create(
      { id: client, role: "user", onBehalfOf: revendeur },
      { eggId, name: "Commande", variables: {}, planId: OFFRE.id, locationId },
    );

    expect(await serveursDuRevendeur()).toBe(2);
  });

  /*
   * Place pour un seul serveur, cinq demandes simultanées.
   *
   * Sans verrou, chacune lisait la consommation avant que les autres aient
   * écrit, trouvait la place libre, et les cinq passaient : l'enveloppe se
   * contournait en tirant plus vite qu'elle ne comptait.
   */
  it("n'accorde la dernière place qu'une fois, même à des demandes simultanées", async () => {
    await db
      .update(resellerQuotas)
      .set({ serversMax: 2 })
      .where(eq(resellerQuotas.userId, revendeur));

    /*
     * La lecture du réglage « tueur de mémoire » tombe entre le contrôle de
     * l'enveloppe et l'écriture : chaque demande y est retenue jusqu'à ce que
     * les cinq y soient. Toutes ont alors compté avant qu'aucune n'écrive —
     * l'entrelacement exact du défaut, rendu certain au lieu d'être laissé au
     * hasard de l'ouverture des connexions.
     */
    let arrivees = 0;
    let lacher: () => void = () => undefined;
    const toutes = new Promise<void>((resolve) => {
      lacher = resolve;
    });
    platform.boolean.mockImplementation(async () => {
      arrivees += 1;
      if (arrivees === 5) lacher();
      await toutes;
      return false;
    });

    const demande = () =>
      service.create(
        { id: revendeur, role: "reseller" },
        {
          eggId,
          name: "Rafale",
          variables: {},
          nodeId,
          resources: {
            memoryMb: 1024,
            diskMb: 2048,
            cpuPct: 100,
            swapMb: 0,
            allocations: 1,
            backups: 0,
            databases: 0,
          },
        },
      );

    const issues = await Promise.allSettled(Array.from({ length: 5 }, demande));

    expect(issues.filter((issue) => issue.status === "fulfilled")).toHaveLength(1);
    for (const issue of issues.filter((i) => i.status === "rejected")) {
      expect((issue as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
    }
    expect(await serveursDuRevendeur()).toBe(2);
  });
  /*
   * L'espace revendeur donne un serveur selon la règle de la clé de sa
   * boutique. Il ne regardait que les serveurs possédés ailleurs : un compte
   * invité à la plateforme, un administrateur ou un autre revendeur
   * recevaient un serveur, après quoi la clé lisait la fiche et ouvrait la
   * session.
   */
  describe("destinataire désigné depuis l'espace revendeur", () => {
    const destinataire = (ownerId: string) =>
      (
        service as unknown as {
          resolveOwner: (r: unknown, m: string, o: string) => Promise<string>;
        }
      ).resolveOwner({ id: revendeur, role: "reseller" }, "assisted", ownerId);

    it("refuse un compte qui n'est pas à lui : invité ailleurs, inscrit, personnel, revendeur", async () => {
      const inviteAilleurs = await seedUser(db);
      const aLaPlateforme = await seedServer(db, { nodeId, ownerId: await seedUser(db) });
      await db.update(servers).set({ resellerId: null }).where(eq(servers.id, aLaPlateforme));
      await db.insert(serverSubusers).values({ serverId: aLaPlateforme, userId: inviteAilleurs });
      const inscrit = await seedUser(db);
      const administrateur = await seedUser(db);
      await db.update(users).set({ role: "admin" }).where(eq(users.id, administrateur));
      const confrere = await seedUser(db);
      await db
        .update(users)
        .set({ role: "reseller", platformAccess: "provision" })
        .where(eq(users.id, confrere));

      for (const cible of [inviteAilleurs, inscrit, administrateur, confrere]) {
        await expect(destinataire(cible)).rejects.toBeInstanceOf(ForbiddenException);
      }
    });

    it("même réponse pour un compte inexistant, hors de son périmètre ou illisible", async () => {
      const ailleurs = await seedUser(db);
      const refus = async (cible: string) => {
        const erreur = await destinataire(cible).catch((e: unknown) => e);
        expect(erreur).toBeInstanceOf(ForbiddenException);
        return (erreur as ForbiddenException).message;
      };

      const messages = new Set([
        await refus(ailleurs),
        await refus("5f7c2d1e-8a0b-4c3d-9e2f-1a2b3c4d5e6f"),
        // PostgreSQL refusait la conversion : 500.
        await refus("abc"),
      ]);
      expect(messages.size).toBe(1);
    });

    it("accepte son client et le compte que sa boutique a créé", async () => {
      const cree = await seedUser(db);
      await db
        .insert(resellerCustomers)
        .values({ userId: cree, resellerId: revendeur, origin: "api" });

      await expect(destinataire(client)).resolves.toBe(client);
      await expect(destinataire(cree)).resolves.toBe(cree);
    });
  });
});
