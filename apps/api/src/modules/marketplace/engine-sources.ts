import type {
  EngineOption,
  EngineRole,
  EngineVersion,
  ProjectLoader,
} from "@gamedashboard/contracts";
import { engineRoleOf } from "@gamedashboard/contracts";
import { Injectable, Logger } from "@nestjs/common";

/**
 * Les plateformes de serveur, telles que leurs auteurs les publient.
 *
 * Toutes sans clé, et c'est ce qui les rend utilisables sans configuration :
 * PaperMC, PurpurMC, FabricMC et Mojang exposent chacun une API publique. Le
 * panel n'héberge aucun jar et n'en relaie aucun octet — il résout une adresse,
 * et le daemon va chercher le fichier lui-même.
 *
 * **Forge et NeoForge sont absents de cette liste.** Ils ne distribuent pas un
 * serveur prêt à l'emploi mais un installeur, qui doit s'exécuter dans le
 * conteneur pour fabriquer le serveur. Cela relève de la réinstallation de
 * l'egg, pas du remplacement d'un fichier : ils sont posés avec le modpack qui
 * les demande, par `ForgeInstallService`, qui règle les variables de l'egg
 * « Minecraft Java » et relance son installation.
 */

const TIMEOUT_MS = 8000;

/** Les éditeurs limitent le débit des agents anonymes. */
const USER_AGENT = "GameDashboard/GameDashboard (panel de jeu, contact@gamedashboard.fr)";

/** Au-delà, la liste déroulante devient plus longue à parcourir qu'utile. */
const VERSION_LIMIT = 25;

/**
 * PaperMC v3, sur son propre domaine.
 *
 * `api.papermc.io/v2` ne répond plus que « sunset ». La v3 vit sur
 * `fill.papermc.io`, range les versions par famille et rend l'adresse de
 * téléchargement toute faite — trois différences, pas une.
 */
const PAPER_API = "https://fill.papermc.io/v3";
const PURPUR_API = "https://api.purpurmc.org/v2";
const FABRIC_API = "https://meta.fabricmc.net/v2";
const MOJANG_MANIFEST = "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json";

/**
 * Hôtes d'où un jar de plateforme peut être tiré par le daemon (NC-47).
 *
 * Relevés sur les réponses réelles des éditeurs (septembre 2026) : PaperMC
 * sert ses builds sur `fill-data`, Mojang ses serveurs sur `piston-data`
 * (`launcher.mojang.com` pour les versions anciennes, 1.2.5 à 1.12 environ),
 * Purpur et Fabric depuis leur API. PaperMC et Mojang **rendent** l'adresse :
 * sans cette liste, une réponse falsifiée ferait de Wings un relais vers
 * `169.254.169.254` ou le réseau d'administration, depuis le node. Un éditeur
 * qui change de domaine fait refuser l'installation, en le disant, plutôt que
 * de la laisser passer sans contrôle.
 */
const ENGINE_DOWNLOAD_HOSTS = new Set([
  "fill-data.papermc.io",
  "api.purpurmc.org",
  "meta.fabricmc.net",
  "piston-data.mojang.com",
  "launcher.mojang.com",
]);

/**
 * Le jar résolu vient-il d'un éditeur connu, en https, sous un nom simple ?
 *
 * Le nom est rendu lui aussi par l'éditeur (PaperMC) et devient un chemin chez
 * le daemon : un seul segment, terminé par `.jar`.
 */
export function isTrustedEngineDownload(jar: { url: string; fileName: string }): boolean {
  if (!/^[\w.+-]{1,200}\.jar$/.test(jar.fileName) || jar.fileName.startsWith(".")) return false;
  try {
    const url = new URL(jar.url);
    return (
      url.protocol === "https:" &&
      ENGINE_DOWNLOAD_HOSTS.has(url.hostname.toLowerCase()) &&
      // Ni identifiants ni port : aucun éditeur n'en sert, et une adresse qui
      // en porte est au mieux une erreur, au pire une forme piégée.
      url.username === "" &&
      url.password === "" &&
      url.port === ""
    );
  } catch {
    return false;
  }
}

/**
 * Hôtes du détail d'une version Vanilla, lu par le panel lui-même dans le
 * manifeste de Mojang : une réponse falsifiée ne doit pas lui faire suivre
 * une adresse arbitraire.
 */
const MOJANG_META_HOSTS = new Set(["piston-meta.mojang.com", "launchermeta.mojang.com"]);

/** Réponse HTTP d'un éditeur autre que 2xx : son statut dit s'il faut parler d'absence ou de panne. */
export class EditorHttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`${url} a répondu ${status}.`);
    this.name = "EditorHttpError";
  }
}

/** Ce qu'il faut savoir d'une plateforme pour la proposer et l'installer. */
interface Platform {
  id: string;
  label: string;
  summary: string;
  /**
   * Serveur de jeu, ou proxy.
   *
   * Remplace une liste de chargeurs compatibles, qui servait à filtrer et
   * filtrait faux : un serveur Paper ne se voyait proposer que la famille
   * Bukkit, donc jamais Fabric. On ne pouvait changer de chargeur qu'en
   * restant dans le même — ce qui n'est pas en changer.
   *
   * Le seul filtre légitime est celui-ci : poser Velocity à la place d'un
   * serveur de jeu donnerait un proxy sans monde, et l'inverse un serveur que
   * personne ne sait joindre.
   */
  role: EngineRole;
}

const PLATFORMS: Platform[] = [
  {
    id: "paper:paper",
    label: "Paper",
    summary:
      "Le serveur Bukkit le plus répandu : compatible Spigot, nettement plus rapide, et corrige des comportements que Vanilla laisse passer.",
    role: "game",
  },
  {
    id: "paper:folia",
    label: "Folia",
    summary:
      "Paper découpé en régions exécutées en parallèle. Destiné aux très grandes cartes ; beaucoup de plugins Bukkit ne le supportent pas.",
    role: "game",
  },
  {
    id: "paper:velocity",
    label: "Velocity",
    summary:
      "Proxy moderne placé devant plusieurs serveurs. N'héberge aucun monde : ses plugins sont les siens, pas ceux d'un serveur de jeu.",
    role: "proxy",
  },
  {
    id: "purpur:purpur",
    label: "Purpur",
    summary:
      "Dérivé de Paper avec des centaines de réglages de jeu supplémentaires. Accepte les plugins Paper et Spigot.",
    role: "game",
  },
  {
    id: "fabric:fabric",
    label: "Fabric",
    summary:
      "Chargeur de mods léger, très suivi pour les versions récentes. Ses mods ne sont pas ceux de Forge.",
    role: "game",
  },
  {
    id: "vanilla:vanilla",
    label: "Vanilla",
    summary:
      "Le serveur officiel de Mojang, sans modification. N'accepte ni plugin ni mod : c'est le point de départ, ou le retour en arrière.",
    role: "game",
  },
];

@Injectable()
export class EngineSourcesService {
  private readonly logger = new Logger(EngineSourcesService.name);

  /**
   * Les plateformes qui conviennent au chargeur du serveur, versions comprises.
   *
   * Une plateforme dont la liste de versions est vide n'est pas proposée :
   * l'afficher donnerait un choix sans option, et l'API qui n'a pas répondu
   * répondra peut-être au prochain chargement.
   */
  /**
   * Les plateformes qu'on peut proposer à ce serveur.
   *
   * Le filtre porte sur le **rôle**, et sur lui seul. Il portait auparavant
   * sur la famille du chargeur en place, si bien qu'un serveur Paper ne voyait
   * que Paper, Folia, Purpur et Vanilla : changer de chargeur n'était possible
   * qu'à condition de ne pas en changer.
   *
   * Un jeu qui n'est pas Minecraft-Java n'obtient rien — aucune de ces
   * plateformes ne lui conviendrait, et lui en poser une donnerait un fichier
   * que rien ne sait lancer.
   */
  async options(loader: ProjectLoader): Promise<EngineOption[]> {
    const role = engineRoleOf(loader);
    const applicable = role === null ? [] : PLATFORMS.filter((platform) => platform.role === role);

    const built = await Promise.all(
      applicable.map(async (platform): Promise<EngineOption | null> => {
        const versions = await this.versionsOf(platform.id).catch((error) => {
          this.logger.warn(`Versions de ${platform.id} illisibles : ${describe(error)}`);
          return [] as EngineVersion[];
        });
        if (versions.length === 0) return null;

        return {
          id: platform.id,
          kind: "jar",
          label: platform.label,
          summary: platform.summary,
          versions,
        };
      }),
    );

    return built.filter((o): o is EngineOption => o !== null);
  }

  /** Versions installables d'une plateforme, la plus récente en tête. */
  async versionsOf(optionId: string): Promise<EngineVersion[]> {
    if (optionId.startsWith("paper:")) return this.paperVersions(optionId.slice("paper:".length));
    if (optionId === "purpur:purpur") return this.purpurVersions();
    if (optionId === "fabric:fabric") return this.fabricVersions();
    if (optionId === "vanilla:vanilla") return this.vanillaVersions();
    return [];
  }

  /**
   * L'adresse du fichier à poser, et le nom qu'il portera.
   *
   * Résolue **au moment d'installer**, jamais reçue du navigateur : une URL
   * venue du client ferait du daemon un téléchargeur de fichiers arbitraires.
   */
  async resolve(
    optionId: string,
    versionId: string,
    /** Une seule échéance pour toute la résolution, requêtes enchaînées comprises. */
    signal?: AbortSignal,
  ): Promise<{ url: string; fileName: string } | null> {
    if (optionId.startsWith("paper:")) {
      return this.paperDownload(optionId.slice("paper:".length), versionId, signal);
    }
    if (optionId === "purpur:purpur") {
      return {
        url: `${PURPUR_API}/purpur/${encodeURIComponent(versionId)}/latest/download`,
        fileName: `purpur-${versionId}.jar`,
      };
    }
    if (optionId === "fabric:fabric") return this.fabricDownload(versionId, "", signal);
    if (optionId === "vanilla:vanilla") return this.vanillaDownload(versionId, signal);
    return null;
  }

  /** Nom lisible d'une plateforme, pour le suivi de ce qui est installé. */
  labelOf(optionId: string): string {
    return PLATFORMS.find((platform) => platform.id === optionId)?.label ?? optionId;
  }

  /**
   * Le serveur Fabric d'un modpack, **au chargeur qu'il demande**.
   *
   * Un pack déclare la version de Fabric Loader avec laquelle ses mods ont été
   * éprouvés ; prendre la plus récente à la place peut suffire, ou non. Sans
   * version demandée (pack serveur CurseForge, qui ne la dit pas), la plus
   * récente pour cette version du jeu.
   */
  fabricServer(
    gameVersion: string,
    loaderVersion = "",
  ): Promise<{ url: string; fileName: string } | null> {
    return this.fabricDownload(gameVersion, loaderVersion);
  }

  /* --- PaperMC : paper, folia, velocity ------------------------------------ */

  private async paperVersions(project: string): Promise<EngineVersion[]> {
    /*
     * L'API v3 range les versions par famille : `{ "1.21": ["1.21.11", …] }`.
     *
     * La v2, qui rendait un simple tableau, a été **mise hors service** par
     * PaperMC — elle répond « sunset » et rien d'autre. C'est le genre de
     * rupture qu'aucun test ne voit venir : le code était juste la veille.
     *
     * Les deux niveaux arrivent déjà du plus récent au plus ancien ; les
     * aplatir dans cet ordre suffit.
     */
    const { versions } = await this.get<{ versions: Record<string, string[]> }>(
      `${PAPER_API}/projects/${project}`,
    );

    return (
      Object.values(versions)
        .flat()
        // Les préversions ne vont pas sur un serveur de joueurs, et elles
        // noieraient les versions stables dans la liste.
        .filter((version) => !/-(rc|pre|snapshot)/i.test(version))
        .slice(0, VERSION_LIMIT)
        .map((version) => ({ id: version, label: version, gameVersion: version }))
    );
  }

  /**
   * Le dernier build **réussi** d'une version.
   *
   * PaperMC publie des builds successifs pour une même version de jeu, et
   * seuls ceux de canal `default` sont recommandés en production. Prendre le
   * tout dernier sans regarder poserait une préversion sur un serveur de
   * joueurs.
   */
  private async paperDownload(
    project: string,
    version: string,
    signal?: AbortSignal,
  ): Promise<{ url: string; fileName: string } | null> {
    /*
     * La v3 rend l'adresse **toute faite**, sur un domaine de contenu distinct.
     *
     * La v2 obligeait à la composer à partir du projet, de la version, du
     * build et du nom de fichier ; la reconstruire aujourd'hui produirait une
     * adresse qui n'existe pas. On prend celle qu'on nous donne.
     */
    const builds = await this.get<
      {
        id: number;
        channel: string;
        downloads: Record<string, { name: string; url: string } | undefined>;
      }[]
    >(`${PAPER_API}/projects/${project}/versions/${encodeURIComponent(version)}/builds`, signal);

    // Les builds arrivent du plus récent au plus ancien. Seul le canal stable
    // va sur un serveur de joueurs ; le repli sert aux versions qui n'en ont
    // pas encore, où aucun build n'est encore promu.
    const stable = builds.find((b) => b.channel === "STABLE" && b.downloads["server:default"]);
    const chosen = stable ?? builds.find((b) => b.downloads["server:default"]);
    const download = chosen?.downloads["server:default"];
    if (!download) return null;

    return { url: download.url, fileName: download.name };
  }

  /* --- PurpurMC ------------------------------------------------------------ */

  private async purpurVersions(): Promise<EngineVersion[]> {
    const { versions } = await this.get<{ versions: string[] }>(`${PURPUR_API}/purpur`);
    return [...versions]
      .reverse()
      .slice(0, VERSION_LIMIT)
      .map((version) => ({ id: version, label: version, gameVersion: version }));
  }

  /* --- Fabric -------------------------------------------------------------- */

  private async fabricVersions(): Promise<EngineVersion[]> {
    const games = await this.get<{ version: string; stable: boolean }[]>(
      `${FABRIC_API}/versions/game`,
    );
    // Les instantanés portent des noms comme « 24w14a » : utiles à qui
    // expérimente, trompeurs dans une liste où l'on cherche « 1.21 ».
    return games
      .filter((g) => g.stable)
      .slice(0, VERSION_LIMIT)
      .map((g) => ({ id: g.version, label: g.version, gameVersion: g.version }));
  }

  /**
   * Fabric fabrique un serveur exécutable à la demande.
   *
   * L'adresse porte la version du jeu, celle du chargeur et celle de
   * l'installeur : les trois doivent être les plus récentes qui s'accordent,
   * et c'est l'API de Fabric qui le dit — pas nous.
   */
  private async fabricDownload(
    gameVersion: string,
    wanted = "",
    signal?: AbortSignal,
  ): Promise<{ url: string; fileName: string } | null> {
    const loaders = await this.get<
      { loader: { version: string }; intermediary: { stable: boolean } }[]
    >(`${FABRIC_API}/versions/loader/${encodeURIComponent(gameVersion)}`, signal);
    // La version demandée doit exister chez Fabric pour ce jeu : une adresse
    // composée avec une version inconnue rendrait une erreur au daemon.
    const loader =
      wanted === ""
        ? loaders[0]?.loader.version
        : loaders.find((entry) => entry.loader.version === wanted)?.loader.version;

    const installers = await this.get<{ version: string; stable: boolean }[]>(
      `${FABRIC_API}/versions/installer`,
      signal,
    );
    const installer = installers.find((i) => i.stable)?.version ?? installers[0]?.version;

    if (!loader || !installer) return null;

    return {
      url: `${FABRIC_API}/versions/loader/${encodeURIComponent(gameVersion)}/${encodeURIComponent(loader)}/${installer}/server/jar`,
      fileName: `fabric-server-${gameVersion}-${loader}.jar`,
    };
  }

  /* --- Vanilla, par le manifeste de Mojang --------------------------------- */

  private async vanillaVersions(): Promise<EngineVersion[]> {
    const manifest = await this.get<{ versions: { id: string; type: string }[] }>(MOJANG_MANIFEST);
    return manifest.versions
      .filter((v) => v.type === "release")
      .slice(0, VERSION_LIMIT)
      .map((v) => ({ id: v.id, label: v.id, gameVersion: v.id }));
  }

  private async vanillaDownload(
    version: string,
    signal?: AbortSignal,
  ): Promise<{ url: string; fileName: string } | null> {
    const manifest = await this.get<{ versions: { id: string; url: string }[] }>(
      MOJANG_MANIFEST,
      signal,
    );
    const entry = manifest.versions.find((v) => v.id === version);
    if (!entry) return null;
    if (!isMojangMeta(entry.url)) {
      throw new Error(`Adresse de version inattendue dans le manifeste de Mojang : ${entry.url}`);
    }

    const detail = await this.get<{ downloads?: { server?: { url: string } } }>(entry.url, signal);
    const url = detail.downloads?.server?.url;
    // Les versions antérieures à 1.2.5 ne publient pas de serveur : l'absence
    // est un fait de Mojang, pas une panne à masquer.
    if (!url) return null;

    return { url, fileName: `minecraft_server.${version}.jar` };
  }

  private async get<T>(url: string, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        // L'agent était **déclaré et jamais envoyé**. Modrinth exige un agent
        // nommé et joignable, et les autres éditeurs limitent plus sévèrement
        // le débit des anonymes : sans cet en-tête, les listes de versions se
        // vident par intermittence, et rien à l'écran ne dit que c'est le
        // fournisseur qui a refusé.
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
      });
      if (!response.ok) throw new EditorHttpError(url, response.status);
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

function isMojangMeta(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && MOJANG_META_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
