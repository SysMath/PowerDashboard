import { describe, expect, it, vi } from "vitest";
import { closeSessions } from "./close-sessions";

describe("closeSessions", () => {
  it("demande à Wings de couper chaque compte sur ce seul serveur, une fois par compte", async () => {
    const wings = { deauthorizeUser: vi.fn(async () => undefined) };
    const logger = { warn: vi.fn() };

    const restes = await closeSessions(wings, "srv", ["a", "b", "a"], logger, "Essai");

    expect(restes).toEqual([]);
    expect(wings.deauthorizeUser.mock.calls).toEqual([
      ["srv", "a"],
      ["srv", "b"],
    ]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("rend les comptes que le node n'a pas coupés, sans lever, et le dit au journal", async () => {
    const wings = {
      deauthorizeUser: vi.fn(async (_serverId: string, userId: string) => {
        if (userId === "b") throw new Error("node injoignable");
      }),
    };
    const logger = { warn: vi.fn() };

    const restes = await closeSessions(wings, "srv", ["a", "b"], logger, "Suspension");

    expect(restes).toEqual(["b"]);
    expect(logger.warn).toHaveBeenCalledWith(
      "Suspension de srv : les sessions de b n'ont pas pu être fermées (node injoignable).",
    );
  });

  it("lance les appels ensemble : un node muet ne fait pas attendre son délai une fois par compte", async () => {
    let lances = 0;
    let liberer: () => void = () => undefined;
    const barriere = new Promise<void>((resolve) => {
      liberer = resolve;
    });
    const wings = {
      deauthorizeUser: vi.fn(async () => {
        lances++;
        await barriere;
      }),
    };

    const fin = closeSessions(wings, "srv", ["a", "b", "c"], { warn: vi.fn() }, "Essai");
    await Promise.resolve();
    // Les trois appels sont partis avant qu'aucun n'ait répondu.
    expect(lances).toBe(3);
    liberer();
    await expect(fin).resolves.toEqual([]);
  });

  it("n'appelle rien sans compte : une liste vide ne part jamais chez Wings", async () => {
    const wings = { deauthorizeUser: vi.fn(async () => undefined) };
    expect(await closeSessions(wings, "srv", [], { warn: vi.fn() }, "Essai")).toEqual([]);
    expect(wings.deauthorizeUser).not.toHaveBeenCalled();
  });
});
