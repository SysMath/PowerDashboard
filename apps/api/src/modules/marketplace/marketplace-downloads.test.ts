import type {
  MarketplaceProject,
  MarketplaceSource,
  ProjectRelease,
} from "@gamedashboard/contracts";
import type { Database } from "@gamedashboard/db";
import { BadGatewayException, ConflictException, NotFoundException } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WingsClientService } from "../wings/wings-client.service";
import type { CurseForgeClient } from "./curseforge.client";
import type { CurseForgePackService } from "./curseforge-pack";
import { EngineService } from "./engine.service";
import { EditorHttpError, EngineSourcesService, isTrustedEngineDownload } from "./engine-sources";
import type { EulaService } from "./eula.service";
import type { ForgeInstallService } from "./forge-install.service";
import { MarketplaceService } from "./marketplace.service";
import type { ModpackSourceService } from "./modpack-source";
import type { ModrinthClient } from "./modrinth.client";
import { PackInstallerService } from "./pack-installer.service";
import type { DetectedRuntime } from "./server-runtime";
import type { SpigetClient } from "./spiget.client";

/**
 * Adresses de téléchargement rendues par Modrinth et CurseForge (NC-47).
 *
 * Le panel les transmettait au daemon telles quelles : Wings télécharge sans
 * regarder, depuis le réseau du node. Une réponse falsifiée — ou un projet
 * piégé — faisait de lui un relais vers `169.254.169.254` ou le réseau
 * d'administration. Seul l'index d'un `.mrpack` passait par la liste d'hôtes
 * de `modpack-source.ts` ; l'extension et l'archive du pack, non.
 */

const SERVER = "22222222-2222-4222-8222-222222222222";
const METADONNEES = "http://169.254.169.254/latest/meta-data/";
const RUNTIME: DetectedRuntime = {
  game: "minecraft",
  loader: "paper",
  gameVersion: "1.21.1",
  directory: "/plugins",
};

function wings() {
  return {
    pullFile: vi.fn(async () => {}),
    deleteFiles: vi.fn(async () => {}),
    power: vi.fn(async () => {}),
    decompressFile: vi.fn(async () => {}),
    readFile: vi.fn(async () => ""),
  };
}

function projet(source: MarketplaceSource, downloadUrl: string): MarketplaceProject {
  return {
    id: `${source}:essentials`,
    source,
    name: "Essentials",
    summary: "",
    author: "auteur",
    downloads: 1,
    categories: [],
    releases: [
      {
        version: "2.21.0",
        gameVersions: ["1.21.1"],
        loaders: ["paper"],
        publishedAt: "2026-01-01T00:00:00.000Z",
        downloadUrl,
        fileName: "essentials.jar",
      },
    ],
  };
}

/** Le catalogue d'extensions, sa base simulée : rien d'installé, écriture acceptée. */
function catalogue(found: MarketplaceProject) {
  const daemon = wings();
  const db = {
    select: () => ({ from: () => ({ where: async () => [] }) }),
    insert: () => ({ values: () => ({ onConflictDoUpdate: async () => {} }) }),
  } as unknown as Database;
  const client = { project: vi.fn(async () => found) };
  const svc = new MarketplaceService(
    db,
    daemon as unknown as WingsClientService,
    client as unknown as ModrinthClient,
    client as unknown as CurseForgeClient,
    client as unknown as SpigetClient,
  );
  vi.spyOn(svc as unknown as { runtimeOf: () => unknown }, "runtimeOf").mockResolvedValue(RUNTIME);
  return { svc, daemon };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("extension : adresse rendue par le catalogue", () => {
  it.each(["modrinth", "curseforge"] as const)(
    "%s : refuse une adresse hors des dépôts connus, avant tout appel au daemon",
    async (source) => {
      const { svc, daemon } = catalogue(projet(source, METADONNEES));

      await expect(svc.install(SERVER, `${source}:essentials`)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(daemon.pullFile).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["modrinth", "https://cdn.modrinth.com/data/abc/versions/def/essentials.jar"],
    ["curseforge", "https://edge.forgecdn.net/files/1234/567/essentials.jar"],
  ] as const)("%s : laisse passer son propre dépôt", async (source, url) => {
    const { svc, daemon } = catalogue(projet(source, url));

    await svc.install(SERVER, `${source}:essentials`);
    expect(daemon.pullFile).toHaveBeenCalledWith(SERVER, "/plugins", url, "essentials.jar");
  });

  it("ne touche pas à SpigotMC, dont le panel compose l'adresse lui-même", async () => {
    // `spiget.client.ts` écrit `https://api.spiget.org/v2/resources/<id>/download` :
    // l'adresse ne vient pas d'une réponse, elle n'est pas dans le périmètre.
    const url = "https://api.spiget.org/v2/resources/9089/download";
    const { svc, daemon } = catalogue(projet("spigot", url));

    await svc.install(SERVER, "spigot:essentials");
    expect(daemon.pullFile).toHaveBeenCalledWith(SERVER, "/plugins", url, "essentials.jar");
  });
});

describe("modpack : archive rendue par Modrinth", () => {
  function moteur(archiveUrl: string) {
    const daemon = { ...wings(), listDirectory: vi.fn(async () => []) };
    const db = {
      // La prise de l'état « installation » lit `returning` ; sa levée, non.
      update: () => ({
        set: () => ({
          where: () =>
            Object.assign(Promise.resolve(), { returning: async () => [{ id: SERVER }] }),
        }),
      }),
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    } as unknown as Database;
    const packs = {
      version: vi.fn(async () => ({
        id: "v1",
        projectId: "pack",
        label: "1.0 · 1.21.1",
        gameVersion: "",
        loaders: ["fabric"],
        publishedAt: "2026-01-01T00:00:00Z",
        archive: { url: archiveUrl, fileName: "pack.mrpack" },
      })),
      parseIndex: vi.fn(() => null),
    };
    const installer = new PackInstallerService(
      daemon as unknown as WingsClientService,
      packs as unknown as ModpackSourceService,
      {} as CurseForgePackService,
    );
    const svc = new EngineService(
      db,
      daemon as unknown as WingsClientService,
      {} as EngineSourcesService,
      packs as unknown as ModpackSourceService,
      { reset: vi.fn(async () => false) } as unknown as EulaService,
      installer,
      {} as CurseForgePackService,
      {} as ForgeInstallService,
    );
    vi.spyOn(svc as unknown as { runtimeOf: () => unknown }, "runtimeOf").mockResolvedValue({
      ...RUNTIME,
      loader: "fabric",
      directory: "/mods",
    });
    return { svc, daemon };
  }

  it("refuse une archive hors des dépôts connus, avant tout téléchargement", async () => {
    const { svc, daemon } = moteur(METADONNEES);

    const refus = svc.install(SERVER, "modpack:pack", "v1");
    await expect(refus).rejects.toBeInstanceOf(ConflictException);
    // Le refus nomme l'adresse : un index absent, plus loin, lèverait aussi un
    // conflit, mais après avoir fait télécharger l'archive.
    await expect(refus).rejects.toThrow(/adresse/);
    expect(daemon.pullFile).not.toHaveBeenCalled();
    // Refusé avant l'arrêt : le serveur reste tel qu'on l'a trouvé.
    expect(daemon.power).not.toHaveBeenCalled();
  });

  it("laisse passer l'archive servie par Modrinth, tirée dans le dossier de travail", async () => {
    const url = "https://cdn.modrinth.com/data/abc/versions/v1/pack.mrpack";
    const { svc, daemon } = moteur(url);

    // L'index est illisible ici : l'installation s'arrête plus loin, et ce
    // n'est pas le sujet. Seul compte ce qui a été demandé au daemon.
    await svc.install(SERVER, "modpack:pack", "v1").catch(() => undefined);
    expect(daemon.pullFile).toHaveBeenCalledWith(
      SERVER,
      "/.gamedashboard-pack",
      url,
      "pack.mrpack",
    );
  });
});

describe("extension : version choisie", () => {
  const MODRINTH = "https://cdn.modrinth.com/data/abc/versions";

  function historique(): MarketplaceProject {
    const base = projet("modrinth", `${MODRINTH}/new/essentials-2.jar`);
    const recente = base.releases[0] as ProjectRelease;
    return {
      ...base,
      releases: [
        { ...recente, version: "2.21.0", fileName: "essentials-2.jar" },
        {
          ...recente,
          version: "2.20.0",
          publishedAt: "2025-06-01T00:00:00.000Z",
          downloadUrl: `${MODRINTH}/old/essentials-1.jar`,
          fileName: "essentials-1.jar",
        },
      ],
    };
  }

  it("télécharge la publication demandée, même antérieure à la plus récente", async () => {
    const { svc, daemon } = catalogue(historique());

    const fait = await svc.install(SERVER, "modrinth:essentials", "2.20.0");
    expect(fait).toMatchObject({ version: "2.20.0", fileName: "essentials-1.jar" });
    expect(daemon.pullFile).toHaveBeenCalledWith(
      SERVER,
      "/plugins",
      `${MODRINTH}/old/essentials-1.jar`,
      "essentials-1.jar",
    );
  });

  it("refuse une version absente du catalogue, sans rien demander au daemon", async () => {
    const { svc, daemon } = catalogue(historique());

    await expect(svc.install(SERVER, "modrinth:essentials", "9.9.9")).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(daemon.pullFile).not.toHaveBeenCalled();
  });
});

/**
 * Jar de plateforme (reste de NC-47) : PaperMC et Mojang **rendent** l'adresse
 * du fichier, que le panel transmettait au daemon sans regarder.
 */
describe("plateforme : jar rendu par l'éditeur", () => {
  /**
   * Base simulée : toute lecture se termine sur une liste vide ; une écriture
   * avec `returning` rend une ligne, sauf quand le serveur est dit occupé
   * (la prise de l'état « installation » échoue alors).
   */
  function base(occupe = false): Database {
    const fin = (rows: unknown[]) => ({
      // biome-ignore lint/suspicious/noThenProperty: doublure d'une requête drizzle, attendue par `await`.
      then: (ok: (rows: unknown[]) => unknown) => Promise.resolve(rows).then(ok),
    });
    const chaine: unknown = new Proxy(() => chaine, {
      get: (_cible, cle) => {
        if (cle === "then") return fin([]).then;
        if (cle === "returning") return () => fin(occupe ? [] : [{ id: SERVER }]);
        return () => chaine;
      },
      apply: () => chaine,
    });
    return chaine as Database;
  }

  function moteur(jar: { url: string; fileName: string }, occupe = false) {
    const daemon = {
      ...wings(),
      renameFile: vi.fn(async () => {}),
      resources: vi.fn(async () => ({ state: "running" })),
    };
    const sources = { resolve: vi.fn(async () => jar), labelOf: vi.fn(() => "Paper") };
    const svc = new EngineService(
      base(occupe),
      daemon as unknown as WingsClientService,
      sources as unknown as EngineSourcesService,
      {} as ModpackSourceService,
      { reset: vi.fn(async () => false) } as unknown as EulaService,
      {} as PackInstallerService,
      {} as CurseForgePackService,
      {} as ForgeInstallService,
    );
    vi.spyOn(svc as unknown as { runtimeOf: () => unknown }, "runtimeOf").mockResolvedValue(
      RUNTIME,
    );
    return { svc, daemon, sources };
  }

  it.each([
    ["métadonnées du nuage", { url: METADONNEES, fileName: "paper.jar" }],
    ["hôte inconnu", { url: "https://paper.example.net/paper.jar", fileName: "paper.jar" }],
    [
      "http en clair",
      { url: "http://fill-data.papermc.io/v1/objects/abc/paper.jar", fileName: "paper.jar" },
    ],
    [
      "identifiants dans l'adresse",
      { url: "https://x@fill-data.papermc.io/v1/objects/abc/paper.jar", fileName: "paper.jar" },
    ],
    [
      "port explicite",
      { url: "https://fill-data.papermc.io:8443/v1/objects/abc/p.jar", fileName: "paper.jar" },
    ],
    [
      "nom hors du dossier",
      { url: "https://fill-data.papermc.io/v1/objects/abc/p.jar", fileName: "../eula.txt.jar" },
    ],
  ])("refuse %s, avant d'arrêter le serveur", async (_cas, jar) => {
    const { svc, daemon } = moteur(jar);

    await expect(svc.install(SERVER, "paper:paper", "1.21.1")).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(daemon.pullFile).not.toHaveBeenCalled();
    expect(daemon.power).not.toHaveBeenCalled();
  });

  /*
   * Revue du lot (R7) : tout échec devenait « l'éditeur ne répond pas ». Un
   * 404 dit qu'une version a disparu, une panne qu'il faut réessayer, une
   * réponse étrange qu'on refuse.
   */
  it.each([
    [
      "silence de l'éditeur",
      new DOMException("délai dépassé", "TimeoutError"),
      BadGatewayException,
      /ne répond pas/,
    ],
    [
      "panne de l'éditeur",
      new EditorHttpError("https://fill.papermc.io/v3", 503),
      BadGatewayException,
      /ne répond pas/,
    ],
    [
      "version retirée",
      new EditorHttpError("https://fill.papermc.io/v3", 404),
      NotFoundException,
      /plus proposée/,
    ],
    ["réponse illisible", new SyntaxError("JSON invalide"), BadGatewayException, /inattendue/],
  ])("%s : refus explicite, sans arrêter le serveur", async (_cas, erreur, type, message) => {
    const { svc, daemon, sources } = moteur({ url: "", fileName: "" });
    sources.resolve.mockRejectedValueOnce(erreur);

    const refus = svc.install(SERVER, "paper:paper", "1.21.1");
    await expect(refus).rejects.toBeInstanceOf(type);
    await expect(refus).rejects.toThrow(message);
    expect(daemon.power).not.toHaveBeenCalled();
  });

  // Revue du lot (R6) : une seule échéance pour toute la résolution, sous les
  // 10 s après lesquelles l'interface abandonne.
  it("résout sous une seule échéance, plus courte que celle de l'interface", async () => {
    const url = "https://fill-data.papermc.io/v1/objects/8de7/paper-1.21.1-60.jar";
    const { svc, sources } = moteur({ url, fileName: "paper-1.21.1-60.jar" });

    await svc.install(SERVER, "paper:paper", "1.21.1");
    const signal = (sources.resolve.mock.calls[0] as unknown[])[2];
    expect(signal).toBeInstanceOf(AbortSignal);
    expect((signal as AbortSignal).aborted).toBe(false);
  });

  // Revue du lot (R10) : l'état « installation » écrasait une restauration ou
  // une suspension arrivée pendant la résolution, puis l'effaçait.
  it("refuse un serveur devenu occupé pendant la résolution, sans l'arrêter", async () => {
    const url = "https://fill-data.papermc.io/v1/objects/8de7/paper-1.21.1-60.jar";
    const { svc, daemon } = moteur({ url, fileName: "paper-1.21.1-60.jar" }, true);

    await expect(svc.install(SERVER, "paper:paper", "1.21.1")).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(daemon.power).not.toHaveBeenCalled();
    expect(daemon.pullFile).not.toHaveBeenCalled();
  });

  it("tire le jar servi par PaperMC, sous le nom que l'egg attend", async () => {
    const url = "https://fill-data.papermc.io/v1/objects/8de7/paper-1.21.1-60.jar";
    const { svc, daemon } = moteur({ url, fileName: "paper-1.21.1-60.jar" });

    await svc.install(SERVER, "paper:paper", "1.21.1");
    expect(daemon.pullFile).toHaveBeenCalledWith(SERVER, "/", url, "paper-1.21.1-60.jar");
    expect(daemon.renameFile).toHaveBeenCalledWith(
      SERVER,
      "/",
      "paper-1.21.1-60.jar",
      "server.jar",
    );
  });

  it.each([
    ["https://fill-data.papermc.io/v1/objects/8de7/paper-1.21.8-60.jar", "paper-1.21.8-60.jar"],
    ["https://api.purpurmc.org/v2/purpur/1.21.8/latest/download", "purpur-1.21.8.jar"],
    [
      "https://meta.fabricmc.net/v2/versions/loader/1.21.1/0.16.10/1.0.1/server/jar",
      "fabric-server-1.21.1-0.16.10.jar",
    ],
    ["https://piston-data.mojang.com/v1/objects/6bce/server.jar", "minecraft_server.1.21.8.jar"],
    ["https://launcher.mojang.com/v1/objects/d832/server.jar", "minecraft_server.1.2.5.jar"],
  ])("admet les adresses réelles des éditeurs : %s", (url, fileName) => {
    expect(isTrustedEngineDownload({ url, fileName })).toBe(true);
  });
});

/*
 * Revue du lot (R9) : le panel suivait lui-même l'adresse de version lue dans
 * le manifeste de Mojang, sans contrôle d'hôte.
 */
describe("Vanilla : adresse de version du manifeste", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("ne suit pas une adresse de version hors de Mojang", async () => {
    const appels: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (adresse: string | URL) => {
        appels.push(String(adresse));
        return Response.json({ versions: [{ id: "1.21.8", url: METADONNEES }] });
      }),
    );

    await expect(new EngineSourcesService().resolve("vanilla:vanilla", "1.21.8")).rejects.toThrow(
      /inattendue/,
    );
    expect(appels).not.toContain(METADONNEES);
  });
});
