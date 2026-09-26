import {
  type EngineInstallReport,
  type EngineInstallRun,
  type EngineOption,
  type InstalledEngine,
  javaMajorFor,
  type PackLoader,
  type PackSource,
  pickDockerImage,
} from "@gamedashboard/contracts";
import {
  type Database,
  eggs,
  eggVariables,
  nests,
  serverEngineInstalls,
  serverEngines,
  servers,
  serverVariables,
} from "@gamedashboard/db";
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { battre } from "../../common/background-tick";
import { DATABASE } from "../../common/database.provider";
import {
  DAEMON_UNAVAILABLE_MESSAGE,
  WingsClientService,
  WingsUnavailableError,
} from "../wings/wings-client.service";
import { CurseForgePackService } from "./curseforge-pack";
import { EditorHttpError, EngineSourcesService, isTrustedEngineDownload } from "./engine-sources";
import { EulaService } from "./eula.service";
import { ForgeInstallService, type LoaderResult } from "./forge-install.service";
import { loaderName } from "./forge-loader";
import type { UpdateFound } from "./marketplace.service";
import { ModpackSourceService } from "./modpack-source";
import {
  PackInstallerService,
  type PackOutcome,
  type PreparedPack,
} from "./pack-installer.service";
import { type DetectedRuntime, detectRuntime } from "./server-runtime";

/**
 * Le moteur d'un serveur : le remplacer, qu'il s'agisse d'un jar ou d'un pack.
 *
 * Un seul service pour les deux, parce que c'est une seule opération vue de
 * deux hauteurs : on change ce que le serveur **est**. Ce qui diffère est
 * l'ampleur — un jar remplace un fichier, un modpack déverse une arborescence
 * entière — et cette différence est dite à l'utilisateur avant qu'il clique,
 * pas découverte après.
 *
 * Trois règles tiennent tout le reste :
 *
 * 1. **L'adresse n'est jamais reçue du navigateur.** Elle est résolue ici, au
 *    moment d'installer. Accepter une URL du client ferait du daemon un
 *    téléchargeur de fichiers arbitraires, pilotable par quiconque a accès à
 *    un serveur.
 * 2. **Le serveur est arrêté avant d'être touché.** Remplacer le jar d'un
 *    serveur qui tourne laisse la machine virtuelle Java sur un fichier qui
 *    n'existe plus, et le plantage n'arrive que plus tard, sans rapport visible.
 * 3. **Le panel ne relaie aucun octet.** Il résout des adresses et lit un index
 *    de quelques kilooctets ; le daemon télécharge les centaines de mégaoctets.
 */

/** Nom du jar de serveur, quand l'egg ne le déclare pas. */
const DEFAULT_JAR = "server.jar";

/** Variables d'egg où lire le nom du jar, par ordre de préférence. */
const JAR_VARIABLES = ["SERVER_JARFILE", "SERVER_JAR", "JARFILE"];

export interface EngineState {
  runtime: DetectedRuntime | null;
  /** Raison lisible quand aucun moteur ne peut être proposé. */
  unavailableReason: string | null;
  /** Ce que le serveur exécute, pour autant que le panel l'ait posé lui-même. */
  current: InstalledEngine | null;
  /** Plateformes de serveur compatibles. */
  platforms: EngineOption[];
  /** Modpacks, résultat de la recherche. */
  packs: EngineOption[];
  /**
   * Le sort de chaque catalogue de modpacks : sans lui, un CurseForge sans clé
   * et un CurseForge sans résultat donneraient le même écran.
   */
  packSources: { source: PackSource; error: string | null }[];
  /** La dernière installation lancée, en cours ou close ; `null` s'il n'y en a jamais eu. */
  install: EngineInstallRun | null;
}

/** Ce que rend une installation, pour l'écran et le journal. */
export type EngineInstallResult = EngineInstallReport;

/** Raison écrite sur une installation que l'API n'a pas pu mener à terme. */
export const INSTALL_INTERRUPTED =
  "L'API a redémarré pendant l'installation : elle n'a pas pu être menée à terme. Vérifiez les fichiers du serveur, puis relancez l'installation.";

export interface EngineInstallOptions {
  installedBy?: string;
  /**
   * Appelé serveur arrêté et verrouillé, **avant la première écriture** :
   * c'est là que se place la sauvegarde préalable. Une erreur arrête tout.
   */
  beforeWrite?: () => Promise<void>;
}

/** Issue d'une installation menée en tâche de fond. */
export type EngineInstallSettled = { result: EngineInstallResult } | { error: string };

export interface EngineStartOptions extends EngineInstallOptions {
  /**
   * Appelé une fois l'installation close, réussie ou non : c'est là que
   * l'appelant tient son journal, la requête qui l'a lancée ayant répondu
   * depuis longtemps. Son propre échec est consigné, sans plus.
   */
  onSettled?: (outcome: EngineInstallSettled) => Promise<void>;
}

/** Tout ce qui a été résolu, et refusé s'il le fallait, avant de toucher au serveur. */
interface InstallPlan {
  optionId: string;
  versionId: string;
  runtime: DetectedRuntime;
  prepared: PreparedPack | null;
  /** Le jar d'une plateforme, résolu et contrôlé avant l'arrêt ; nul pour un modpack. */
  jar: { url: string; fileName: string } | null;
  image: string | null;
  /** Ce qui est installé, lisible, pour l'écran pendant l'installation. */
  label: string;
}

@Injectable()
export class EngineService implements OnApplicationBootstrap {
  private readonly logger = new Logger(EngineService.name);
  /** Installations en cours dans ce processus, pour les tests (`settled`). */
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(WingsClientService) private readonly wings: WingsClientService,
    @Inject(EngineSourcesService) private readonly sources: EngineSourcesService,
    @Inject(ModpackSourceService) private readonly packs: ModpackSourceService,
    @Inject(EulaService) private readonly eula: EulaService,
    @Inject(PackInstallerService) private readonly installer: PackInstallerService,
    @Inject(CurseForgePackService) private readonly curseforge: CurseForgePackService,
    @Inject(ForgeInstallService) private readonly forge: ForgeInstallService,
  ) {}

  /**
   * Ce qui est proposable à ce serveur.
   *
   * Les modpacks ne sont offerts qu'aux chargeurs de mods : en poser un sur un
   * Paper écraserait le serveur par une arborescence qu'il ne sait pas lire.
   */
  async state(serverId: string, query: string): Promise<EngineState> {
    const runtime = await this.runtimeOf(serverId);
    if (!runtime) {
      return {
        runtime: null,
        unavailableReason:
          "Le moteur de ce serveur n'a pas pu être déterminé depuis son egg. Le panel ne propose pas de le remplacer à l'aveugle.",
        current: await this.current(serverId),
        platforms: [],
        packs: [],
        packSources: [],
        install: await this.lastInstall(serverId),
      };
    }

    /*
     * Pendant une installation, rien n'est proposé : l'écran se relit toutes
     * les quelques secondes jusqu'à la fin, et chaque relecture interrogerait
     * sinon Modrinth et CurseForge (une quinzaine d'appels) pour des listes
     * dont aucun bouton n'est cliquable.
     */
    const install = await this.lastInstall(serverId);
    if (install?.status === "running") {
      return {
        runtime,
        unavailableReason: null,
        current: await this.current(serverId),
        platforms: [],
        packs: [],
        packSources: [],
        install,
      };
    }

    const packsWanted = runtime.loader === "fabric" || runtime.loader === "forge";

    const [platforms, modrinth, curseforge, current] = await Promise.all([
      this.sources.options(runtime.loader).catch((error) => {
        this.logger.warn(`Plateformes illisibles : ${describe(error)}`);
        return [] as EngineOption[];
      }),
      packsWanted ? settle(this.packs.search(query, runtime.loader)) : settle(Promise.resolve([])),
      packsWanted
        ? settle(this.curseforge.search(query, runtime.loader))
        : settle(Promise.resolve([])),
      this.current(serverId),
    ]);

    return {
      runtime,
      unavailableReason: null,
      current,
      platforms,
      packs: [...modrinth.options, ...curseforge.options],
      packSources: packsWanted
        ? [
            { source: "modrinth", error: modrinth.error },
            { source: "curseforge", error: curseforge.error },
          ]
        : [],
      install,
    };
  }

  /** La dernière installation lancée sur ce serveur, telle que la base la retient. */
  async lastInstall(serverId: string): Promise<EngineInstallRun | null> {
    const [row] = await this.db
      .select()
      .from(serverEngineInstalls)
      .where(eq(serverEngineInstalls.serverId, serverId))
      .limit(1);
    if (!row) return null;
    return {
      status: row.status === "done" || row.status === "failed" ? row.status : "running",
      optionId: row.optionId,
      versionId: row.versionId,
      label: row.label,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      report: reportOf(row.report),
      error: row.error,
    };
  }

  /**
   * Au démarrage : clôt en échec les installations restées « en cours ».
   *
   * Elles appartenaient à un processus qui n'existe plus (arrêt, plantage,
   * mise à jour du panel) : sans cette clôture, le serveur resterait refusé à
   * toute nouvelle installation (409) et verrouillé « en installation » pour
   * toujours. `battre` : un échec ici est consigné, il n'abat pas l'API — et
   * une version en répétition (`GAMEDASHBOARD_ESSAI`), qui partage la base de
   * celle en service, ne clôt pas les installations de cette dernière.
   */
  onApplicationBootstrap(): void {
    void battre(this.logger, "installations de moteur interrompues", async () => {
      const closed = await this.closeInterrupted();
      if (closed > 0)
        this.logger.warn(`${closed} installation(s) de moteur interrompue(s) close(s).`);
    });
  }

  /** Clôt les installations « en cours » et rend leurs serveurs. Rend leur nombre. */
  async closeInterrupted(): Promise<number> {
    const now = new Date().toISOString();
    const rows = await this.db
      .update(serverEngineInstalls)
      .set({ status: "failed", error: INSTALL_INTERRUPTED, finishedAt: now })
      .where(eq(serverEngineInstalls.status, "running"))
      .returning({ serverId: serverEngineInstalls.serverId });
    const ids = rows.map((row) => row.serverId);
    if (ids.length > 0) {
      // Seul l'état posé par l'installation est levé : un serveur que le daemon
      // réinstalle au même moment garde le sien.
      await this.db
        .update(servers)
        .set({ state: null, updatedAt: now })
        .where(and(inArray(servers.id, ids), eq(servers.state, "installing")));
    }
    return ids.length;
  }

  /**
   * Ce que le panel a posé sur ce serveur, tel que la base le retient.
   *
   * `null` quand rien n'a été posé par le panel, ou depuis la dernière
   * réinstallation par le daemon : le panel ne prétend pas savoir ce qu'un
   * script d'egg a installé.
   */
  async current(serverId: string): Promise<InstalledEngine | null> {
    const [row] = await this.db
      .select()
      .from(serverEngines)
      .where(eq(serverEngines.serverId, serverId))
      .limit(1);
    if (!row) return null;

    return {
      optionId: row.optionId,
      kind: row.kind === "pack" ? "pack" : "jar",
      label: row.label,
      versionId: row.versionId,
      versionLabel: row.versionLabel,
      gameVersion: row.gameVersion,
      loader: row.loader,
      pack:
        row.packSource && row.packProjectId && isPackSource(row.packSource)
          ? { source: row.packSource, projectId: row.packProjectId }
          : null,
      trackedFiles: Object.keys(row.files ?? {}).length,
      update:
        row.latestVersionId && row.latestVersionLabel
          ? { versionId: row.latestVersionId, label: row.latestVersionLabel }
          : null,
      checkedAt: row.checkedAt,
      installedAt: row.installedAt,
    };
  }

  /**
   * Un passage de la veille pour les modpacks installés.
   *
   * Même règles que pour les extensions (`MarketplaceService.checkUpdates`) :
   * les lignes les moins récemment vérifiées d'abord, une source en panne ne
   * efface rien, et seules les mises à jour **nouvellement** apparues sont
   * rendues, pour ne prévenir qu'une fois.
   */
  async checkPackUpdates(limit: number, olderThan: string): Promise<Map<string, UpdateFound[]>> {
    const due = await this.db
      .select()
      .from(serverEngines)
      .where(
        and(
          eq(serverEngines.kind, "pack"),
          sql`(${serverEngines.checkedAt} is null or ${serverEngines.checkedAt} < now() - ${olderThan}::interval)`,
        ),
      )
      .orderBy(sql`${serverEngines.checkedAt} asc nulls first`)
      .limit(limit);

    const found = new Map<string, UpdateFound[]>();
    for (const row of due) {
      if (!row.packSource || !row.packProjectId) continue;
      const installed = {
        versionId: row.versionId,
        publishedAt: row.versionPublishedAt,
        gameVersion: row.gameVersion,
        loader: (row.loader ?? "").split(" ")[0] ?? "",
      };

      let newer: { id: string; label: string } | null;
      try {
        newer =
          row.packSource === "curseforge"
            ? await this.curseforge.newerVersion(Number(row.packProjectId), installed)
            : await this.packs.newerVersion(row.packProjectId, installed);
      } catch (error) {
        this.logger.warn(`Veille : modpack ${row.packProjectId} illisible (${describe(error)})`);
        continue;
      }

      await this.db
        .update(serverEngines)
        .set({
          latestVersionId: newer?.id ?? null,
          latestVersionLabel: newer?.label ?? null,
          checkedAt: new Date().toISOString(),
        })
        .where(eq(serverEngines.serverId, row.serverId));

      if (newer && newer.id !== row.latestVersionId) {
        const list = found.get(row.serverId) ?? [];
        list.push({ name: row.label, version: newer.label });
        found.set(row.serverId, list);
      }
    }
    return found;
  }

  /**
   * Lance une installation **en tâche de fond**, et rend aussitôt son état.
   *
   * Un modpack enchaîne des centaines de téléchargements et peut attendre une
   * demi-heure sa sauvegarde préalable : l'interface, le vhost et Passenger
   * coupent une requête bien avant. Ce qui peut être refusé l'est ici, avant
   * de répondre (version introuvable, chargeur, archive, runtime Java) ; le
   * reste se déroule après la réponse, et son sort est écrit en base
   * (`server_engine_installs`), où l'écran le relit.
   *
   * Une seule installation à la fois par serveur : la ligne est prise d'un
   * seul `INSERT … ON CONFLICT … WHERE status <> 'running'`, et une seconde
   * demande pendant la première est refusée (409).
   */
  async start(
    serverId: string,
    optionId: string,
    versionId: string,
    options: EngineStartOptions = {},
  ): Promise<EngineInstallRun> {
    const plan = await this.plan(serverId, optionId, versionId);
    const run = await this.claim(serverId, plan, options.installedBy);

    // `battre` et non un simple `void` : un rejet non rattrapé abat le
    // processus sous Node 24, et `finish` consigne déjà l'échec en base.
    const running = battre(this.logger, `installation de moteur (${serverId})`, () =>
      this.finish(serverId, plan, options),
    ).finally(() => {
      this.inFlight.delete(running);
    });
    this.inFlight.add(running);
    return run;
  }

  /** Attend les installations en cours. Pour les tests ; les requêtes ne l'appellent jamais. */
  async settled(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  /** Prend la ligne d'installation du serveur, ou refuse s'il y en a une en cours. */
  private async claim(
    serverId: string,
    plan: InstallPlan,
    startedBy: string | undefined,
  ): Promise<EngineInstallRun> {
    const row = {
      status: "running",
      optionId: plan.optionId.slice(0, 160),
      versionId: plan.versionId.slice(0, 120),
      label: plan.label.slice(0, 200),
      report: null,
      error: null,
      startedBy: startedBy ?? null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    const taken = await this.db
      .insert(serverEngineInstalls)
      .values({ serverId, ...row })
      .onConflictDoUpdate({
        target: serverEngineInstalls.serverId,
        set: row,
        setWhere: sql`${serverEngineInstalls.status} <> 'running'`,
      })
      .returning({ serverId: serverEngineInstalls.serverId });
    if (taken.length === 0) {
      throw new ConflictException(
        "Une installation est déjà en cours sur ce serveur. Attendez qu'elle se termine.",
      );
    }
    return {
      status: "running",
      optionId: row.optionId,
      versionId: row.versionId,
      label: row.label,
      startedAt: row.startedAt,
      finishedAt: null,
      report: null,
      error: null,
    };
  }

  /** L'installation proprement dite, après la réponse ; son sort va en base. */
  private async finish(serverId: string, plan: InstallPlan, options: EngineStartOptions) {
    let outcome: EngineInstallSettled;
    try {
      const result = await this.apply(serverId, plan, options);
      outcome = { result };
      await this.settle(serverId, { status: "done", report: result, error: null });
    } catch (error) {
      const reason = reasonOf(error);
      if (!(error instanceof HttpException)) {
        this.logger.error(`Installation de moteur sur ${serverId} : ${describe(error)}`);
      }
      outcome = { error: reason };
      await this.settle(serverId, { status: "failed", report: null, error: reason });
    }
    if (options.onSettled) {
      await options.onSettled(outcome).catch((error: unknown) => {
        this.logger.warn(`Journal de l'installation sur ${serverId} : ${describe(error)}`);
      });
    }
  }

  private async settle(
    serverId: string,
    values: { status: "done" | "failed"; report: EngineInstallResult | null; error: string | null },
  ): Promise<void> {
    await this.db
      .update(serverEngineInstalls)
      .set({
        status: values.status,
        report: values.report as Record<string, unknown> | null,
        error: values.error?.slice(0, 1000) ?? null,
        finishedAt: new Date().toISOString(),
      })
      .where(eq(serverEngineInstalls.serverId, serverId));
  }

  /**
   * Installe un moteur : plateforme ou modpack, d'un seul tenant.
   *
   * Pour les tests et les appels internes ; l'API passe par `start`, qui mène
   * la même opération en tâche de fond.
   */
  async install(
    serverId: string,
    optionId: string,
    versionId: string,
    options: EngineInstallOptions = {},
  ): Promise<EngineInstallResult> {
    return this.apply(serverId, await this.plan(serverId, optionId, versionId), options);
  }

  /**
   * Tout ce qui peut être refusé l'est **avant** d'arrêter le serveur : une
   * version introuvable, un chargeur qui ne convient pas, une archive hors
   * des dépôts connus, un runtime Java absent de l'egg. Un refus à ce stade
   * laisse le serveur tel qu'on l'a trouvé — en marche compris.
   */
  private async plan(serverId: string, optionId: string, versionId: string): Promise<InstallPlan> {
    const runtime = await this.runtimeOf(serverId);
    if (!runtime) {
      throw new BadRequestException("Le moteur de ce serveur n'a pas pu être déterminé.");
    }
    const isPack = optionId.startsWith("modpack:") || optionId.startsWith("curseforge-pack:");
    const prepared = isPack ? await this.installer.prepare(optionId, versionId, runtime) : null;
    const jar = isPack ? null : await this.resolveJar(optionId, versionId);
    const image = await this.runtimeImageFor(serverId, prepared?.gameVersion ?? versionId);
    const label = prepared
      ? `${prepared.label || "Modpack"} ${prepared.versionLabel}`.trim()
      : `${this.sources.labelOf?.(optionId) ?? optionId} ${versionId}`;
    return { optionId, versionId, runtime, prepared, jar, image, label };
  }

  /**
   * Mène l'installation préparée.
   *
   * L'opération n'est **pas** réversible par elle-même : ce qui est écrasé est
   * écrasé. C'est pour cela que le serveur est arrêté, et que l'écran
   * conseille une sauvegarde avant.
   */
  private async apply(
    serverId: string,
    plan: InstallPlan,
    options: EngineInstallOptions,
  ): Promise<EngineInstallResult> {
    const { optionId, versionId, runtime, prepared, jar, image } = plan;

    /*
     * Arrêt avant écriture, et non « si possible ».
     *
     * Remplacer le jar d'un serveur qui tourne laisse la machine virtuelle sur
     * un fichier supprimé : le serveur continue quelques minutes, puis tombe
     * pour une raison qui n'a plus aucun rapport visible avec ce qu'on a fait.
     * L'état d'avant est relevé : si rien n'est écrit, le serveur est rendu tel
     * qu'on l'a trouvé, redémarré s'il tournait.
     */
    /*
     * Le serveur est marqué « en installation » pendant toute l'opération.
     *
     * Sans cela, rien n'empêchait de cliquer « Démarrer » dans la console
     * pendant que le panel remplaçait le jar : le daemon aurait lancé un
     * programme à moitié écrit, et la panne qui suit ne ressemble en rien à sa
     * cause. `ServerAccessService.requireOperable` lit cet état et refuse, avec
     * la raison.
     *
     * Relâché dans un `finally` : une installation qui échoue doit rendre le
     * serveur à son propriétaire, pas le laisser verrouillé.
     *
     * **Pris seulement sur un serveur sans état**, et avant l'arrêt : la route
     * contrôle l'état avant `plan()`, qui attend l'éditeur quelques secondes ;
     * une restauration, une suspension ou un transfert arrivés entre-temps
     * étaient écrasés par « installation », puis effacés à la fin.
     */
    await this.claimInstalling(serverId);

    const wasRunning = await this.isRunning(serverId);
    await this.wings.power(serverId, "stop").catch(() => undefined);

    let installed: Omit<EngineInstallResult, "eulaReset">;
    let untouched = true;
    try {
      // La sauvegarde préalable voit un serveur arrêté, que personne ne peut
      // redémarrer pendant qu'elle se fait.
      if (options.beforeWrite) await options.beforeWrite();
      untouched = false;

      if (prepared) {
        const previous = await this.trackedPackFiles(serverId);
        const outcome = await this.installer.run(
          serverId,
          prepared,
          runtime,
          previous,
          (loader, gameVersion) => this.installLoader(serverId, loader, gameVersion),
        );
        if (image) await this.applyRuntimeImage(serverId, image);
        await this.recordPack(serverId, optionId, outcome, options.installedBy);
        installed = {
          label: outcome.record.label,
          files: outcome.written,
          missing: outcome.missing,
          kept: outcome.kept,
          removed: outcome.removed,
          notice: outcome.notice,
          loader: outcome.loader,
        };
      } else if (jar) {
        installed = await this.installJar(
          serverId,
          optionId,
          versionId,
          jar,
          image,
          options.installedBy,
        );
      } else {
        throw new NotFoundException("Cette version n'est plus proposée par son éditeur.");
      }
    } finally {
      await this.releaseInstalling(serverId);
      /*
       * La sauvegarde préalable a échoué (quota plein, daemon muet…) : rien
       * n'a été écrit, et le serveur ne doit pas rester arrêté pour autant.
       * Il repart s'il tournait — une installation refusée n'est pas une panne.
       */
      if (untouched && wasRunning) {
        await this.wings.power(serverId, "start").catch((error: unknown) => {
          this.logger.warn(`Redémarrage de ${serverId} après refus : ${describe(error)}`);
        });
      }
    }

    /*
     * L'acceptation du contrat de licence est retirée.
     *
     * Un accord se donne pour **un** programme. Ce serveur n'exécute plus le
     * même : le faire démarrer sur un consentement donné pour l'ancien moteur
     * ferait reposer la conformité d'aujourd'hui sur une décision prise pour
     * autre chose. Le redemander coûte un clic.
     *
     * Après l'installation, jamais avant : une installation qui échoue ne doit
     * pas retirer un accord toujours valable pour le moteur en place.
     */
    const eulaReset = await this.eula.reset(serverId, `moteur remplacé par ${installed.label}`);

    return { ...installed, eulaReset };
  }

  /** Le serveur tourne-t-il ? Faux quand le daemon ne le dit pas : on ne redémarre pas à l'aveugle. */
  private async isRunning(serverId: string): Promise<boolean> {
    try {
      const resources = await this.wings.resources(serverId);
      return resources.state === "running" || resources.state === "starting";
    } catch {
      return false;
    }
  }

  /** Fichiers suivis du pack en place, vides si le moteur actuel n'en est pas un. */
  private async trackedPackFiles(serverId: string): Promise<Record<string, string>> {
    const [row] = await this.db
      .select({ kind: serverEngines.kind, files: serverEngines.files })
      .from(serverEngines)
      .where(eq(serverEngines.serverId, serverId))
      .limit(1);
    return row?.kind === "pack" ? (row.files ?? {}) : {};
  }

  /**
   * Retient ce qui vient d'être installé.
   *
   * La veille repart de zéro (`checked_at` nul) : la ligne est vérifiée à son
   * prochain passage, sans garder la « mise à jour disponible » d'une version
   * qu'on vient peut-être justement d'installer.
   */
  private async record(
    serverId: string,
    values: Omit<typeof serverEngines.$inferInsert, "serverId" | "installedAt">,
  ): Promise<void> {
    const now = new Date().toISOString();
    const row = {
      ...values,
      latestVersionId: null,
      latestVersionLabel: null,
      checkedAt: null,
      installedAt: now,
      updatedAt: now,
    };
    await this.db
      .insert(serverEngines)
      .values({ serverId, ...row })
      .onConflictDoUpdate({ target: serverEngines.serverId, set: row });
  }

  private recordPack(
    serverId: string,
    optionId: string,
    outcome: PackOutcome,
    installedBy: string | undefined,
  ): Promise<void> {
    const { record } = outcome;
    return this.record(serverId, {
      kind: "pack",
      optionId: optionId.slice(0, 160),
      label: record.label.slice(0, 200),
      versionId: record.versionId.slice(0, 120),
      versionLabel: record.versionLabel.slice(0, 200),
      versionPublishedAt: record.publishedAt,
      gameVersion: record.gameVersion.slice(0, 40),
      loader: record.loader?.slice(0, 80) ?? null,
      packSource: record.source,
      packProjectId: record.projectId.slice(0, 120),
      files: record.files,
      installedBy: installedBy ?? null,
    });
  }

  /**
   * Le chargeur demandé par le pack.
   *
   * **Fabric** : le serveur est posé à la version de Fabric Loader que le pack
   * demande, sous le nom que l'egg attend — c'était la marche manquante, le
   * pack se déballait sur le chargeur en place quelle que soit sa version.
   * **Forge et NeoForge** : ils ne publient qu'un installeur, qui doit tourner
   * dans le conteneur ; `ForgeInstallService` règle les variables de l'egg
   * « Minecraft Java » et relance son installation, qui l'exécute. Rend ce qui
   * a été posé, et ce qui reste à faire.
   */
  private async installLoader(
    serverId: string,
    loader: { loader: PackLoader; version: string } | null,
    gameVersion: string,
  ): Promise<LoaderResult> {
    if (!loader) return { notice: null, installed: null };
    if (loader.loader === "fabric") {
      if (gameVersion === "") return { notice: null, installed: null };
      const jar = await this.sources.fabricServer(gameVersion, loader.version).catch(() => null);
      if (!jar) {
        return {
          notice: `Fabric Loader ${loader.version} pour Minecraft ${gameVersion} est introuvable chez Fabric : le chargeur en place a été gardé.`,
          installed: null,
        };
      }
      await this.placeJar(serverId, jar);
      return {
        notice: null,
        installed: `${`Fabric Loader ${loader.version}`.trim()} pour Minecraft ${gameVersion}`,
      };
    }
    if (loader.loader === "forge" || loader.loader === "neoforge") {
      return this.forge.install(serverId, {
        family: loader.loader,
        version: loader.version,
        gameVersion,
      });
    }
    const name = loaderName(loader.loader);
    return {
      notice: `Ce pack demande ${name}${loader.version ? ` ${loader.version}` : ""}${gameVersion ? ` pour Minecraft ${gameVersion}` : ""}. Le panel ne sait pas poser ce chargeur : installez-le à la main.`,
      installed: null,
    };
  }

  /**
   * Pose l'état « installation » (et `releaseInstalling` le lève).
   *
   * `null` veut dire « rien de particulier » : c'est l'état d'un serveur
   * installé, à l'arrêt ou en marche. Le panel n'y écrit jamais l'état du
   * conteneur, que seul le daemon connaît (§8.2).
   *
   * Un arrêt brutal du panel pendant une installation laisse le serveur
   * verrouillé — c'est la même exposition que le flux d'installation d'origine,
   * et `resetTransientStates` le libère au prochain démarrage du daemon.
   */
  private async claimInstalling(serverId: string): Promise<void> {
    const [claimed] = await this.db
      .update(servers)
      .set({ state: "installing", updatedAt: new Date().toISOString() })
      .where(and(eq(servers.id, serverId), isNull(servers.state)))
      .returning({ id: servers.id });
    if (!claimed) {
      throw new ConflictException(
        "Ce serveur est occupé par une autre opération. Réessayez quand elle sera terminée.",
      );
    }
  }

  /** Ne lève que l'état posé par l'installation : une suspension décidée entre-temps reste. */
  private async releaseInstalling(serverId: string): Promise<void> {
    await this.db
      .update(servers)
      .set({ state: null, updatedAt: new Date().toISOString() })
      .where(and(eq(servers.id, serverId), eq(servers.state, "installing")));
  }

  /**
   * L'adresse du jar d'une plateforme, demandée à son éditeur **avant** l'arrêt.
   *
   * Une version retirée ou une adresse hors des hôtes connus (NC-47) est
   * refusée pendant que le serveur tourne encore : rien n'est touché.
   */
  private async resolveJar(
    optionId: string,
    versionId: string,
  ): Promise<{ url: string; fileName: string }> {
    /*
     * Résolue pendant la requête, et non plus en tâche de fond, sous **une
     * seule échéance** : Fabric et Vanilla enchaînent deux requêtes, et deux
     * délais de 8 s dépassaient les 10 s après lesquels l'interface abandonne
     * (`API_TIMEOUT_MS`), pendant que l'API poursuivait.
     */
    const resolved = await this.sources
      .resolve(optionId, versionId, AbortSignal.timeout(JAR_RESOLVE_TIMEOUT_MS))
      .catch((error: unknown) => {
        this.logger.warn(`Jar de ${optionId} ${versionId} introuvable : ${describe(error)}`);
        throw resolveFailure(error);
      });
    if (!resolved) {
      throw new NotFoundException("Cette version n'est plus proposée par son éditeur.");
    }
    this.assertTrustedJar(resolved);
    return resolved;
  }

  private assertTrustedJar(jar: { url: string; fileName: string }): void {
    // PaperMC et Mojang rendent l'adresse ; le daemon la suivrait depuis le
    // réseau du node sans regarder.
    if (!isTrustedEngineDownload(jar)) {
      this.logger.warn(`Jar de plateforme refusé : ${jar.url} (${jar.fileName})`);
      throw new ConflictException(
        "L'éditeur indique une adresse de téléchargement hors de ses dépôts habituels. Installation refusée ; réessayez plus tard.",
      );
    }
  }

  /** Une plateforme : un fichier, posé sous le nom que l'egg attend. */
  private async installJar(
    serverId: string,
    optionId: string,
    versionId: string,
    resolved: { url: string; fileName: string },
    image: string | null,
    installedBy: string | undefined,
  ): Promise<Omit<EngineInstallResult, "eulaReset">> {
    await this.placeJar(serverId, resolved);
    if (image) await this.applyRuntimeImage(serverId, image);

    const label = this.sources.labelOf(optionId);
    await this.record(serverId, {
      kind: "jar",
      optionId: optionId.slice(0, 160),
      label: label.slice(0, 200),
      versionId: versionId.slice(0, 120),
      versionLabel: versionId.slice(0, 200),
      versionPublishedAt: null,
      gameVersion: optionId === "paper:velocity" ? "" : versionId.slice(0, 40),
      loader: null,
      packSource: null,
      packProjectId: null,
      files: {},
      installedBy: installedBy ?? null,
    });

    return {
      label: `${label} ${versionId}`,
      files: 1,
      missing: [],
      kept: [],
      removed: 0,
      notice: null,
      loader: null,
    };
  }

  /**
   * Pose un jar de serveur sous le nom que **l'egg** attend, pas sous le sien.
   *
   * La commande de démarrage porte ce nom : déposer « paper-1.20.1-196.jar »
   * à côté d'un egg qui lance « server.jar » donne un serveur qui ne démarre
   * pas, avec à l'écran un moteur fraîchement installé. Le renommage n'est
   * pas un détail de confort, c'est la condition pour que ça marche.
   */
  private async placeJar(
    serverId: string,
    resolved: { url: string; fileName: string },
  ): Promise<void> {
    // Second contrôle, pour le serveur Fabric qu'un modpack fait poser.
    this.assertTrustedJar(resolved);
    const target = await this.jarNameOf(serverId);
    await this.wings.pullFile(serverId, "/", resolved.url, resolved.fileName);
    if (resolved.fileName !== target) {
      await this.wings.deleteFiles(serverId, "/", [target]).catch(() => undefined);
      await this.wings.renameFile(serverId, "/", resolved.fileName, target);
    }
  }

  /**
   * Aligne l'image de conteneur sur la version installée.
   *
   * **Relevé sur un vrai serveur, et c'est la dernière marche.** Poser un jar
   * Paper 1.21 sur un egg réglé en Java 8 donne un fichier parfaitement en
   * place et un conteneur qui sort en code 1 : « Minecraft requires running the
   * server with Java 17 or above ». Changer le moteur sans changer le runtime
   * ne change rien d'utile — pire, cela donne l'impression que l'installation a
   * marché.
   *
   * L'image est choisie **parmi celles que l'egg déclare**, jamais fabriquée :
   * son auteur les a éprouvées, et en inventer une ferait tirer au daemon une
   * adresse qui n'existe pas. Quand aucune ne convient, on n'y touche pas et on
   * le dit au journal — un serveur qui ne démarre pas se diagnostique ; un
   * serveur basculé sur un runtime arbitraire, beaucoup moins.
   */
  private async runtimeImageFor(serverId: string, gameVersion: string): Promise<string | null> {
    const java = javaMajorFor(gameVersion);
    // Version illisible : on ne bascule rien, et on ne refuse rien non plus.
    // Deviner corrigerait un problème que le serveur n'avait peut-être pas.
    if (java === null) return null;

    const [row] = await this.db
      .select({ images: eggs.dockerImages, current: servers.dockerImage })
      .from(servers)
      .innerJoin(eggs, eq(servers.eggId, eggs.id))
      .where(eq(servers.id, serverId))
      .limit(1);

    if (!row) return null;

    const wanted = pickDockerImage((row.images ?? {}) as Record<string, string>, java);

    /*
     * **Refus, et non repli silencieux.**
     *
     * Aucune image de l'egg ne porte ce Java : cette version ne peut pas
     * tourner ici. Poser le jar quand même donnerait un serveur cassé avec,
     * à l'écran, une installation réussie — le pire des deux mondes. Le refus
     * nomme la version de Java manquante, qui est la seule information utile à
     * qui doit corriger l'egg.
     */
    if (!wanted) {
      throw new ConflictException(
        `Cette version demande Java ${java}, et l'egg de ce serveur ne déclare aucune image qui le porte. ` +
          "Ajoutez-en une au catalogue, ou choisissez une version plus ancienne.",
      );
    }

    return wanted === row.current ? null : wanted;
  }

  /**
   * Bascule le serveur sur l'image retenue, et prévient le daemon.
   *
   * Wings ne relit la configuration qu'au démarrage et sur `syncServer` : sans
   * cet appel, il redémarrerait le serveur sur l'ancienne image, et le jar
   * fraîchement posé échouerait pour une raison qu'on croirait corrigée.
   */
  private async applyRuntimeImage(serverId: string, image: string): Promise<void> {
    await this.db
      .update(servers)
      .set({ dockerImage: image, updatedAt: new Date().toISOString() })
      .where(eq(servers.id, serverId));

    await this.wings.syncServer(serverId).catch(() => undefined);
    this.logger.log(`Serveur ${serverId} basculé sur ${image}.`);
  }

  /**
   * Nom du jar attendu par l'egg du serveur.
   *
   * Lu dans ses variables, avec `server.jar` en repli — c'est la convention de
   * la quasi-totalité des eggs, et se tromper donne un serveur qui ne démarre
   * pas plutôt qu'une erreur.
   */
  private async jarNameOf(serverId: string): Promise<string> {
    const variables = await this.db
      .select({ name: eggVariables.envVariable, value: serverVariables.value })
      .from(serverVariables)
      .innerJoin(eggVariables, eq(serverVariables.eggVariableId, eggVariables.id))
      .where(eq(serverVariables.serverId, serverId));

    const found = variables.find(
      (variable) => JAR_VARIABLES.includes(variable.name) && variable.value.trim() !== "",
    );
    return found?.value.trim() ?? DEFAULT_JAR;
  }

  /** Runtime du serveur, déduit de son egg et de ses variables. */
  private async runtimeOf(serverId: string): Promise<DetectedRuntime | null> {
    const [row] = await this.db
      .select({ eggName: eggs.name, nestName: nests.name })
      .from(servers)
      .innerJoin(eggs, eq(servers.eggId, eggs.id))
      .innerJoin(nests, eq(eggs.nestId, nests.id))
      .where(eq(servers.id, serverId))
      .limit(1);

    if (!row) return null;

    const variables = await this.db
      .select({ name: eggVariables.envVariable, value: serverVariables.value })
      .from(serverVariables)
      .innerJoin(eggVariables, eq(serverVariables.eggVariableId, eggVariables.id))
      .where(eq(serverVariables.serverId, serverId));

    const merged = Object.fromEntries(variables.map((v) => [v.name, v.value])) as Record<
      string,
      string
    >;

    return detectRuntime(row.eggName, row.nestName, merged);
  }
}

/** Toute la résolution d'un jar, sous les 10 s de l'interface. */
const JAR_RESOLVE_TIMEOUT_MS = 8000;

/**
 * Ce qu'un échec de résolution veut dire, pour qui a cliqué.
 *
 * Tout devenait « l'éditeur ne répond pas » : un 404 de PaperMC pour une
 * version retirée comme une réponse mal formée. Trois cas, trois phrases.
 */
function resolveFailure(error: unknown): HttpException {
  if (error instanceof EditorHttpError && error.status === 404) {
    return new NotFoundException("Cette version n'est plus proposée par son éditeur.");
  }
  const silent =
    (error instanceof EditorHttpError && error.status >= 500) ||
    (error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError" || error.name === "TypeError"));
  return new BadGatewayException(
    silent
      ? "L'éditeur de cette plateforme ne répond pas. Réessayez dans quelques minutes."
      : "L'éditeur de cette plateforme a rendu une réponse inattendue. Installation refusée ; réessayez plus tard.",
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * La raison d'un échec, telle que l'écran peut la montrer.
 *
 * Les refus du panel (`HttpException`) sont écrits pour être lus. Le message
 * brut du daemon nomme la machine et son adresse privée : il reste au journal,
 * comme pour les requêtes relayées. Le reste est une panne interne, dite
 * sans détail.
 */
export function reasonOf(error: unknown): string {
  if (error instanceof WingsUnavailableError) {
    return error.isRefusal && error.detail ? error.detail : DAEMON_UNAVAILABLE_MESSAGE;
  }
  if (error instanceof HttpException) return error.message;
  return "L'installation a échoué sur une erreur interne du panel : l'exploitant en trouvera la cause dans le journal de l'API.";
}

/**
 * Le compte rendu retenu en base. Ceux écrits avant l'ajout de `loader` ne
 * l'ont pas : ils le prennent nul plutôt que de le laisser indéfini à l'écran.
 */
function reportOf(value: unknown): EngineInstallReport | null {
  if (!value || typeof value !== "object") return null;
  const report = value as EngineInstallReport;
  return { ...report, loader: report.loader ?? null };
}

function isPackSource(value: string): value is PackSource {
  return value === "modrinth" || value === "curseforge";
}

/** Une recherche de packs et son sort, pour pouvoir dire pourquoi elle est vide. */
async function settle(
  pending: Promise<EngineOption[]>,
): Promise<{ options: EngineOption[]; error: string | null }> {
  try {
    return { options: await pending, error: null };
  } catch (error) {
    return { options: [], error: describe(error) };
  }
}
