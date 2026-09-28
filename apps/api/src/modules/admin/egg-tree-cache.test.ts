import { describe, expect, it, vi } from "vitest";
import { EggTreeCache } from "./egg-tree-cache";

/**
 * L'arbre d'un dépôt d'eggs ménage la limite anonyme de GitHub (soixante
 * appels par heure), survit à une panne passagère et ne fait pas attendre
 * l'écran quand GitHub se tait.
 */

const TTL = 15 * 60_000;
const MAX_VIEUX = 24 * 60 * 60_000;
const RETENUE = 2 * 60_000;

class Passagere extends Error {}
const passagere = () => Promise.reject(new Passagere("GitHub a refusé la requête"));

function cache() {
  let t = 1_000_000;
  const arbres = new EggTreeCache({
    ttlMs: TTL,
    maxStaleMs: MAX_VIEUX,
    failureHoldMs: RETENUE,
    transient: (error) => error instanceof Passagere,
    now: () => t,
  });
  return { arbres, avancer: (ms: number) => (t += ms), maintenant: () => t };
}

describe("EggTreeCache", () => {
  it("ne relit pas le dépôt tant que l'arbre est frais", async () => {
    const { arbres, avancer } = cache();
    const lire = vi.fn(async () => ["a.json"]);

    await arbres.read("depot@main", lire);
    avancer(TTL - 1);
    await expect(arbres.read("depot@main", lire)).resolves.toMatchObject({
      paths: ["a.json"],
      stale: false,
    });
    expect(lire).toHaveBeenCalledOnce();
  });

  it("relit un arbre vieilli", async () => {
    const { arbres, avancer } = cache();
    await arbres.read("depot@main", async () => ["a.json"]);
    avancer(TTL);
    await expect(arbres.read("depot@main", async () => ["b.json"])).resolves.toMatchObject({
      paths: ["b.json"],
      stale: false,
    });
  });

  it("sert l'arbre vieilli, daté, après une panne passagère", async () => {
    const { arbres, avancer, maintenant } = cache();
    const lu = maintenant();
    await arbres.read("depot@main", async () => ["a.json"]);
    avancer(TTL * 4);
    await expect(arbres.read("depot@main", passagere)).resolves.toEqual({
      paths: ["a.json"],
      at: lu,
      stale: true,
    });
  });

  it("retient l'échec : les lectures suivantes ne retentent pas GitHub", async () => {
    const { arbres, avancer } = cache();
    const lire = vi.fn(passagere);

    await expect(arbres.read("depot@main", lire)).rejects.toThrow(Passagere);
    avancer(RETENUE - 1);
    await expect(arbres.read("depot@main", lire)).rejects.toThrow(Passagere);
    expect(lire).toHaveBeenCalledOnce();

    avancer(1);
    await expect(arbres.read("depot@main", async () => ["a.json"])).resolves.toMatchObject({
      paths: ["a.json"],
    });
  });

  it("ne se replie pas sur une erreur qui n'est pas passagère (dépôt introuvable)", async () => {
    const { arbres, avancer } = cache();
    await arbres.read("depot@main", async () => ["a.json"]);
    avancer(TTL);
    await expect(
      arbres.read("depot@main", () => Promise.reject(new Error("Dépôt ou branche introuvable."))),
    ).rejects.toThrow("introuvable");
  });

  it("ne sert plus un arbre plus vieux qu'un jour", async () => {
    const { arbres, avancer } = cache();
    await arbres.read("depot@main", async () => ["a.json"]);
    avancer(MAX_VIEUX);
    await expect(arbres.read("depot@main", passagere)).rejects.toThrow(Passagere);
  });

  it("prend l'arbre déposé par une synchronisation, sans relire, et oublie l'échec", async () => {
    const { arbres, avancer } = cache();
    await expect(arbres.read("depot@main", passagere)).rejects.toThrow(Passagere);
    arbres.store("depot@main", ["a.json", "b.json"]);
    avancer(TTL - 1);
    const lire = vi.fn(async () => ["c.json"]);
    await expect(arbres.read("depot@main", lire)).resolves.toMatchObject({
      paths: ["a.json", "b.json"],
      stale: false,
    });
    expect(lire).not.toHaveBeenCalled();
  });
});
