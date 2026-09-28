import type { Database } from "@gamedashboard/db";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { seedUser } from "../../test/fixtures";
import {
  createThrowawayDatabase,
  HAS_DATABASE,
  type ThrowawayDatabase,
} from "../../test/throwaway-database";
import type { ActivityService } from "../activity/activity.service";
import type { AdminActionsService } from "../admin/admin-actions.service";
import type { AdminServerService } from "../admin/admin-server.service";
import type { BillingSsoService } from "../auth/billing-sso.service";
import { ServerProvisioningService } from "../client/server-provisioning.service";
import type { ServerResizeService } from "../client/server-resize.service";
import type { BrandingService } from "../reseller/branding.service";
import type { ResellerQuotaService } from "../reseller/reseller-quota.service";
import { ApplicationController } from "./application.controller";
import type { ApplicationRequest } from "./application.guard";
import { ApplicationService } from "./application.service";
import type { IdempotencyService } from "./idempotency.service";
import { ResellerScopeService } from "./reseller-scope.service";

/**
 * Un identifiant illisible est un refus, jamais une erreur 500 de la base.
 *
 * PostgreSQL refuse de comparer `nimporte-quoi` à une colonne `uuid`, et la
 * route rendait alors 500 : un facturier le prend pour une panne et rejoue
 * sans fin. Les gardes du périmètre sortaient avant tout contrôle pour une
 * clé de plateforme, et l'identifiant de l'egg, comme celui d'une enveloppe
 * de revente, allait tel quel jusqu'à la base.
 *
 * Tout ici passe par une vraie base : c'est elle qui rendait l'erreur.
 */
describe.skipIf(!HAS_DATABASE)("identifiants illisibles (intégration)", () => {
  let throwaway: ThrowawayDatabase;
  let db: Database;
  let scope: ResellerScopeService;
  let revendeur: string;

  const actions = {
    setServerSuspended: vi.fn(),
    deleteServer: vi.fn(),
    deleteUser: vi.fn(),
  };
  const app = { updateUser: vi.fn(), ownedServers: vi.fn() };
  const resize = { resize: vi.fn() };
  const quotas = { report: vi.fn(), setQuota: vi.fn() };

  const requete = (resellerId: string | null) =>
    ({
      ip: "203.0.113.7",
      application: { keyId: "cle-1", name: "Boutique", resellerId, scopes: [] },
    }) as unknown as ApplicationRequest;

  function controleur(): ApplicationController {
    return new ApplicationController(
      app as unknown as ApplicationService,
      actions as unknown as AdminActionsService,
      quotas as unknown as ResellerQuotaService,
      {} as IdempotencyService,
      { record: vi.fn(async () => undefined) } as unknown as ActivityService,
      {} as BillingSsoService,
      scope,
      {} as BrandingService,
      resize as unknown as ServerResizeService,
      {} as AdminServerService,
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
    await db.execute(sql.raw(`truncate table servers, users cascade`));
    vi.clearAllMocks();
    scope = new ResellerScopeService(db);
    revendeur = await seedUser(db);
    await db.execute(sql`update users set role = 'reseller' where id = ${revendeur}`);
  });

  it("les gardes du périmètre refusent (404) pour une clé de plateforme comme pour un revendeur", async () => {
    for (const cle of [null, revendeur]) {
      await expect(scope.requireUser(cle, "nimporte-quoi")).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(scope.requireOwnedUser(cle, "nimporte-quoi")).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(scope.requireServer(cle, "nimporte-quoi")).rejects.toBeInstanceOf(
        NotFoundException,
      );
    }
    // Le destinataire d'une clé de revendeur passe par le rattachement.
    await expect(scope.requireRecipient(revendeur, "nimporte-quoi")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("les routes de la clé de plateforme rendent 404, sans rien appeler derrière", async () => {
    const c = controleur();
    const cle = requete(null);

    await expect(c.updateUser(cle, "nimporte-quoi", { firstName: "Paul" })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(c.deleteUser(cle, "nimporte-quoi")).rejects.toBeInstanceOf(NotFoundException);
    await expect(c.setSuspension(cle, "nimporte-quoi", { suspended: true })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(c.resizeServer(cle, "nimporte-quoi", { memoryMb: 2048 })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(c.deleteServer(cle, "nimporte-quoi")).rejects.toBeInstanceOf(NotFoundException);
    await expect(c.quota("nimporte-quoi")).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      c.setQuota(cle, "nimporte-quoi", { memoryMb: null, diskMb: null, serversMax: null }),
    ).rejects.toBeInstanceOf(NotFoundException);

    for (const appel of [
      app.updateUser,
      app.ownedServers,
      actions.setServerSuspended,
      actions.deleteServer,
      actions.deleteUser,
      resize.resize,
      quotas.report,
      quotas.setQuota,
    ]) {
      expect(appel).not.toHaveBeenCalled();
    }
  });

  it("création : un destinataire illisible est refusé pour lui-même, pas pour le placement", async () => {
    const service = new ApplicationService(
      db,
      {} as never,
      {} as never,
      { emit: vi.fn(async () => undefined) } as never,
    );
    // Placement complet : seul l'identifiant du destinataire peut faire
    // refuser, et le message le nomme.
    await expect(
      service.createServer({
        ownerId: "nimporte-quoi",
        eggId: "5f7c2d1e-8a0b-4c3d-9e2f-1a2b3c4d5e6f",
        name: "Survie",
        nodeId: "5f7c2d1e-8a0b-4c3d-9e2f-1a2b3c4d5e70",
        resources: {
          memoryMb: 2048,
          diskMb: 10240,
          cpuPct: 100,
          swapMb: 0,
          allocations: 0,
          backups: 0,
          databases: 0,
        },
      }),
    ).rejects.toThrow("Compte destinataire inconnu.");
  });

  it("création : un egg illisible est un jeu indisponible (400)", async () => {
    const provisioning = new ServerProvisioningService(
      db,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const eggFor = (
      provisioning as unknown as { eggFor(eggId: string): Promise<unknown> }
    ).eggFor.bind(provisioning);

    await expect(eggFor("nimporte-quoi")).rejects.toBeInstanceOf(BadRequestException);
    await expect(eggFor("nimporte-quoi")).rejects.toThrow("Jeu indisponible.");
  });

  it("un corps incomplet reçoit le message de zod en français", async () => {
    const c = controleur();
    const refus = c.setSuspension(requete(null), "nimporte-quoi", {});

    await expect(refus).rejects.toBeInstanceOf(BadRequestException);
    await expect(refus).rejects.toThrow("Champ « suspended » : Entrée invalide");
    await expect(
      c.setSuspension(requete(null), "nimporte-quoi", { suspended: "oui" }),
    ).rejects.toThrow(/Entrée invalide : booléen attendu/);
  });
});
