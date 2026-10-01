import { type Database, resellerQuotas, servers, users } from "@gamedashboard/db";
import { ConflictException } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedLocation, seedNode, seedServer, seedUser } from "../../test/fixtures";
import {
  createThrowawayDatabase,
  HAS_DATABASE,
  type ThrowawayDatabase,
} from "../../test/throwaway-database";
import { ResellerQuotaService } from "../reseller/reseller-quota.service";
import type { WebhookEmitterService } from "../webhooks/webhook-emitter.service";
import type { WingsClientService } from "../wings/wings-client.service";
import type { CatalogueService } from "./catalogue.service";
import { ServerResizeService } from "./server-resize.service";

/**
 * Agrandir des serveurs en même temps, contre une vraie base.
 *
 * Le défaut corrigé : le contrôle de l'enveloppe et l'écriture des nouvelles
 * limites étaient deux requêtes sans transaction. Des agrandissements
 * simultanés lisaient tous la même consommation, trouvaient tous la place, et
 * passaient tous. Seule la base dit si un verrou tient : la machine et le
 * daemon sont des doublures.
 */
/**
 * L'enveloppe, qui retient chaque demande **après** son contrôle.
 *
 * Sans cela, l'entrelacement qui révèle le défaut — tous comptent avant
 * qu'aucun n'écrive — tiendrait au hasard de l'ouverture des connexions, et
 * le test passerait parfois sur le code fautif. Les demandes attendent ici
 * que toutes aient compté, ou une seconde au plus : une demande qui compte
 * sous le verrou d'une autre n'arrive qu'après son écriture, et l'attendre
 * sans borne bloquerait le code corrigé.
 */
class EnveloppeRetenue extends ResellerQuotaService {
  private arrivees = 0;
  private lacher: () => void = () => undefined;
  private readonly toutes = new Promise<void>((resolve) => {
    this.lacher = resolve;
  });

  constructor(
    db: Database,
    private readonly attendues: number,
  ) {
    super(db);
  }

  override async assertGrowth(...args: Parameters<ResellerQuotaService["assertGrowth"]>) {
    await super.assertGrowth(...args);
    this.arrivees += 1;
    if (this.arrivees === this.attendues) this.lacher();
    await Promise.race([this.toutes, new Promise((resolve) => setTimeout(resolve, 1000))]);
  }
}

describe.skipIf(!HAS_DATABASE)("ServerResizeService — enveloppe sous verrou", () => {
  let throwaway: ThrowawayDatabase;
  let db: Database;
  let revendeur: string;
  let parc: string[];

  function service(quotas: ResellerQuotaService): ServerResizeService {
    return new ServerResizeService(
      db,
      {
        nodeCapacity: async (id: string) => ({
          id,
          ownerId: revendeur,
          maintenanceMode: false,
          freePorts: 50,
          freeMemoryMb: 1_000_000,
          freeDiskMb: 10_000_000,
        }),
      } as unknown as CatalogueService,
      { syncServer: async () => undefined } as unknown as WingsClientService,
      quotas,
      { emit: async () => undefined } as unknown as WebhookEmitterService,
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
        `truncate table reseller_quotas, servers, allocations, eggs, nests, nodes, locations, users cascade`,
      ),
    );

    revendeur = await seedUser(db);
    await db.update(users).set({ role: "reseller" }).where(eq(users.id, revendeur));
    const client = await seedUser(db);
    const nodeId = await seedNode(db, { locationId: await seedLocation(db), ownerId: revendeur });

    // Quatre serveurs de 2 Go, jamais mesurés : leur consommation compte
    // pour leur limite, et l'enveloppe ne laisse de place que pour 2 Go.
    parc = [];
    for (let i = 0; i < 4; i++) {
      const id = await seedServer(db, { nodeId, ownerId: client });
      await db
        .update(servers)
        .set({ resellerId: revendeur, allocationLimit: 1 })
        .where(eq(servers.id, id));
      parc.push(id);
    }
    await db
      .insert(resellerQuotas)
      .values({ userId: revendeur, memoryMb: 4 * 2048 + 2048, diskMb: null, serversMax: null });
  });

  it("n'accorde la place restante qu'à un seul agrandissement simultané", async () => {
    const rafale = service(new EnveloppeRetenue(db, parc.length));
    const issues = await Promise.allSettled(
      parc.map((id) => rafale.resize({ id: revendeur, role: "reseller" }, id, { memoryMb: 4096 })),
    );

    expect(issues.filter((issue) => issue.status === "fulfilled")).toHaveLength(1);
    for (const issue of issues.filter((i) => i.status === "rejected")) {
      expect((issue as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
    }

    const [total] = await db
      .select({ memoire: sql<number>`sum(${servers.memoryMb})::int` })
      .from(servers)
      .where(eq(servers.resellerId, revendeur));
    expect(total?.memoire).toBe(4 * 2048 + 2048);
  });

  it("laisse toujours rétrécir, même au plafond", async () => {
    await db
      .update(resellerQuotas)
      .set({ memoryMb: 1024 })
      .where(eq(resellerQuotas.userId, revendeur));

    const [premier] = parc;
    await service(new ResellerQuotaService(db)).resize(
      { id: revendeur, role: "reseller" },
      premier ?? "",
      { memoryMb: 1024 },
    );

    const [row] = await db
      .select({ memoryMb: servers.memoryMb })
      .from(servers)
      .where(eq(servers.id, premier ?? ""));
    expect(row?.memoryMb).toBe(1024);
  });

  it("pose la limite d'instantanés épinglés, et la rend au node avec null", async () => {
    const [premier = ""] = parc;
    const redim = service(new ResellerQuotaService(db));
    const limite = async () =>
      (
        await db.select({ l: servers.snapshotLimit }).from(servers).where(eq(servers.id, premier))
      )[0]?.l;

    const apres = await redim.resize({ id: revendeur, role: "reseller" }, premier, {
      snapshots: 7,
    });
    expect(apres.snapshots).toBe(7);
    expect(await limite()).toBe(7);

    // Un autre champ seul ne touche pas à la limite.
    await redim.resize({ id: revendeur, role: "reseller" }, premier, { backups: 2 });
    expect(await limite()).toBe(7);

    await redim.resize({ id: revendeur, role: "reseller" }, premier, { snapshots: null });
    expect(await limite()).toBeNull();
  });
});
