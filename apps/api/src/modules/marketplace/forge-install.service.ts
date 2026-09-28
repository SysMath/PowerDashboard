import {
  type Database,
  eggVariables,
  serverEngines,
  servers,
  serverVariables,
} from "@gamedashboard/db";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { DATABASE } from "../../common/database.provider";
import { WingsClientService } from "../wings/wings-client.service";
import {
  eggSettingsFor,
  FORGE_EGG_VARIABLES,
  type ForgeRequest,
  type ForgeTarget,
  loaderName,
  metadataUrl,
  parseMavenVersions,
  refusForge,
  resolveForgeTarget,
} from "./forge-loader";

/**
 * Pose Forge ou NeoForge par une réinstallation de l'egg « Minecraft Java ».
 *
 * La voie, et pourquoi (voir aussi `forge-loader.ts`) : l'installeur de Forge
 * doit s'exécuter dans le conteneur ; seul le script d'installation de l'egg
 * y tourne, lancé par Wings dans l'image d'installation. L'egg du panel sait
 * déjà poser Forge et NeoForge d'après `LOADER`, `LOADER_VERSION` et
 * `MINECRAFT_VERSION`, et ne touche ni aux mondes ni aux mods. Le panel règle
 * donc ces trois variables, puis demande la réinstallation — exactement ce que
 * ferait un exploitant, sans script fabriqué et sans rien changer à Wings.
 *
 * Déroulement, tout entier dans la tâche de fond de l'installation du pack :
 *
 * 1. refus d'une version malformée ou inconnue du dépôt officiel, **avant**
 *    de toucher au serveur (rien n'est alors changé) ;
 * 2. variables réglées, puis `sync` et `reinstall` du daemon ;
 * 3. attente du compte rendu de Wings (`POST …/install`, `markInstalled`),
 *    lu dans la base : `installed_at` avance sur un succès, l'état passe à
 *    `install_failed` sur un échec ;
 * 4. sur un échec, les variables reprennent leurs valeurs : elles ne doivent
 *    pas annoncer un chargeur que le script n'a pas pu poser.
 *
 * Jamais d'exception pour un échec attendu (Java absent de l'image, réseau
 * fermé, daemon muet) : le compte rendu le dit, et l'appelant enregistre le
 * suivi des fichiers du pack quoi qu'il arrive.
 */

/** Ce que la pose du chargeur rend au compte rendu. */
export interface LoaderResult {
  /** Ce qui reste à faire ou ce qui a échoué, en clair ; `null` si rien. */
  notice: string | null;
  /** Ce qui a été posé (« Forge 47.3.0 pour Minecraft 1.20.1 »), `null` si rien. */
  installed: string | null;
}

const TIMEOUT_MS = 8000;
const USER_AGENT = "GameDashboard/GameDashboard (panel de jeu, contact@gamedashboard.fr)";

@Injectable()
export class ForgeInstallService {
  private readonly logger = new Logger(ForgeInstallService.name);

  /**
   * Cadence de l'attente du daemon. L'installeur de Forge télécharge une
   * centaine de bibliothèques : quelques minutes d'ordinaire, davantage sur un
   * node lent. Modifiable par les tests.
   */
  attente = { intervalMs: 3000, timeoutMs: 30 * 60_000 };

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(WingsClientService) private readonly wings: WingsClientService,
  ) {}

  async install(serverId: string, request: ForgeRequest): Promise<LoaderResult> {
    const name = loaderName(request.family);
    const refus = refusForge(request);
    if (refus) return { notice: refus, installed: null };

    const variables = await this.eggVariablesOf(serverId);
    const manquantes = FORGE_EGG_VARIABLES.filter((variable) => !variables.has(variable));
    if (manquantes.length > 0) {
      return {
        notice: `Ce pack demande ${name} ${request.version} pour Minecraft ${request.gameVersion}. L'egg de ce serveur ne déclare pas ${manquantes.join(", ")} : le panel ne sait pas lui faire poser ce chargeur. Basculez le serveur sur l'egg « Minecraft Java » du panel, ou installez ${name} à la main.`,
        installed: null,
      };
    }

    let target: ForgeTarget | null;
    try {
      target = resolveForgeTarget(
        request,
        parseMavenVersions(await this.fetchText(metadataUrl(request))),
      );
    } catch (error) {
      this.logger.warn(`Dépôt de ${name} illisible : ${describe(error)}`);
      return {
        notice: `Le dépôt officiel de ${name} n'a pas répondu : ${name} ${request.version} n'a pas été posé. Relancez l'installation de cette version plus tard.`,
        installed: null,
      };
    }
    if (!target) {
      return {
        notice: `${name} ${request.version} pour Minecraft ${request.gameVersion} est introuvable sur son dépôt officiel : le chargeur n'a pas été posé.`,
        installed: null,
      };
    }

    const wanted = eggSettingsFor(target);
    if (await this.alreadyInPlace(serverId, request, variables, wanted)) {
      return { notice: null, installed: `${target.label} (déjà en place)` };
    }

    const previous = new Map(
      Object.keys(wanted).map((key) => [key, variables.get(key)?.value ?? null]),
    );
    await this.writeVariables(serverId, variables, wanted);

    let issue: "ok" | "failed" | "interrupted" | "timeout" | "refused" | "busy";
    try {
      issue = await this.reinstall(serverId);
    } catch (error) {
      await this.restoreVariables(serverId, variables, previous).catch(() => undefined);
      throw error;
    }

    if (issue === "ok") return { notice: null, installed: target.label };
    if (issue === "timeout") {
      return {
        notice: `L'installation de ${target.label} par l'egg n'a pas rendu compte à temps : elle peut encore être en cours sur le node. Suivez-la dans la console du serveur avant de le démarrer.`,
        installed: null,
      };
    }

    await this.restoreVariables(serverId, variables, previous);
    const cause =
      issue === "refused"
        ? "le daemon a refusé de relancer l'installation"
        : issue === "busy"
          ? "le serveur a été pris par une autre opération (suspension, restauration ou transfert)"
          : issue === "interrupted"
            ? "le daemon a redémarré pendant l'installation"
            : "l'installeur a échoué dans le conteneur d'installation (image sans Java, réseau fermé vers le dépôt…) ; le journal d'installation du serveur en donne la cause";
    return {
      notice: `Les fichiers du pack sont posés et suivis, mais ${target.label} n'a pas pu être installé : ${cause}. Le chargeur précédent n'a pas été remplacé. Relancez l'installation de cette version une fois la cause corrigée.`,
      installed: null,
    };
  }

  /**
   * Le chargeur est-il déjà celui-là ? Une mise à jour de pack qui garde sa
   * version de Forge n'a pas à relancer une installation de plusieurs minutes.
   * Il faut que les variables le disent **et** que le pack retenu en base
   * l'ait demandé : une variable réglée à la main ne prouve pas l'installation.
   */
  private async alreadyInPlace(
    serverId: string,
    request: ForgeRequest,
    variables: Map<string, { id: string; value: string | null }>,
    wanted: Record<string, string>,
  ): Promise<boolean> {
    const same = Object.entries(wanted).every(
      ([key, value]) => (variables.get(key)?.value ?? "").trim() === value,
    );
    if (!same) return false;
    const [row] = await this.db
      .select({
        kind: serverEngines.kind,
        loader: serverEngines.loader,
        game: serverEngines.gameVersion,
      })
      .from(serverEngines)
      .where(eq(serverEngines.serverId, serverId))
      .limit(1);
    return (
      row?.kind === "pack" &&
      row.loader === `${request.family} ${request.version}` &&
      row.game === request.gameVersion
    );
  }

  /** Relance l'installation de l'egg et en attend l'issue. */
  private async reinstall(
    serverId: string,
  ): Promise<"ok" | "failed" | "interrupted" | "timeout" | "refused" | "busy"> {
    const before = await this.installState(serverId);
    // Posé ici aussi, et pas seulement par l'appelant : c'est ce que l'attente
    // guette, et personne ne doit démarrer le serveur pendant l'installeur.
    // Une suspension ou une restauration arrivée entre-temps garde la main :
    // l'installeur ne se lance pas par-dessus.
    if (!(await this.claimInstalling(serverId))) return "busy";
    try {
      // Le daemon apprend les nouvelles variables avant de lancer le script,
      // comme dans le changement d'egg de l'administration.
      await this.wings.syncServer(serverId);
      await this.wings.reinstallServer(serverId);
    } catch (error) {
      this.logger.warn(`Réinstallation refusée sur ${serverId} : ${describe(error)}`);
      return "refused";
    }

    const limite = Date.now() + this.attente.timeoutMs;
    while (Date.now() < limite) {
      await new Promise((resolve) => setTimeout(resolve, this.attente.intervalMs));
      const now = await this.installState(serverId);
      if (now.state === "installing") continue;
      // La suite de l'installation du pack (empreintes, suivi) se fait encore
      // serveur verrouillé : l'appelant lève l'état à la toute fin. Un état
      // posé par une autre opération depuis la fin de l'installeur reste.
      await this.claimInstalling(serverId);
      if (now.state === "install_failed") return "failed";
      // Une suspension, une restauration ou un transfert a pris le serveur
      // pendant l'installeur : sans compte rendu de fin, ce n'est pas un
      // redémarrage du daemon, et le message doit le dire.
      if (now.state !== null && now.installedAt === before.installedAt) return "busy";
      // Remis à zéro sans compte rendu : `resetTransientStates` au redémarrage
      // du daemon, qui n'a pas fini l'installation.
      return now.installedAt !== before.installedAt ? "ok" : "interrupted";
    }
    return "timeout";
  }

  private async installState(
    serverId: string,
  ): Promise<{ state: string | null; installedAt: string | null }> {
    const [row] = await this.db
      .select({ state: servers.state, installedAt: servers.installedAt })
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);
    return { state: row?.state ?? null, installedAt: row?.installedAt ?? null };
  }

  /**
   * Pose (ou garde) l'état « installation », et rien d'autre.
   *
   * Seulement depuis un serveur libre, déjà en installation ou dont
   * l'installeur vient d'échouer : une suspension, une restauration ou un
   * transfert décidés pendant l'attente ne sont pas écrasés, comme dans
   * `EngineService.claimInstalling`. Rend faux si l'état appartient à une autre
   * opération.
   */
  private async claimInstalling(serverId: string): Promise<boolean> {
    const claimed = await this.db
      .update(servers)
      .set({ state: "installing", updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(servers.id, serverId),
          or(isNull(servers.state), inArray(servers.state, ["installing", "install_failed"])),
        ),
      )
      .returning({ id: servers.id });
    return claimed.length > 0;
  }

  /** Les variables de l'egg du serveur, avec leur valeur propre au serveur s'il en a une. */
  private async eggVariablesOf(
    serverId: string,
  ): Promise<Map<string, { id: string; value: string | null }>> {
    const [server] = await this.db
      .select({ eggId: servers.eggId })
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);
    if (!server) return new Map();

    const declared = await this.db
      .select({ id: eggVariables.id, name: eggVariables.envVariable })
      .from(eggVariables)
      .where(
        and(
          eq(eggVariables.eggId, server.eggId),
          inArray(eggVariables.envVariable, [...FORGE_EGG_VARIABLES]),
        ),
      );
    const values = await this.db
      .select({ id: serverVariables.eggVariableId, value: serverVariables.value })
      .from(serverVariables)
      .where(eq(serverVariables.serverId, serverId));
    const byId = new Map(values.map((row) => [row.id, row.value]));

    return new Map(
      declared.map((variable) => [
        variable.name,
        { id: variable.id, value: byId.get(variable.id) ?? null },
      ]),
    );
  }

  private async writeVariables(
    serverId: string,
    variables: Map<string, { id: string; value: string | null }>,
    wanted: Record<string, string>,
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.db.transaction(async (tx) => {
      for (const [name, value] of Object.entries(wanted)) {
        const variable = variables.get(name);
        if (!variable) continue;
        await tx
          .insert(serverVariables)
          .values({ serverId, eggVariableId: variable.id, value })
          .onConflictDoUpdate({
            target: [serverVariables.serverId, serverVariables.eggVariableId],
            set: { value, updatedAt: now },
          });
      }
    });
  }

  /** Remet chaque variable comme elle était ; une absente redevient absente. */
  private async restoreVariables(
    serverId: string,
    variables: Map<string, { id: string; value: string | null }>,
    previous: Map<string, string | null>,
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.db.transaction(async (tx) => {
      for (const [name, value] of previous) {
        const variable = variables.get(name);
        if (!variable) continue;
        const where = and(
          eq(serverVariables.serverId, serverId),
          eq(serverVariables.eggVariableId, variable.id),
        );
        if (value === null) await tx.delete(serverVariables).where(where);
        else await tx.update(serverVariables).set({ value, updatedAt: now }).where(where);
      }
    });
  }

  /** L'index d'un dépôt officiel. L'adresse vient de `metadataUrl`, jamais d'ailleurs. */
  protected async fetchText(url: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/xml", "User-Agent": USER_AGENT },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`${url} a répondu ${response.status}.`);
      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
