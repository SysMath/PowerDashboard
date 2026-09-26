import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Un dépôt d'eggs injoignable ne fait plus tomber l'écran des eggs.
 *
 * Le catalogue se lit chez GitHub. Une limite d'appels anonymes atteinte
 * (constatée depuis une session distante) remplaçait tout l'écran par « Une
 * erreur est survenue » : plus moyen de gérer les eggs locaux, qui ne
 * dépendent pas du dépôt.
 *
 * La page est rendue ici avec la vraie chaîne de lecture (`fetchAdminEggs`,
 * `readEggCatalogue`, `unwrap`) : seul l'appel HTTP à l'API est simulé.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/page-title", () => ({ pageTitle: () => async () => ({}) }));

const reponses = new Map<string, () => unknown>();
vi.mock("./client", async (original) => {
  const reel = await original<typeof import("./client")>();
  return {
    ...reel,
    apiFetch: vi.fn(async (path: string) => {
      const reponse = reponses.get(path);
      if (!reponse) throw new Error(`appel inattendu : ${path}`);
      return reponse();
    }),
  };
});

const { ApiError } = await import("./client");
const { readEggCatalogue } = await import("./admin");
const { default: AdminEggsPage } = await import("@/app/(admin)/admin/eggs/page");

const REFUS_GITHUB =
  "GitHub a refusé la requête : la limite d'appels anonymes est atteinte. Réessayez dans une heure.";
const SOURCE = {
  id: "s",
  name: "pterodactyl/game-eggs",
  url: "https://github.com/pterodactyl/game-eggs",
  branch: "main",
};
const ENTREES = [
  { path: "a/egg-a.json", name: "A", group: "a", installedId: null, enabled: false },
];
const EGGS_LOCAUX = [{ id: "e1", name: "Minecraft Java", nest: "Minecraft" }];

const refuse = (erreur: Error) => () => {
  throw erreur;
};

describe("écran des eggs", () => {
  beforeEach(() => {
    reponses.clear();
    reponses.set("/api/v1/admin/eggs", () => ({ data: EGGS_LOCAUX }));
  });

  it("se rend avec les eggs locaux quand le dépôt refuse (tombait sur main)", async () => {
    reponses.set("/api/v1/admin/egg-catalogue", refuse(new ApiError(REFUS_GITHUB, 503)));
    const rendu = (await AdminEggsPage()) as { props: Record<string, unknown> };

    expect(rendu.props.initial).toEqual(EGGS_LOCAUX);
    expect(rendu.props.source).toBeNull();
    expect(rendu.props.entries).toEqual([]);
    expect(rendu.props.catalogueError).toEqual({ reason: REFUS_GITHUB });
  });

  it("dit que la liste est gardée en mémoire quand l'API sert un arbre vieilli", async () => {
    reponses.set("/api/v1/admin/egg-catalogue", () => ({
      data: { source: SOURCE, entries: ENTREES, readAt: "2026-09-26T10:00:00.000Z", stale: true },
    }));
    const rendu = (await AdminEggsPage()) as { props: Record<string, unknown> };

    expect(rendu.props.entries).toEqual(ENTREES);
    expect(rendu.props.catalogueError).toBeNull();
    expect(rendu.props.catalogueStaleSince).toBe("2026-09-26T10:00:00.000Z");
  });
});

describe("readEggCatalogue", () => {
  it("rend le catalogue tel quel quand le dépôt répond", async () => {
    const lu = {
      source: SOURCE,
      entries: ENTREES,
      readAt: "2026-09-26T10:00:00.000Z",
      stale: false,
    };
    await expect(readEggCatalogue(async () => lu)).resolves.toEqual({
      source: SOURCE,
      entries: ENTREES,
      staleSince: null,
      error: null,
    });
  });

  it("ne montre ni « Internal server error » ni l'adresse interne de l'API", async () => {
    const muette = await readEggCatalogue(
      refuse(new ApiError("Internal server error", 500)) as never,
    );
    expect(muette.error).toEqual({ reason: null });

    const echeance = await readEggCatalogue(
      refuse(
        new ApiError("L'API n'a pas répondu en moins de 10 s sur http://127.0.0.1:3201.", 0, {
          kind: "timeout",
        }),
      ) as never,
    );
    expect(echeance.error).toEqual({ reason: null });
  });

  it("laisse passer ce qui n'est pas un refus de l'API, dont le « page introuvable »", async () => {
    await expect(readEggCatalogue(refuse(new Error("NEXT_NOT_FOUND")) as never)).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
  });
});
