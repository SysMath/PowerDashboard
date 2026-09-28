import { describe, expect, it, vi } from "vitest";
import type { ConsumptionService } from "../consumption/consumption.service";
import type { ApplicationRequest } from "./application.guard";
import { ApplicationConsumptionController } from "./application-consumption.controller";

/**
 * Le périmètre d'une clé sur la consommation.
 *
 * C'est la route qui dit ce que chaque client a fait de son serveur : une clé
 * de revendeur qui oublierait sa borne lirait l'activité de tout le parc. La
 * borne se pose dans le contrôleur, jamais d'après la requête.
 */
function controleur() {
  const page = vi.fn(async () => ({ items: [], hasMore: false }));
  const controller = new ApplicationConsumptionController({
    page,
  } as unknown as ConsumptionService);
  return { controller, page };
}

function requete(resellerId: string | null): ApplicationRequest {
  return { application: { resellerId } } as unknown as ApplicationRequest;
}

describe("GET /api/v1/application/consumption", () => {
  it("borne une clé de revendeur à son parc, quels que soient les filtres", async () => {
    const { controller, page } = controleur();
    const revendeur = "5b0d3f5e-0000-4000-8000-00000000000a";

    await controller.list(requete(revendeur), {
      serverId: "5b0d3f5e-0000-4000-8000-00000000000b",
    });

    expect(page).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: "5b0d3f5e-0000-4000-8000-00000000000b",
        scope: { resellerId: revendeur },
      }),
      1,
    );
  });

  it("laisse une clé de plateforme lire tout le parc", async () => {
    const { controller, page } = controleur();
    await controller.list(requete(null), { page: "3" });
    const [filters, numero] = page.mock.calls[0] as unknown as [Record<string, unknown>, number];
    expect(filters).not.toHaveProperty("scope");
    expect(numero).toBe(3);
  });

  it("annonce la période servie et s'il reste des pages", async () => {
    const { controller } = controleur();
    const reponse = await controller.list(requete(null), { from: "2026-08-01", to: "2026-08-31" });
    expect(reponse.meta).toEqual({ from: "2026-08-01", to: "2026-08-31", page: 1, hasMore: false });
  });
});
