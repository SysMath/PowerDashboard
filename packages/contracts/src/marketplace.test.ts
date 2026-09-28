import { describe, expect, it } from "vitest";
import {
  addonState,
  chooseRelease,
  compatibleReleases,
  GAME_SOURCES,
  gameVersionFromPing,
  hasCatalogue,
  type InstalledAddon,
  isInstallable,
  isReleaseCompatible,
  latestCompatibleRelease,
  type MarketplaceProject,
  type ProjectRelease,
  type ServerRuntime,
} from "./marketplace";

let publishTick = 0;

/** Chaque publication créée est plus récente que la précédente. */
const release = (
  version: string,
  gameVersions: string[],
  loaders: ProjectRelease["loaders"],
  publishedAt?: string,
): ProjectRelease => ({
  version,
  gameVersions,
  loaders,
  publishedAt:
    publishedAt ?? new Date(Date.UTC(2026, 0, 1) + publishTick++ * 86_400_000).toISOString(),
  downloadUrl: "https://example.test/fichier.jar",
  fileName: `${version}.jar`,
});

/** Publication dont l'auteur refuse la distribution par un tiers. */
const blockedRelease = (
  version: string,
  gameVersions: string[],
  loaders: ProjectRelease["loaders"],
): ProjectRelease => ({ ...release(version, gameVersions, loaders), downloadUrl: null });

const project = (releases: ProjectRelease[]): MarketplaceProject => ({
  id: "p1",
  source: "modrinth",
  name: "Projet",
  summary: "",
  author: "",
  downloads: 0,
  categories: [],
  releases,
});

const paper: ServerRuntime = { game: "minecraft", loader: "paper", gameVersion: "1.21.4" };
const fabric: ServerRuntime = { game: "minecraft", loader: "fabric", gameVersion: "1.21.4" };
/** Rust n'épingle pas de version : les plugins Oxide suivent les forcées. */
const rust: ServerRuntime = { game: "rust", loader: "oxide", gameVersion: "" };

describe("isReleaseCompatible", () => {
  it("accepte une publication visant le chargeur et la version du serveur", () => {
    expect(isReleaseCompatible(release("1.0.0", ["1.21.4"], ["paper"]), paper)).toBe(true);
  });

  it("refuse une version de jeu différente, même avec le bon chargeur", () => {
    expect(isReleaseCompatible(release("1.0.0", ["1.20.6"], ["paper"]), paper)).toBe(false);
  });

  it("refuse un chargeur différent, même avec la bonne version de jeu", () => {
    expect(isReleaseCompatible(release("1.0.0", ["1.21.4"], ["fabric"]), paper)).toBe(false);
  });

  it("accepte un plugin Spigot sur Paper, qui en est un dérivé", () => {
    expect(isReleaseCompatible(release("1.0.0", ["1.21.4"], ["spigot"]), paper)).toBe(true);
  });

  it("n'accepte pas l'inverse : un plugin Paper ne tourne pas sur Spigot", () => {
    const spigot: ServerRuntime = { game: "minecraft", loader: "spigot", gameVersion: "1.21.4" };
    expect(isReleaseCompatible(release("1.0.0", ["1.21.4"], ["paper"]), spigot)).toBe(false);
  });

  it("accepte un projet indépendant du chargeur", () => {
    expect(isReleaseCompatible(release("1.0.0", ["1.21.4"], ["any"]), fabric)).toBe(true);
  });

  it("ignore la version de jeu quand le runtime n'en épingle aucune", () => {
    // Rust force une mise à jour mensuelle : exiger une correspondance exacte
    // rendrait tout le catalogue incompatible dès le lendemain d'un patch.
    expect(isReleaseCompatible(release("1.0.0", ["2024.11"], ["oxide"]), rust)).toBe(true);
  });

  it("exige quand même le bon chargeur sans version épinglée", () => {
    expect(isReleaseCompatible(release("1.0.0", ["2024.11"], ["carbon"]), rust)).toBe(false);
  });
});

describe("isInstallable", () => {
  it("accepte une publication pourvue d'une URL", () => {
    expect(isInstallable(release("1.0.0", ["1.21.4"], ["paper"]))).toBe(true);
  });

  it("refuse une publication sans URL", () => {
    expect(isInstallable(blockedRelease("1.0.0", ["1.21.4"], ["paper"]))).toBe(false);
  });
});

describe("hasCatalogue", () => {
  it("reconnaît les jeux dotés d'un catalogue public", () => {
    expect(hasCatalogue("minecraft")).toBe(true);
    expect(hasCatalogue("rust")).toBe(true);
  });

  it("signale l'absence de catalogue plutôt que de renvoyer du vide", () => {
    // FiveM distribue ses ressources hors de tout registre : l'interface doit
    // l'expliquer au lieu d'afficher une liste vide sans raison apparente.
    expect(hasCatalogue("fivem")).toBe(false);
    expect(GAME_SOURCES.fivem).toEqual([]);
  });
});

describe("latestCompatibleRelease", () => {
  it("retient la publication la plus récente parmi les compatibles", () => {
    const p = project([
      release("1.0.0", ["1.21.4"], ["paper"], "2026-01-01T00:00:00.000Z"),
      release("1.2.0", ["1.21.4"], ["paper"], "2026-03-01T00:00:00.000Z"),
      release("1.1.0", ["1.21.4"], ["paper"], "2026-02-01T00:00:00.000Z"),
    ]);
    expect(latestCompatibleRelease(p, paper)?.version).toBe("1.2.0");
  });

  it("ordonne par date et non par chaîne, pour les noms de fichier CurseForge", () => {
    // Ces noms portent d'abord la version du jeu : toute comparaison
    // numérique de la chaîne conclurait à l'inverse de la réalité.
    const p = project([
      release("jei-1.21.4-forge-19.0.0.jar", ["1.21.4"], ["forge"], "2026-05-01T00:00:00.000Z"),
      release("jei-1.21.4-forge-18.0.0.jar", ["1.21.4"], ["forge"], "2026-01-01T00:00:00.000Z"),
    ]);
    const runtime: ServerRuntime = { game: "minecraft", loader: "forge", gameVersion: "1.21.4" };
    expect(latestCompatibleRelease(p, runtime)?.version).toBe("jei-1.21.4-forge-19.0.0.jar");
  });

  it("ignore une publication plus récente mais incompatible", () => {
    const p = project([
      release("1.0.0", ["1.21.4"], ["paper"], "2026-01-01T00:00:00.000Z"),
      release("2.0.0", ["1.22.0"], ["paper"], "2026-06-01T00:00:00.000Z"),
    ]);
    expect(latestCompatibleRelease(p, paper)?.version).toBe("1.0.0");
  });

  it("renvoie null quand rien ne convient", () => {
    expect(latestCompatibleRelease(project([release("1.0.0", ["1.20.6"], ["paper"])]), paper)).toBe(
      null,
    );
  });
});

describe("addonState", () => {
  const installedAs = (version: string): InstalledAddon => ({
    projectId: "p1",
    version,
    installedAt: "2026-09-01T00:00:00.000Z",
    fileName: "projet.jar",
  });

  it("propose l'installation d'un projet compatible non installé", () => {
    const state = addonState(project([release("1.0.0", ["1.21.4"], ["paper"])]), paper, undefined);
    expect(state.kind).toBe("installable");
  });

  it("distingue un téléchargement interdit d'une simple incompatibilité", () => {
    // CurseForge renvoie une URL vide quand l'auteur refuse la distribution
    // par un tiers. Proposer « Installer » mènerait à un échec systématique.
    const p = project([blockedRelease("1.0.0", ["1.21.4"], ["paper"])]);
    expect(addonState(p, paper, undefined).kind).toBe("download-blocked");
  });

  it("propose l'installation dès qu'une URL est disponible", () => {
    const p = project([release("1.0.0", ["1.21.4"], ["paper"])]);
    expect(addonState(p, paper, undefined).kind).toBe("installable");
  });

  it("marque incompatible un projet non installé qui ne convient pas", () => {
    expect(
      addonState(project([release("1.0.0", ["1.20.6"], ["paper"])]), paper, undefined),
    ).toEqual({ kind: "incompatible" });
  });

  it("signale une mise à jour quand une version supérieure est compatible", () => {
    const p = project([
      release("1.0.0", ["1.21.4"], ["paper"], "2026-01-01T00:00:00.000Z"),
      release("1.3.0", ["1.21.4"], ["paper"], "2026-04-01T00:00:00.000Z"),
    ]);
    const state = addonState(p, paper, installedAs("1.0.0"));
    expect(state).toMatchObject({ kind: "update-available", installed: "1.0.0" });
  });

  it("reconnaît une publication identique même si son nom n'est pas une version", () => {
    const name = "jei-1.21.4-forge-19.0.0.jar";
    const p = project([release(name, ["1.21.4"], ["forge"])]);
    const runtime: ServerRuntime = { game: "minecraft", loader: "forge", gameVersion: "1.21.4" };
    expect(addonState(p, runtime, installedAs(name))).toEqual({
      kind: "up-to-date",
      installed: name,
    });
  });

  it("ne signale rien quand la version installée est déjà la plus récente", () => {
    const p = project([release("1.3.0", ["1.21.4"], ["paper"])]);
    expect(addonState(p, paper, installedAs("1.3.0"))).toEqual({
      kind: "up-to-date",
      installed: "1.3.0",
    });
  });

  it("ne propose pas de rétrograder vers une version antérieure", () => {
    const p = project([release("1.0.0", ["1.21.4"], ["paper"])]);
    expect(addonState(p, paper, installedAs("1.3.0")).kind).toBe("up-to-date");
  });

  it("distingue un projet installé devenu incompatible d'un simple incompatible", () => {
    // Cas réel : le serveur monte de 1.21.4 à 1.22 et le plugin ne suit pas.
    // Il reste présent dans le conteneur, il faut le signaler plutôt que
    // de le faire disparaître de la liste.
    const p = project([release("1.0.0", ["1.21.4"], ["paper"])]);
    const upgraded: ServerRuntime = { game: "minecraft", loader: "paper", gameVersion: "1.22" };
    expect(addonState(p, upgraded, installedAs("1.0.0"))).toEqual({
      kind: "installed-incompatible",
      installed: "1.0.0",
    });
  });
});

describe("compatibleReleases", () => {
  it("rend les publications compatibles et téléchargeables, la plus récente d'abord", () => {
    const p = project([
      release("1.0.0", ["1.21.4"], ["paper"], "2026-01-01T00:00:00.000Z"),
      release("2.0.0", ["1.21.4"], ["paper"], "2026-03-01T00:00:00.000Z"),
      release("1.5.0", ["1.20.6"], ["paper"], "2026-02-01T00:00:00.000Z"),
      blockedRelease("2.1.0", ["1.21.4"], ["paper"]),
    ]);
    expect(compatibleReleases(p, paper).map((r) => r.version)).toEqual(["2.0.0", "1.0.0"]);
  });
});

describe("chooseRelease", () => {
  const installedAs = (version: string): InstalledAddon => ({
    projectId: "p1",
    version,
    installedAt: "2026-09-01T00:00:00.000Z",
    fileName: `${version}.jar`,
  });
  const historique = () =>
    project([
      release("1.0.0", ["1.21.4"], ["paper"], "2026-01-01T00:00:00.000Z"),
      release("1.3.0", ["1.21.4"], ["paper"], "2026-04-01T00:00:00.000Z"),
      release("0.9.0", ["1.20.6"], ["paper"], "2025-12-01T00:00:00.000Z"),
    ]);

  it("sans version, prend la plus récente compatible, comme avant", () => {
    const choice = chooseRelease(historique(), paper, undefined);
    expect(choice).toMatchObject({ kind: "ok", release: { version: "1.3.0" } });
  });

  it("sans version, ne rétrograde jamais", () => {
    expect(chooseRelease(historique(), paper, installedAs("1.3.0"))).toEqual({
      kind: "refused",
      reason: "up-to-date",
    });
  });

  it("avec une version, installe exactement celle-là", () => {
    const choice = chooseRelease(historique(), paper, undefined, "1.0.0");
    expect(choice).toMatchObject({ kind: "ok", release: { version: "1.0.0" } });
  });

  it("avec une version antérieure, permet de revenir en arrière", () => {
    // Usage principal du choix : une mise à jour a cassé le serveur.
    const choice = chooseRelease(historique(), paper, installedAs("1.3.0"), "1.0.0");
    expect(choice).toMatchObject({ kind: "ok", release: { version: "1.0.0" } });
  });

  it("refuse la version déjà installée", () => {
    expect(chooseRelease(historique(), paper, installedAs("1.0.0"), "1.0.0")).toEqual({
      kind: "refused",
      reason: "up-to-date",
    });
  });

  it("refuse une version incompatible, même demandée explicitement", () => {
    // Le choix porte sur la version, pas sur la compatibilité : 0.9.0 vise
    // 1.20.6 et ne démarrerait pas sur un serveur en 1.21.4.
    expect(chooseRelease(historique(), paper, undefined, "0.9.0")).toEqual({
      kind: "refused",
      reason: "unknown-version",
    });
  });

  it("refuse une version inconnue du catalogue", () => {
    expect(chooseRelease(historique(), paper, undefined, "9.9.9")).toEqual({
      kind: "refused",
      reason: "unknown-version",
    });
  });

  it("refuse une version dont l'auteur interdit le téléchargement", () => {
    const p = project([blockedRelease("1.0.0", ["1.21.4"], ["paper"])]);
    expect(chooseRelease(p, paper, undefined, "1.0.0")).toEqual({
      kind: "refused",
      reason: "download-blocked",
    });
  });
});

describe("gameVersionFromPing", () => {
  it("lit une longue suite de chiffres en temps linéaire", () => {
    // Le texte vient du serveur de jeu : 50 000 « 0 » prenaient 3 s à l'ancienne regex.
    const debut = performance.now();
    expect(gameVersionFromPing("0".repeat(200_000))).toBe("");
    expect(gameVersionFromPing(`${"0".repeat(200_000)}.5`)).toBe(`${"0".repeat(200_000)}.5`);
    expect(performance.now() - debut).toBeLessThan(500);
  });

  it("lit une version nue", () => {
    expect(gameVersionFromPing("1.21.1")).toBe("1.21.1");
  });

  it("lit une version précédée du nom du logiciel", () => {
    expect(gameVersionFromPing("Paper 1.21.1")).toBe("1.21.1");
    expect(gameVersionFromPing("Waterfall 1.20")).toBe("1.20");
    expect(gameVersionFromPing("CraftBukkit 1.16.5")).toBe("1.16.5");
  });

  /**
   * Un serveur qui accepte une plage annonce ses deux bornes.
   *
   * La plus ancienne est retenue : une extension compatible avec elle l'est
   * presque toujours avec la suivante, l'inverse étant faux. Choisir la plus
   * récente écarterait des extensions qui fonctionnent.
   */
  it("retient la borne basse d'une plage", () => {
    expect(gameVersionFromPing("1.20.4-1.21")).toBe("1.20.4");
  });

  /** Rien de reconnaissable : on ne filtre pas, plutôt que de filtrer à tort. */
  it("rend vide quand rien ne ressemble à une version", () => {
    expect(gameVersionFromPing("Un serveur de jeu")).toBe("");
    expect(gameVersionFromPing("")).toBe("");
    expect(gameVersionFromPing(null)).toBe("");
    expect(gameVersionFromPing(undefined)).toBe("");
  });

  /** Un numéro à un seul segment n'est pas une version de Minecraft. */
  it("ignore un nombre isolé", () => {
    expect(gameVersionFromPing("Serveur 42")).toBe("");
  });
});
