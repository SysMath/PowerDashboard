import { randomUUID } from "node:crypto";
import { type Database, eggSources } from "@gamedashboard/db";
import { BadRequestException } from "@nestjs/common";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createThrowawayDatabase,
  HAS_DATABASE,
  NO_DATABASE_REASON,
  type ThrowawayDatabase,
} from "../../test/throwaway-database";
import { EggImportService, GitHubUnavailableException } from "./egg-import.service";

/**
 * Le catalogue du dépôt d'eggs face à un GitHub qui refuse ou se tait, contre
 * une vraie base ; seul `fetch` est simulé.
 *
 * Le câblage, et non la seule brique `EggTreeCache` : si `treeOf` contournait
 * le cache, ou si la synchronisation cessait d'y déposer l'arbre lu, ces tests
 * tomberaient.
 */

const QUART_D_HEURE = 15 * 60_000;

/** Un GitHub simulé : l'arbre à rendre, ou la panne à jouer. */
function github(arbre: () => Response | Promise<Response>) {
  const appels: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      appels.push(url);
      if (url.includes("/git/trees/")) return arbre();
      return Response.json({});
    }),
  );
  return appels;
}

const arbreDe = (...chemins: string[]) =>
  Response.json({
    sha: "0".repeat(40),
    tree: chemins.map((path) => ({ path, type: "blob", size: 100 })),
  });

/** Un `fetch` qui ne répond jamais : seule l'échéance de l'appelant l'arrête. */
function muet(_url: string, init?: RequestInit): Promise<Response> {
  return new Promise((_, rejeter) => {
    init?.signal?.addEventListener("abort", () => rejeter(init.signal?.reason));
  });
}

describe.skipIf(!HAS_DATABASE)("catalogue du dépôt d'eggs (intégration)", () => {
  let throwaway: ThrowawayDatabase;
  let db: Database;
  let service: EggImportService;

  beforeAll(async () => {
    throwaway = await createThrowawayDatabase();
    db = throwaway.db;
    service = new EggImportService(db);
  }, 60_000);

  afterAll(async () => {
    await throwaway?.drop();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** Une source propre au test : le cache est partagé par tout le processus. */
  async function source(): Promise<string> {
    const [ligne] = await db
      .insert(eggSources)
      .values({
        name: "essai",
        type: "git",
        url: `https://github.com/essai-${randomUUID()}/eggs`,
        branch: "main",
      })
      .returning({ id: eggSources.id });
    if (!ligne) throw new Error("source non créée");
    return ligne.id;
  }

  it("ne relit pas GitHub à chaque ouverture de l'écran", async () => {
    const id = await source();
    const appels = github(() => arbreDe("jeux/a.json"));

    await service.catalogue(id);
    const second = await service.catalogue(id);

    expect(second.entries.map((e) => e.path)).toEqual(["jeux/a.json"]);
    expect(second.stale).toBe(false);
    expect(appels).toHaveLength(1);
  });

  it("sert l'arbre vieilli, daté, quand GitHub refuse", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const id = await source();
    github(() => arbreDe("jeux/a.json"));
    const premier = await service.catalogue(id);

    vi.setSystemTime(Date.now() + QUART_D_HEURE + 1);
    github(() => new Response("{}", { status: 403 }));
    const repli = await service.catalogue(id);

    expect(repli.stale).toBe(true);
    expect(repli.readAt).toBe(premier.readAt);
    expect(repli.entries.map((e) => e.path)).toEqual(["jeux/a.json"]);
  });

  it("GitHub muet : phrase en français, puis réponses immédiates sans le relancer", async () => {
    const id = await source();
    const appels = github(() => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });

    const echec = await service.catalogue(id).catch((error: unknown) => error);
    expect(echec).toBeInstanceOf(GitHubUnavailableException);
    expect((echec as Error).message).toBe("GitHub n'a pas répondu en moins de 5 s.");

    await expect(service.catalogue(id)).rejects.toBeInstanceOf(GitHubUnavailableException);
    expect(appels).toHaveLength(1);
  });

  it("une synchronisation relit GitHub et dépose l'arbre qu'elle a lu", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const id = await source();
    github(() => arbreDe("jeux/a.json"));
    await service.catalogue(id);

    // Le cache est encore frais : la synchronisation passe outre.
    vi.setSystemTime(Date.now() + QUART_D_HEURE - 1_000);
    const appelsSync = github(() => arbreDe("jeux/a.json", "jeux/b.json"));
    await service.syncSource(id);
    expect(appelsSync.some((url) => url.includes("/git/trees/"))).toBe(true);

    // L'arbre du premier affichage aurait expiré ; celui de la synchronisation non.
    vi.setSystemTime(Date.now() + 2_000);
    const appels = github(() => new Response("{}", { status: 403 }));
    const apres = await service.catalogue(id);

    expect(apres.entries.map((e) => e.path)).toEqual(["jeux/a.json", "jeux/b.json"]);
    expect(apres.stale).toBe(false);
    expect(appels).toHaveLength(0);
  });

  // Une sortie qui refuse (et non qui se tait) : `fetch` rejette une
  // TypeError. Laissée brute, elle remontait en 500 et n'était pas passagère :
  // plus d'arbre vieilli.
  it("un « fetch failed » est une panne passagère : l'arbre vieilli sert", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const id = await source();
    github(() => arbreDe("jeux/a.json"));
    await service.catalogue(id);

    vi.setSystemTime(Date.now() + QUART_D_HEURE + 1);
    github(() => {
      throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
    });
    const repli = await service.catalogue(id);
    expect(repli.stale).toBe(true);
    expect(repli.entries.map((e) => e.path)).toEqual(["jeux/a.json"]);

    await expect(service.syncSource(id)).rejects.toBeInstanceOf(GitHubUnavailableException);
  });

  // Un 404 dit que la branche ou le dépôt n'existe plus : l'arbre gardé ne
  // décrit plus rien d'importable.
  it("un 404 n'est pas passager : pas de repli sur l'arbre gardé", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const id = await source();
    github(() => arbreDe("jeux/a.json"));
    await service.catalogue(id);

    vi.setSystemTime(Date.now() + QUART_D_HEURE + 1);
    github(() => new Response("{}", { status: 404 }));
    await expect(service.catalogue(id)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("« Ajouter » depuis la liste n'attend pas GitHub plus longtemps que l'arbre", async () => {
    const id = await source();
    github(() => arbreDe("jeux/a.json"));
    await service.catalogue(id);

    vi.stubGlobal("fetch", vi.fn(muet));
    const debut = Date.now();
    const echec = await service.importFromSource(id, "jeux/a.json").catch((e: unknown) => e);
    expect(echec).toBeInstanceOf(GitHubUnavailableException);
    expect((echec as Error).message).toBe("GitHub n'a pas répondu en moins de 5 s.");
    expect(Date.now() - debut).toBeLessThan(7_000);
  }, 15_000);
});

describe.skipIf(!HAS_DATABASE)("source par défaut (intégration)", () => {
  let throwaway: ThrowawayDatabase;
  let db: Database;
  let service: EggImportService;

  beforeAll(async () => {
    throwaway = await createThrowawayDatabase();
    db = throwaway.db;
    service = new EggImportService(db);
  }, 60_000);

  afterAll(async () => {
    await throwaway?.drop();
  });

  beforeEach(async () => {
    await db.delete(eggSources);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Next abandonne l'API à 10 s et l'écran se rouvre : la requête abandonnée
  // et la suivante créaient chacune leur source.
  it("n'en crée qu'une sous des ouvertures simultanées", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await new Promise((fin) => setTimeout(fin, 200));
        return Response.json({ default_branch: "main" });
      }),
    );

    const sources = await Promise.all([
      service.defaultSource(),
      service.defaultSource(),
      service.defaultSource(),
    ]);

    expect(new Set(sources.map((s) => s.id)).size).toBe(1);
    expect(await db.select().from(eggSources)).toHaveLength(1);
  });

  it("GitHub muet : la branche ne retient la première ouverture que 3 s", async () => {
    vi.stubGlobal("fetch", vi.fn(muet));
    const debut = Date.now();
    const source = await service.defaultSource();

    expect(Date.now() - debut).toBeLessThan(4_500);
    expect(source).toMatchObject({
      name: "Pterodactyl game-eggs",
      url: "https://github.com/pterodactyl/game-eggs",
      branch: "main",
    });
  }, 15_000);
});

if (!HAS_DATABASE) console.warn(NO_DATABASE_REASON);
