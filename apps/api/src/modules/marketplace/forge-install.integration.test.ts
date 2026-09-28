import {
  type Database,
  eggs,
  eggVariables,
  serverEngines,
  servers,
  serverVariables,
} from "@gamedashboard/db";
import { ConflictException, Logger } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FauxWings } from "../../test/faux-wings";
import { seedLocation, seedNode, seedServer, seedUser } from "../../test/fixtures";
import {
  createThrowawayDatabase,
  HAS_DATABASE,
  type ThrowawayDatabase,
} from "../../test/throwaway-database";
import type { NotificationsService } from "../notifications/notifications.service";
import { RemoteServerService } from "../remote/remote-server.service";
import type { WebhookEmitterService } from "../webhooks/webhook-emitter.service";
import type { WingsClientService } from "../wings/wings-client.service";
import type { CurseForgePackService } from "./curseforge-pack";
import { EngineService } from "./engine.service";
import type { EngineSourcesService } from "./engine-sources";
import type { EulaService } from "./eula.service";
import { ForgeInstallService } from "./forge-install.service";
import type { ModpackSourceService } from "./modpack-source";
import type {
  LoaderInstaller,
  PackInstallerService,
  PackOutcome,
  PreparedPack,
} from "./pack-installer.service";

/**
 * Forge et NeoForge posés avec leur modpack, de bout en bout côté panel :
 * variables de l'egg, réinstallation par le daemon (faux, mais qui rend compte
 * par la vraie route `markInstalled`), attente, compte rendu et suivi.
 */

const FORGE_INDEX = `<metadata><versioning><versions>
  <version>1.7.10-10.13.4.1614-1.7.10</version>
  <version>1.20.1-47.2.0</version>
  <version>1.20.1-47.3.0</version>
</versions></versioning></metadata>`;
const NEOFORGE_INDEX =
  "<metadata><versioning><versions><version>21.1.77</version></versions></versioning></metadata>";

const FILES = { "mods/create.jar": "10:t1", "config/create.toml": "3:t1" };

function prepared(gameVersion: string): PreparedPack {
  return {
    source: "curseforge",
    projectId: "42",
    label: "Pack Forge",
    versionId: "100",
    versionLabel: `1.0 · ${gameVersion}`,
    publishedAt: "2026-01-01T00:00:00.000Z",
    gameVersion,
    archive: { url: "https://edge.forgecdn.net/files/1/100/pack.zip", fileName: "pack.zip" },
    form: "manifest",
    loader: null,
  };
}

describe.skipIf(!HAS_DATABASE)("pose de Forge et NeoForge avec un modpack (intégration)", () => {
  let throwaway: ThrowawayDatabase;
  let db: Database;
  let serverId: string;
  let nodeId: string;
  let eggId: string;
  let daemon: FauxWings;
  let forge: ForgeInstallService;
  let service: EngineService;
  let remote: RemoteServerService;
  /** Le chargeur que le faux pack demande, et la version du jeu. */
  let demande: { loader: "forge" | "neoforge" | "fabric"; version: string; game: string };
  const fetchText = vi.fn(async (url: string) =>
    url.includes("neoforged") ? NEOFORGE_INDEX : FORGE_INDEX,
  );
  const sources = {
    fabricServer: vi.fn(async () => ({
      url: "https://meta.fabricmc.net/v2/versions/loader/1.21.1/0.16.10/1.0.1/server/jar",
      fileName: "fabric-server-1.21.1-0.16.10.jar",
    })),
    labelOf: vi.fn(() => "Paper"),
    options: vi.fn(async () => []),
  };

  /** Le vrai déroulé de `PackInstallerService.run`, réduit à ce qui compte ici. */
  const installer = {
    prepare: vi.fn(async () => prepared(demande.game)),
    run: vi.fn(
      async (
        _server: string,
        _prepared: PreparedPack,
        _runtime: unknown,
        _previous: Record<string, string>,
        installLoader: LoaderInstaller,
      ): Promise<PackOutcome> => {
        const result = await installLoader(
          { loader: demande.loader, version: demande.version },
          demande.game,
        );
        return {
          record: {
            source: "curseforge",
            projectId: "42",
            label: "Pack Forge",
            versionId: "100",
            versionLabel: "1.0",
            publishedAt: null,
            gameVersion: demande.game,
            loader: `${demande.loader} ${demande.version}`,
            files: FILES,
          },
          written: 2,
          missing: [],
          kept: [],
          removed: 0,
          notice: result.notice,
          loader: result.installed,
        };
      },
    ),
  };

  async function variable(name: string, value: string | null): Promise<void> {
    const [row] = await db
      .insert(eggVariables)
      .values({ eggId, name, envVariable: name, defaultValue: "latest" })
      .returning({ id: eggVariables.id });
    if (row && value !== null) {
      await db.insert(serverVariables).values({ serverId, eggVariableId: row.id, value });
    }
  }

  async function variables(): Promise<Record<string, string>> {
    const rows = await db
      .select({ name: eggVariables.envVariable, value: serverVariables.value })
      .from(serverVariables)
      .innerJoin(eggVariables, eq(serverVariables.eggVariableId, eggVariables.id))
      .where(eq(serverVariables.serverId, serverId));
    return Object.fromEntries(rows.map((row) => [row.name, row.value]));
  }

  async function state(): Promise<string | null> {
    const [row] = await db.select({ state: servers.state }).from(servers);
    return row?.state ?? null;
  }

  /** Le daemon rend compte comme Wings, par la route du panel. */
  function daemonRepond(successful: boolean): void {
    daemon.onReinstall = async (server) => {
      await remote.markInstalled(nodeId, server, { successful, reinstall: true });
    };
  }

  beforeAll(async () => {
    Logger.overrideLogger(false);
    throwaway = await createThrowawayDatabase();
    db = throwaway.db;
  }, 60_000);

  afterAll(async () => {
    await throwaway?.drop();
  });

  beforeEach(async () => {
    await db.execute(
      sql.raw(
        "truncate table server_engine_installs, server_engines, server_variables, egg_variables, servers, allocations, eggs, nests, nodes, locations, users cascade",
      ),
    );
    nodeId = await seedNode(db, { locationId: await seedLocation(db) });
    serverId = await seedServer(db, { nodeId, ownerId: await seedUser(db) });
    const [server] = await db.select({ eggId: servers.eggId }).from(servers);
    eggId = server?.eggId as string;
    // L'egg « Minecraft Java » : un serveur Forge, sans version épinglée.
    await variable("LOADER", "forge");
    await variable("LOADER_VERSION", "latest");
    await variable("MINECRAFT_VERSION", null);
    demande = { loader: "forge", version: "47.3.0", game: "1.20.1" };
    vi.clearAllMocks();

    daemon = new FauxWings();
    daemonRepond(true);
    remote = new RemoteServerService(
      db,
      { notifyServerOwner: vi.fn(async () => {}) } as unknown as NotificationsService,
      { emit: vi.fn(async () => {}) } as unknown as WebhookEmitterService,
    );
    forge = new ForgeInstallService(db, daemon as unknown as WingsClientService);
    forge.attente = { intervalMs: 5, timeoutMs: 2000 };
    vi.spyOn(forge as unknown as { fetchText: typeof fetchText }, "fetchText").mockImplementation(
      fetchText,
    );
    service = new EngineService(
      db,
      daemon as unknown as WingsClientService,
      sources as unknown as EngineSourcesService,
      { search: vi.fn(async () => []) } as unknown as ModpackSourceService,
      { reset: vi.fn(async () => false) } as unknown as EulaService,
      installer as unknown as PackInstallerService,
      { search: vi.fn(async () => []) } as unknown as CurseForgePackService,
      forge,
    );
    const priv = service as unknown as Record<string, () => unknown>;
    vi.spyOn(priv, "runtimeImageFor" as never).mockResolvedValue(null as never);
    vi.spyOn(priv, "jarNameOf" as never).mockResolvedValue("server.jar" as never);
  });

  it("Forge récent : variables réglées, egg réinstallé, compte rendu et suivi intacts", async () => {
    await service.start(serverId, "curseforge-pack:42", "100");
    await service.settled();

    const install = await service.lastInstall(serverId);
    expect(install?.status).toBe("done");
    expect(install?.report).toMatchObject({
      loader: "Forge 47.3.0 pour Minecraft 1.20.1",
      notice: null,
      files: 2,
    });
    expect(daemon.events).toContain("reinstall");
    expect(fetchText).toHaveBeenCalledWith(
      "https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml",
    );
    expect(await variables()).toEqual({
      LOADER: "forge",
      LOADER_VERSION: "47.3.0",
      MINECRAFT_VERSION: "1.20.1",
    });
    // Le suivi du pack survit à la réinstallation qui a posé le chargeur.
    const current = await service.current(serverId);
    expect(current).toMatchObject({ kind: "pack", loader: "forge 47.3.0", trackedFiles: 2 });
    expect(await state()).toBeNull();
  });

  it("Forge ancien : le suffixe de l'artefact passe dans LOADER_VERSION", async () => {
    demande = { loader: "forge", version: "10.13.4.1614", game: "1.7.10" };
    await service.install(serverId, "curseforge-pack:42", "100");
    expect((await variables()).LOADER_VERSION).toBe("10.13.4.1614-1.7.10");
    expect((await service.current(serverId))?.trackedFiles).toBe(2);
  });

  it("NeoForge : l'egg bascule sur neoforge, depuis le dépôt de NeoForge", async () => {
    demande = { loader: "neoforge", version: "21.1.77", game: "1.21.1" };
    const report = await service.install(serverId, "curseforge-pack:42", "100");
    expect(report.loader).toBe("NeoForge 21.1.77 pour Minecraft 1.21.1");
    expect(await variables()).toEqual({
      LOADER: "neoforge",
      LOADER_VERSION: "21.1.77",
      MINECRAFT_VERSION: "1.21.1",
    });
    expect(fetchText).toHaveBeenCalledWith(
      "https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml",
    );
  });

  it("installeur en échec : compte rendu clair, variables rendues, suivi gardé, serveur libéré", async () => {
    daemonRepond(false);
    await service.start(serverId, "curseforge-pack:42", "100");
    await service.settled();

    const install = await service.lastInstall(serverId);
    expect(install?.status).toBe("done");
    expect(install?.report?.loader).toBeNull();
    expect(install?.report?.notice).toMatch(
      /Forge 47\.3\.0 pour Minecraft 1\.20\.1 n'a pas pu être installé : l'installeur a échoué/,
    );
    expect(await variables()).toEqual({ LOADER: "forge", LOADER_VERSION: "latest" });
    expect((await service.current(serverId))?.trackedFiles).toBe(2);
    // Ni « installing », ni « install_failed » : l'échec est celui du chargeur.
    expect(await state()).toBeNull();
  });

  it("daemon qui refuse la réinstallation : rien n'attend, tout est rendu", async () => {
    daemon.reinstallServer = async () => {
      throw new Error("Wings indisponible");
    };
    const report = await service.install(serverId, "curseforge-pack:42", "100");
    expect(report.notice).toMatch(/le daemon a refusé de relancer l'installation/);
    expect(await variables()).toEqual({ LOADER: "forge", LOADER_VERSION: "latest" });
    expect(await state()).toBeNull();
  });

  it("daemon muet : l'attente a une fin, et le serveur n'est pas laissé « installing »", async () => {
    daemon.onReinstall = null;
    forge.attente = { intervalMs: 5, timeoutMs: 50 };
    await service.start(serverId, "curseforge-pack:42", "100");
    await service.settled();

    const install = await service.lastInstall(serverId);
    expect(install?.status).toBe("done");
    expect(install?.report?.notice).toMatch(/n'a pas rendu compte à temps/);
    expect(await state()).toBeNull();
    expect((await service.current(serverId))?.trackedFiles).toBe(2);
  });

  it("version malformée : refusée sans réinstallation ni variable touchée", async () => {
    demande = { loader: "forge", version: "47.3.0/../../x", game: "1.20.1" };
    const report = await service.install(serverId, "curseforge-pack:42", "100");
    expect(report.notice).toMatch(/malformée/);
    expect(report.loader).toBeNull();
    expect(daemon.events).not.toContain("reinstall");
    expect(fetchText).not.toHaveBeenCalled();
    expect(await variables()).toEqual({ LOADER: "forge", LOADER_VERSION: "latest" });
  });

  it("version absente du dépôt officiel : rien n'est réinstallé", async () => {
    demande = { loader: "forge", version: "47.9.9", game: "1.20.1" };
    const report = await service.install(serverId, "curseforge-pack:42", "100");
    expect(report.notice).toMatch(/introuvable sur son dépôt officiel/);
    expect(daemon.events).not.toContain("reinstall");
  });

  it("dépôt injoignable : le compte rendu le dit", async () => {
    fetchText.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const report = await service.install(serverId, "curseforge-pack:42", "100");
    expect(report.notice).toMatch(/dépôt officiel de Forge n'a pas répondu/);
    expect(daemon.events).not.toContain("reinstall");
  });

  it("egg sans variable LOADER : le panel le dit au lieu de réinstaller", async () => {
    // Un egg Forge tiers, reconnu par son nom, qui ne déclare pas le chargeur.
    await db.update(eggs).set({ name: "Forge Minecraft" }).where(eq(eggs.id, eggId));
    await db.delete(eggVariables).where(eq(eggVariables.envVariable, "LOADER"));
    const report = await service.install(serverId, "curseforge-pack:42", "100");
    expect(report.notice).toMatch(/ne déclare pas LOADER/);
    expect(daemon.events).not.toContain("reinstall");
  });

  it("une mise à jour qui garde sa version de Forge ne relance pas l'installeur", async () => {
    await service.install(serverId, "curseforge-pack:42", "100");
    daemon.events.length = 0;
    const report = await service.install(serverId, "curseforge-pack:42", "100");
    expect(daemon.events).not.toContain("reinstall");
    expect(report.loader).toBe("Forge 47.3.0 pour Minecraft 1.20.1 (déjà en place)");
  });

  it("Fabric : son jar posé comme avant, sans réinstallation", async () => {
    demande = { loader: "fabric", version: "0.16.10", game: "1.21.1" };
    const report = await service.install(serverId, "curseforge-pack:42", "100");
    expect(sources.fabricServer).toHaveBeenCalledWith("1.21.1", "0.16.10");
    expect(daemon.pulled).toEqual([
      "https://meta.fabricmc.net/v2/versions/loader/1.21.1/0.16.10/1.0.1/server/jar",
    ]);
    expect(daemon.events).not.toContain("reinstall");
    expect(report.loader).toBe("Fabric Loader 0.16.10 pour Minecraft 1.21.1");
    expect(await variables()).toEqual({ LOADER: "forge", LOADER_VERSION: "latest" });
  });

  it("une réinstallation à la main garde le suivi tant que les variables nomment le Forge du pack", async () => {
    await service.install(serverId, "curseforge-pack:42", "100");
    await remote.markInstalled(nodeId, serverId, { successful: true, reinstall: true });
    expect((await service.current(serverId))?.trackedFiles).toBe(2);

    // Une autre version réglée à la main : le suivi ne tient plus.
    await db
      .update(serverVariables)
      .set({ value: "47.2.0" })
      .where(eq(serverVariables.value, "47.3.0"));
    await remote.markInstalled(nodeId, serverId, { successful: true, reinstall: true });
    expect(await service.current(serverId)).toBeNull();
    expect(await db.select().from(serverEngines)).toEqual([]);
  });

  /*
   * Relecture (R10, F3, F6) : les prises d'état jouées contre une vraie base.
   * La base simulée des tests unitaires ignorait les conditions SQL.
   */
  describe("prise de l'état « installation »", () => {
    it("refuse un serveur en restauration, sans rien toucher (409)", async () => {
      await db.update(servers).set({ state: "restoring" }).where(eq(servers.id, serverId));

      await expect(service.install(serverId, "curseforge-pack:42", "100")).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(await state()).toBe("restoring");
      expect(daemon.events).toEqual([]);
      expect(await variables()).toEqual({ LOADER: "forge", LOADER_VERSION: "latest" });
    });

    it("ne lève pas une suspension arrivée après l'installeur du chargeur", async () => {
      daemon.onReinstall = async (server) => {
        await remote.markInstalled(nodeId, server, { successful: true, reinstall: true });
        await db.update(servers).set({ state: "suspended" }).where(eq(servers.id, server));
      };

      await service.install(serverId, "curseforge-pack:42", "100");

      expect(await state()).toBe("suspended");
    });

    // Relecture (L1-a) : une suspension pendant l'installeur était annoncée
    // comme un redémarrage du daemon.
    it("dit la vraie cause quand le serveur est pris pendant l'installeur", async () => {
      daemon.onReinstall = async (server) => {
        await db.update(servers).set({ state: "suspended" }).where(eq(servers.id, server));
      };

      const report = await service.install(serverId, "curseforge-pack:42", "100");

      expect(report.notice).toMatch(/pris par une autre opération/);
      expect(report.notice).not.toMatch(/redémarré/);
      expect(await variables()).toEqual({ LOADER: "forge", LOADER_VERSION: "latest" });
      expect(await state()).toBe("suspended");
    });

    it("ne relance pas l'installeur sur un serveur pris entre-temps", async () => {
      // Une restauration posée pendant la lecture du dépôt de Forge, après la
      // prise de l'installation du pack : elle garde la main.
      fetchText.mockImplementationOnce(async () => {
        await db.update(servers).set({ state: "restoring" }).where(eq(servers.id, serverId));
        return FORGE_INDEX;
      });

      const report = await service.install(serverId, "curseforge-pack:42", "100");

      expect(daemon.events).not.toContain("reinstall");
      expect(report.notice).toMatch(/pris par une autre opération/);
      expect(await variables()).toEqual({ LOADER: "forge", LOADER_VERSION: "latest" });
      expect(await state()).toBe("restoring");
    });
  });
});
