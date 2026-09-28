import { Logger, ServiceUnavailableException } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActivityService } from "../activity/activity.service";
import type { AdminActionsService } from "../admin/admin-actions.service";
import type { AdminServerService } from "../admin/admin-server.service";
import type { BillingSsoService } from "../auth/billing-sso.service";
import type { ServerResizeService } from "../client/server-resize.service";
import type { BrandingService } from "../reseller/branding.service";
import type { ResellerQuotaService } from "../reseller/reseller-quota.service";
import { DAEMON_UNAVAILABLE_MESSAGE, WingsUnavailableError } from "../wings/wings-client.service";
import { ApplicationController } from "./application.controller";
import type { ApplicationRequest } from "./application.guard";
import type { ApplicationService } from "./application.service";
import type { IdempotencyService } from "./idempotency.service";
import type { ResellerScopeService } from "./reseller-scope.service";

/**
 * Une panne du daemon, telle que la lit un système tiers.
 *
 * Même défaut que dans l'espace client : le message partait brut, nom
 * interne du node et adresse privée compris — et une clé de revendeur le
 * recevait pour une machine de la plateforme sur laquelle il loue une part.
 */
describe("API applicative : panne du daemon", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rend un message générique, et garde la cause au journal du processus", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const controleur = new ApplicationController(
      {} as ApplicationService,
      {
        deleteServer: vi.fn(async () =>
          Promise.reject(
            new WingsUnavailableError("NODE-PARIS-03", "connect ECONNREFUSED 10.0.0.5:8080"),
          ),
        ),
      } as unknown as AdminActionsService,
      {} as ResellerQuotaService,
      {} as IdempotencyService,
      { record: vi.fn(async () => {}) } as unknown as ActivityService,
      {} as BillingSsoService,
      { requireServer: vi.fn(async () => {}) } as unknown as ResellerScopeService,
      {} as BrandingService,
      {} as ServerResizeService,
      {} as AdminServerService,
    );
    const requete = {
      application: { id: "cle-1", name: "Boutique", resellerId: "rev-1", scopes: [] },
    } as unknown as ApplicationRequest;

    const erreur = await controleur.deleteServer(requete, "srv-1").then(
      () => null,
      (error: Error) => error,
    );

    expect(erreur).toBeInstanceOf(ServiceUnavailableException);
    expect(erreur?.message).toBe(DAEMON_UNAVAILABLE_MESSAGE);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ECONNREFUSED 10.0.0.5:8080"));
  });
});
