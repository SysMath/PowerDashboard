import {
  APP_PRESENCE_HEADER,
  type AppDeviceGrant,
  appPresenceMessage,
  appRefreshMessage,
} from "@gamedashboard/contracts";
import { versHex } from "./base64";
import { aliasCle, type InstanceLiee, type Registre } from "./instances";
import type { CleAppareil, Horloge, Sha256 } from "./outils";
import { appelerPanel, EchecPanel } from "./transport";

/** L'appareil n'existe plus chez le panel (retiré, expiré, rejoué) : il faut relier. */
export class LiaisonPerdue extends Error {
  constructor() {
    super("Ce téléphone n'est plus lié à ce panel.");
    this.name = "LiaisonPerdue";
  }
}

/** Marge avant l'échéance du jeton : on renouvelle un peu avant, pas après le refus. */
const MARGE_MS = 60_000;

/**
 * Le jeton d'accès d'une instance, et son renouvellement.
 *
 * Le jeton ne vit qu'en mémoire, quinze minutes. Le renouvellement présente le
 * secret d'appareil, signé par la clé du téléphone, et range aussitôt le
 * nouveau secret : l'ancien ne vaut plus rien, et le présenter de nouveau
 * retirerait l'appareil. **Un seul renouvellement à la fois** : deux écrans
 * qui le demanderaient ensemble présenteraient deux fois le même secret, et
 * le second passerait pour un vol.
 */
export class SessionAppareil {
  private acces: { jeton: string; expireA: number } | null = null;
  private enCours: Promise<string> | null = null;

  constructor(
    private readonly deps: {
      instanceId: string;
      registre: Registre;
      cle: CleAppareil;
      fetch: typeof globalThis.fetch;
      horloge: Horloge;
      sha256: Sha256;
      versionApplication: string;
    },
  ) {}

  /** Un jeton valable, renouvelé s'il approche de son échéance. */
  async jeton(): Promise<string> {
    if (this.acces && this.acces.expireA - MARGE_MS > this.deps.horloge.maintenant()) {
      return this.acces.jeton;
    }
    return this.renouveler();
  }

  /** Force un renouvellement (après un 401), partagé entre les appels simultanés. */
  renouveler(): Promise<string> {
    this.enCours ??= this.renouvelerVraiment().finally(() => {
      this.enCours = null;
    });
    return this.enCours;
  }

  /** À l'arrière-plan : le jeton quitte la mémoire, la biométrie le rendra. */
  oublier(): void {
    this.acces = null;
  }

  /** Reprend le jeton que la liaison vient de donner, sans renouvellement. */
  adopter(grant: AppDeviceGrant): void {
    this.acces = { jeton: grant.accessToken, expireA: Date.parse(grant.accessExpiresAt) };
  }

  /**
   * L'en-tête de confirmation de présence pour un geste lourd : un défi du
   * panel, signé après la biométrie, lié au verbe et au chemin exacts.
   */
  async presence(method: string, path: string, raison: string): Promise<Record<string, string>> {
    const instance = await this.instance();
    const { challenge } = await appelerPanel<{ challenge: string }>(
      this.deps.fetch,
      instance.adresse,
      { method: "POST", path: "/api/v1/auth/app/challenge", jeton: await this.jeton() },
    );
    const signature = await this.deps.cle.signerEnPresence(
      aliasCle(instance.id),
      appPresenceMessage({ deviceId: instance.deviceId ?? "", challenge, method, path }),
      raison,
    );
    return { [APP_PRESENCE_HEADER]: `${challenge}.${signature}` };
  }

  /**
   * Délier ce téléphone : le panel retire l'appareil, puis la clé et le
   * secret quittent le trousseau. Si le panel ne répond pas, le téléphone
   * oublie quand même : l'appareil expirera de lui-même, et reste retirable
   * depuis Compte › Sécurité.
   */
  async delier(): Promise<void> {
    const instance = await this.instance().catch(() => null);
    if (instance) {
      try {
        await appelerPanel(this.deps.fetch, instance.adresse, {
          method: "DELETE",
          path: "/api/v1/auth/app/device",
          jeton: await this.jeton(),
        });
      } catch {
        // Voir plus haut : oublier localement reste le bon geste.
      }
    }
    this.acces = null;
    await this.deps.cle.supprimer(aliasCle(this.deps.instanceId));
    await this.deps.registre.retirer(this.deps.instanceId);
  }

  private async instance(): Promise<InstanceLiee & { deviceId: string }> {
    const instance = await this.deps.registre.trouver(this.deps.instanceId);
    if (instance?.etat !== "liee" || !instance.deviceId) throw new LiaisonPerdue();
    return { ...instance, deviceId: instance.deviceId };
  }

  private async renouvelerVraiment(): Promise<string> {
    const instance = await this.instance();
    const secret = await this.deps.registre.lireSecret(instance.id);
    if (!secret) {
      await this.perdre();
      throw new LiaisonPerdue();
    }

    const signedAt = this.deps.horloge.maintenant();
    const secretSha256 = versHex(await this.deps.sha256(secret));
    // Peut lever « VERROUILLEE » : l'écran demande alors la biométrie.
    const signature = await this.deps.cle.signer(
      aliasCle(instance.id),
      appRefreshMessage({ deviceId: instance.deviceId, secretSha256, signedAt }),
    );

    let grant: AppDeviceGrant;
    try {
      grant = await appelerPanel<AppDeviceGrant>(this.deps.fetch, instance.adresse, {
        method: "POST",
        path: "/api/v1/auth/app/refresh",
        body: {
          deviceId: instance.deviceId,
          deviceSecret: secret,
          appVersion: this.deps.versionApplication,
          signedAt,
          signature,
        },
      });
    } catch (error) {
      if (error instanceof EchecPanel && error.status === 401) {
        await this.perdre();
        throw new LiaisonPerdue();
      }
      throw error;
    }

    await this.deps.registre.ecrireSecret(instance.id, grant.deviceSecret);
    await this.deps.registre.enregistrer({ ...instance, deviceExpiresAt: grant.deviceExpiresAt });
    this.adopter(grant);
    return grant.accessToken;
  }

  private async perdre(): Promise<void> {
    this.acces = null;
    await this.deps.cle.supprimer(aliasCle(this.deps.instanceId));
    await this.deps.registre.marquerARelier(this.deps.instanceId);
  }
}
