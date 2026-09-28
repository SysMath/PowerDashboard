import { createHmac, timingSafeEqual } from "node:crypto";
import { copyFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { UpdateStatus } from "@gamedashboard/contracts";
import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import { battre } from "../../common/background-tick";
import { ActivityService } from "../activity/activity.service";
import { fetchLatestRelease, type PublishedRelease, REPOSITORY_PATTERN } from "./github-releases";
import { cleanupVersions, downloadRelease, extractRelease, rehearse } from "./update-installer";
import {
  compareReleaseVersions,
  readState,
  requestRestart,
  type UpdateState,
  updateState,
} from "./update-state";

/** Vérification régulière : la limite anonyme de GitHub est partagée avec les voisins. */
const VERIFICATION_MS = 30 * 60_000;
/** Maintien en éveil : Passenger arrête une application restée quelques minutes sans requête. */
const EVEIL_MS = 60_000;
/** Délai laissé à la nouvelle version pour répondre par l'adresse publique. */
const CONFIRMATION_MS = 150_000;
/** Écart toléré entre l'horodatage d'un signal et l'horloge de l'hébergement. */
const SIGNAL_FENETRE_MS = 5 * 60_000;

/**
 * Mise à jour autonome, pour un hébergement sans outils (cPanel, Passenger).
 *
 * Le panel s'y met à jour de lui-même, depuis les releases GitHub du dépôt :
 *
 * 1. il lit la dernière release (toutes les trente minutes, sur signal du
 *    workflow de release, ou à la demande de l'administration) ;
 * 2. il en télécharge l'archive autonome et la vérifie contre son empreinte ;
 * 3. il n'en extrait que la nouvelle version, dans un dossier neuf ;
 * 4. il la **répète** : démarrée à part sur des ports locaux, elle joue ses
 *    migrations et doit répondre — sinon elle est mise de côté, et rien n'a
 *    bougé pour les visiteurs ;
 * 5. il bascule `etat.json` et demande à Passenger de relancer les deux
 *    applications ;
 * 6. la nouvelle version, à son démarrage, vérifie qu'elle répond par
 *    l'adresse publique, et confirme — ou revient d'elle-même à la
 *    précédente et se met de côté. Le lanceur de Passenger tient le dernier
 *    filet : une API qui redémarre sans jamais confirmer est remplacée par
 *    la précédente (infra/cpanel/lanceur.cjs).
 *
 * Inactif partout ailleurs : il faut `GAMEDASHBOARD_RACINE` et
 * `GAMEDASHBOARD_VERSION`, que seul le démarrage autonome pose
 * (infra/cpanel/api.cjs). Sur un serveur à soi, la mise à jour reste celle
 * de `gamedashboard update`.
 */
@Injectable()
export class UpdateService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(UpdateService.name);
  private readonly timers: NodeJS.Timeout[] = [];
  private enCours: Promise<void> | null = null;
  private dernierSignal = 0;
  /** Délai laissé à la nouvelle version pour répondre ; réduit par les tests. */
  confirmationMs = CONFIRMATION_MS;
  /** Pause entre deux essais de l'adresse publique. */
  pauseMs = 5_000;

  constructor(@Inject(ActivityService) private readonly activity: ActivityService) {}

  private get root(): string | null {
    return process.env.GAMEDASHBOARD_RACINE ?? null;
  }

  private get version(): string | null {
    return process.env.GAMEDASHBOARD_VERSION ?? null;
  }

  get enabled(): boolean {
    return (
      Boolean(this.root && this.version) &&
      process.env.GAMEDASHBOARD_ESSAI !== "1" &&
      process.env.GAMEDASHBOARD_MISE_A_JOUR !== "0"
    );
  }

  onApplicationBootstrap(): void {
    const root = this.root;
    if (!this.enabled || !root) return;

    // Première installation : rien n'est encore écrit, la version qui
    // démarre est celle en service.
    updateState(root, (state) => {
      state.enService ??= this.version ?? undefined;
    });

    const planifier = (label: string, tache: () => Promise<void>, delai: number) =>
      setTimeout(() => battre(this.logger, label, tache), delai).unref();

    planifier("confirmation de la mise à jour", () => this.confirmIfPending(), 5_000);
    planifier("recherche de mise à jour", () => this.check(), 60_000);
    this.timers.push(
      setInterval(
        () => battre(this.logger, "recherche de mise à jour", () => this.check()),
        VERIFICATION_MS,
      ),
      setInterval(() => battre(this.logger, "maintien en éveil", () => this.wake()), EVEIL_MS),
    );
    for (const timer of this.timers) timer.unref();
  }

  onModuleDestroy(): void {
    for (const timer of this.timers) clearInterval(timer);
  }

  /** L'état lu par l'administration. */
  status(): UpdateStatus {
    const root = this.root;
    if (!this.enabled || !root || !this.version) return { actif: false };
    const state = readState(root);
    return {
      actif: true,
      version: this.version,
      enService: state.enService ?? this.version,
      precedente: state.precedente ?? null,
      derniereVerification: state.derniereVerification ?? null,
      derniereRelease: state.derniereRelease?.version ?? null,
      operation: state.operation ?? null,
      dernierResultat: state.dernierResultat ?? null,
      refusees: state.refusees ?? [],
    };
  }

  /**
   * Cherche une release plus récente et l'installe. Une seule à la fois :
   * un second appel attend la première.
   */
  check(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    this.enCours ??= this.checkOnce().finally(() => {
      this.enCours = null;
    });
    return this.enCours;
  }

  /**
   * Signal du workflow de release, signé : « une version vient de paraître ».
   *
   * La signature porte sur l'horodatage et la version ; un signal ancien ou
   * mal signé est ignoré. Même valide, il ne fait que déclencher une
   * vérification auprès de GitHub : c'est la release qui décide, jamais le
   * contenu du signal. Faux si le signal est refusé.
   */
  signal(horodatage: string, version: string, signature: string): boolean {
    const secret = process.env.GAMEDASHBOARD_SIGNAL_SECRET;
    if (!this.enabled || !secret || secret.length < 32) return false;

    const moment = Number(horodatage) * 1000;
    if (!Number.isFinite(moment) || Math.abs(Date.now() - moment) > SIGNAL_FENETRE_MS) {
      return false;
    }
    const attendue = createHmac("sha256", secret).update(`${horodatage}.${version}`).digest("hex");
    const recue = signature.replace(/^sha256=/, "");
    const a = Buffer.from(attendue, "utf8");
    const b = Buffer.from(recue, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return false;

    // Un signal rejoué en rafale ne relance pas la vérification.
    if (Date.now() - this.dernierSignal > 30_000) {
      this.dernierSignal = Date.now();
      void battre(this.logger, "mise à jour sur signal", () => this.check());
    }
    return true;
  }

  /**
   * Revient à la version précédente, à la demande de l'administration. La
   * version quittée est mise de côté : sans cela, la vérification suivante
   * la réinstallerait.
   */
  rollback(): UpdateStatus {
    const root = this.root;
    if (!this.enabled || !root) throw new ConflictException("Mise à jour autonome inactive.");
    if (this.enCours) throw new ConflictException("Une mise à jour est en cours.");
    const { precedente } = readState(root);
    if (!precedente || !existsSync(join(root, "versions", precedente))) {
      throw new ConflictException("Aucune version précédente vers laquelle revenir.");
    }

    updateState(root, (state) => {
      const quittee = state.enService ?? this.version ?? "";
      this.refuse(state, quittee, "Retour à la version précédente demandé par l'administration.");
      state.enService = precedente;
      state.precedente = null;
      state.bascule = null;
    });
    requestRestart(root);
    void this.wake();
    return this.status();
  }

  private async checkOnce(): Promise<void> {
    const root = this.root;
    if (!root || !this.version) return;
    const state = readState(root);
    // Une bascule attend la confirmation de la nouvelle version.
    if (state.bascule && !state.bascule.confirmee) return;

    const depot = this.repository();
    if (!depot) {
      // Pas de repli sur un nom écrit en dur : ce serait celui d'un autre
      // dépôt, ou d'un nom qui ne mène plus nulle part.
      updateState(root, (s) => {
        s.derniereVerification = new Date().toISOString();
        s.dernierResultat = {
          etat: "erreur",
          version: this.version ?? "",
          message:
            "Dépôt des releases inconnu : GAMEDASHBOARD_DEPOT n'est pas posé, ou n'a pas la forme propriétaire/dépôt (ligne depot= du fichier RELEASE, ou env/api.env).",
          date: new Date().toISOString(),
        };
      });
      return;
    }

    const derniere = await fetchLatestRelease(depot, {
      etag: state.etagRelease,
      apiBase: process.env.GAMEDASHBOARD_GITHUB_API,
      userAgent: `GameDashboard/${this.version}`,
    });
    const apres = updateState(root, (s) => {
      s.enService ??= this.version ?? undefined;
      s.derniereVerification = new Date().toISOString();
      if (derniere.kind === "unchanged") return;
      s.etagRelease = derniere.etag;
      s.derniereRelease = derniere.kind === "found" ? derniere.release : null;
    });

    const release = apres.derniereRelease;
    const enService = apres.enService ?? this.version;
    if (!release || compareReleaseVersions(release.version, enService) <= 0) return;
    if (apres.refusees?.includes(release.version)) return;

    const publieSous = release.repository ?? depot;
    if (publieSous !== depot) {
      this.logger.warn(
        `Le dépôt ${depot} s'appelle désormais ${publieSous} : la release y est lue.`,
      );
    }
    await this.install(root, release, publieSous);
  }

  private async install(root: string, release: PublishedRelease, depot: string): Promise<void> {
    const etape = (nom: NonNullable<UpdateState["operation"]>["etape"]) =>
      updateState(root, (state) => {
        state.operation = {
          etape: nom,
          version: release.version,
          depuis: new Date().toISOString(),
        };
      });
    this.logger.log(`Mise à jour vers ${release.version}`);

    try {
      etape("telechargement");
      const archive = await downloadRelease(
        release,
        join(root, "telechargements"),
        depot,
        process.env.GAMEDASHBOARD_TELECHARGEMENTS,
      );
      etape("extraction");
      await extractRelease(archive, root, release.version);
    } catch (error) {
      // Réseau, GitHub, disque : rien de la version n'est en cause, la
      // prochaine vérification réessaie.
      updateState(root, (state) => {
        state.operation = null;
        state.dernierResultat = {
          etat: "erreur",
          version: release.version,
          message: message(error),
          date: new Date().toISOString(),
        };
      });
      throw error;
    }

    try {
      etape("repetition");
      await rehearse(root, release.version);
    } catch (error) {
      updateState(root, (state) => {
        state.operation = null;
        this.refuse(state, release.version, message(error));
      });
      await cleanupVersions(root, [readState(root).enService, readState(root).precedente]);
      await this.trace({
        event: "admin.update_refused",
        version: release.version,
        raison: message(error),
      });
      return;
    }

    etape("bascule");
    updateState(root, (state) => {
      state.precedente = state.enService ?? this.version;
      state.enService = release.version;
      state.bascule = {
        version: release.version,
        depuis: new Date().toISOString(),
        demarrages: 0,
        confirmee: false,
      };
      state.operation = null;
    });
    requestRestart(root);
    // La requête réveille l'interface, qui appelle l'API : Passenger relance
    // les deux sur la nouvelle version, qui confirmera d'elle-même.
    void this.wake();
  }

  /**
   * À son démarrage, la nouvelle version vérifie qu'elle répond par
   * l'adresse publique — interface comprise — et confirme la bascule, ou
   * revient à la précédente.
   */
  private async confirmIfPending(): Promise<void> {
    const root = this.root;
    const version = this.version;
    if (!root || !version) return;
    const { bascule } = readState(root);
    if (!bascule || bascule.confirmee || bascule.version !== version) return;

    const reponse = await this.answersPublicly(this.confirmationMs);
    if (reponse === true) {
      const state = updateState(root, (s) => {
        s.bascule = null;
        s.dernierResultat = { etat: "installee", version, date: new Date().toISOString() };
      });
      // Le lanceur de la version confirmée devient celui de l'hébergement.
      const lanceur = join(root, "versions", version, "demarrage", "lanceur.cjs");
      if (existsSync(lanceur)) {
        const provisoire = join(root, "passenger", "lanceur.cjs.nouveau");
        copyFileSync(lanceur, provisoire);
        renameSync(provisoire, join(root, "passenger", "lanceur.cjs"));
      }
      await cleanupVersions(root, [state.enService, state.precedente]);
      await this.trace({ event: "admin.update_installed", version });
      return;
    }

    updateState(root, (s) => {
      this.refuse(s, version, reponse);
      if (s.precedente) {
        s.enService = s.precedente;
        s.precedente = null;
      }
      s.bascule = null;
    });
    requestRestart(root);
    void this.wake();
    await this.trace({ event: "admin.update_refused", version, raison: reponse });
  }

  /** Vrai si l'adresse publique répond « ok » ; sinon, la raison. */
  private async answersPublicly(delai: number): Promise<true | string> {
    const origine = process.env.PANEL_ORIGIN;
    if (!origine) return true;
    const limite = Date.now() + delai;
    let derniere = "aucune réponse";
    while (Date.now() < limite) {
      try {
        const reponse = await fetch(`${origine}/api/health`, {
          signal: AbortSignal.timeout(20_000),
        });
        const corps = (await reponse.json().catch(() => ({}))) as { status?: string };
        if (reponse.ok && corps.status === "ok") return true;
        derniere = `${reponse.status} ${corps.status ?? ""}`.trim();
      } catch (error) {
        derniere = message(error);
      }
      await new Promise((fin) => setTimeout(fin, this.pauseMs));
    }
    return `La nouvelle version ne répond pas par ${origine} (${derniere}).`;
  }

  /**
   * Une requête à l'adresse publique : l'interface la reçoit et interroge
   * l'API. Toutes deux restent éveillées, et Passenger applique à cette
   * occasion une relance demandée.
   */
  private async wake(): Promise<void> {
    const origine = process.env.PANEL_ORIGIN;
    if (!origine) return;
    await fetch(`${origine}/api/health`, { signal: AbortSignal.timeout(20_000) }).catch(() => {});
  }

  private refuse(state: UpdateState, version: string, raison: string): void {
    state.refusees = [...new Set([...(state.refusees ?? []), version])];
    state.dernierResultat = {
      etat: "refusee",
      version,
      message: raison,
      date: new Date().toISOString(),
    };
  }

  /**
   * Le dépôt des releases : celui dont la version en service a été construite
   * (ligne `depot=` de son RELEASE, que `env/api.env` peut remplacer).
   */
  private repository(): string | null {
    const depot = process.env.GAMEDASHBOARD_DEPOT?.trim();
    return depot && REPOSITORY_PATTERN.test(depot) ? depot : null;
  }

  private async trace({
    event,
    version,
    raison,
  }: {
    event: string;
    version: string;
    raison?: string;
  }): Promise<void> {
    await this.activity
      .record({
        event,
        serverId: null,
        actorId: null,
        actorType: "system",
        actorLabel: "Mise à jour automatique",
        ip: null,
        userAgent: null,
        properties: { version, ...(raison ? { raison: raison.slice(0, 500) } : {}) },
      })
      .catch((error: unknown) => this.logger.error(`Journal non écrit : ${message(error)}`));
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
