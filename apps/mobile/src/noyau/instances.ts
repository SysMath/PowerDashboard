import { versBase64Url } from "./base64";
import type { Descripteur } from "./descripteur";
import type { Coffre, Hasard } from "./outils";
import { oublierPousse } from "./pousse";

/**
 * Les panels liés, rangés chacun à part (ADR 0010, « Plusieurs instances »).
 *
 * Chaque instance a sa clé d'appareil, son secret et son nom ; rien ne passe
 * de l'une à l'autre. La liste tient dans le trousseau, comme les secrets :
 * elle dit chez qui l'on a un compte, ce qui ne regarde que le téléphone.
 */

export type EtatInstance =
  /** Liée, l'appareil existe chez le panel. */
  | "liee"
  /** Le panel répond avec un autre identifiant : réinstallé, ou le domaine a changé de mains. */
  | "a-confirmer"
  /** L'appareil a été retiré ou a expiré : il faut repasser par le navigateur. */
  | "a-relier";

export interface InstanceLiee {
  /** Identifiant local, tiré au hasard : il nomme la clé et le secret dans le trousseau. */
  id: string;
  adresse: string;
  /** L'identifiant que le panel annonçait à la liaison. */
  instance: string;
  nom: string;
  origine: string;
  deviceId: string | null;
  deviceExpiresAt: string | null;
  lieeLe: string;
  etat: EtatInstance;
}

const CLE_LISTE = "gd.instances";

export const aliasCle = (id: string) => `gd.cle.${id}`;
const cleSecret = (id: string) => `gd.secret.${id}`;

export class Registre {
  constructor(
    private readonly coffre: Coffre,
    private readonly hasard: Hasard,
  ) {}

  async lister(): Promise<InstanceLiee[]> {
    const brut = await this.coffre.lire(CLE_LISTE);
    if (!brut) return [];
    try {
      const liste: unknown = JSON.parse(brut);
      return Array.isArray(liste) ? (liste as InstanceLiee[]) : [];
    } catch {
      return [];
    }
  }

  async trouver(id: string): Promise<InstanceLiee | null> {
    return (await this.lister()).find((instance) => instance.id === id) ?? null;
  }

  /**
   * Prépare la liaison d'une adresse vérifiée.
   *
   * Une adresse déjà connue garde son identifiant local (et donc sa place dans
   * la liste) ; elle repart sans appareil jusqu'à la fin de la liaison. Une
   * instance encore liée ne passe pas par ici : l'écran l'ouvre directement.
   */
  async preparer(adresse: string, descripteur: Descripteur): Promise<InstanceLiee> {
    const existante = (await this.lister()).find((instance) => instance.adresse === adresse);
    const instance: InstanceLiee = {
      id: existante?.id ?? versBase64Url(this.hasard(12)),
      adresse,
      instance: descripteur.instance,
      nom: descripteur.nom,
      origine: descripteur.origine,
      deviceId: null,
      deviceExpiresAt: null,
      lieeLe: existante?.lieeLe ?? new Date(0).toISOString(),
      etat: "a-relier",
    };
    await this.enregistrer(instance);
    return instance;
  }

  async enregistrer(instance: InstanceLiee): Promise<void> {
    const liste = await this.lister();
    const index = liste.findIndex((autre) => autre.id === instance.id);
    if (index >= 0) liste[index] = instance;
    else liste.push(instance);
    await this.coffre.ecrire(CLE_LISTE, JSON.stringify(liste));
  }

  async retirer(id: string): Promise<void> {
    const liste = (await this.lister()).filter((instance) => instance.id !== id);
    await this.coffre.ecrire(CLE_LISTE, JSON.stringify(liste));
    await this.coffre.effacer(cleSecret(id));
    await oublierPousse(this.coffre, id);
  }

  /**
   * Compare ce que le panel répond aujourd'hui à ce qu'il annonçait à la
   * liaison. Un autre identifiant suspend la liaison : rien ne part vers ce
   * panel tant que l'utilisateur n'a pas confirmé.
   */
  async verifierIdentite(id: string, descripteur: Descripteur): Promise<InstanceLiee | null> {
    const instance = await this.trouver(id);
    if (!instance) return null;
    const suivante: InstanceLiee =
      instance.instance === descripteur.instance
        ? { ...instance, nom: descripteur.nom, origine: descripteur.origine }
        : { ...instance, etat: "a-confirmer" };
    await this.enregistrer(suivante);
    return suivante;
  }

  /**
   * L'utilisateur confirme : c'est bien son panel. L'appareil de l'ancien
   * panel n'existe pas chez le nouveau ; la clé et le secret tombent, et la
   * liaison repart du navigateur.
   */
  async accepterNouvelleIdentite(id: string, descripteur: Descripteur): Promise<void> {
    const instance = await this.trouver(id);
    if (!instance) return;
    await this.coffre.effacer(cleSecret(id));
    await this.enregistrer({
      ...instance,
      instance: descripteur.instance,
      nom: descripteur.nom,
      origine: descripteur.origine,
      deviceId: null,
      deviceExpiresAt: null,
      etat: "a-relier",
    });
  }

  async marquerARelier(id: string): Promise<void> {
    const instance = await this.trouver(id);
    if (!instance) return;
    await this.coffre.effacer(cleSecret(id));
    await this.enregistrer({
      ...instance,
      deviceId: null,
      deviceExpiresAt: null,
      etat: "a-relier",
    });
  }

  lireSecret(id: string): Promise<string | null> {
    return this.coffre.lire(cleSecret(id));
  }

  ecrireSecret(id: string, secret: string): Promise<void> {
    return this.coffre.ecrire(cleSecret(id), secret);
  }
}
