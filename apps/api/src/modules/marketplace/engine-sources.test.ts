import { afterEach, describe, expect, it, vi } from "vitest";
import { EngineSourcesService } from "./engine-sources";

/**
 * Seuls les projets PaperMC du catalogue sont demandés à PaperMC.
 *
 * `optionId` vient de la requête : « paper:../../x » partait tel quel dans le
 * chemin de l'adresse (alerte CodeQL « request forgery »).
 */
afterEach(() => {
  vi.restoreAllMocks();
});

describe("options PaperMC", () => {
  it("n'interroge pas PaperMC pour un projet hors du catalogue", async () => {
    const appel = vi.spyOn(globalThis, "fetch");
    const sources = new EngineSourcesService();

    await expect(sources.resolve("paper:../../x", "1.21.1")).resolves.toBe(null);
    await expect(sources.versionsOf("paper:../../x")).resolves.toEqual([]);
    expect(appel).not.toHaveBeenCalled();
  });

  it("interroge PaperMC pour un projet du catalogue", async () => {
    const appel = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ versions: { "1.21": ["1.21.1"] } })));
    const sources = new EngineSourcesService();

    await sources.versionsOf("paper:folia");
    expect(String(appel.mock.calls[0]?.[0])).toBe("https://fill.papermc.io/v3/projects/folia");
  });
});
