/**
 * Ce que le noyau demande au téléphone, sans en dépendre.
 *
 * Le noyau est du TypeScript pur, testé sous Node : il reçoit ces outils au
 * lieu d'importer les modules d'Expo. L'application branche les vrais
 * (`src/natif`), les tests des équivalents de Node.
 */

/** Octets tirés par le générateur cryptographique du système. */
export type Hasard = (taille: number) => Uint8Array;

/** SHA-256 d'un texte UTF-8. */
export type Sha256 = (texte: string) => Promise<Uint8Array>;

/**
 * Le trousseau du téléphone (Keychain, Keystore) : valeurs courtes, jamais
 * sauvegardées hors de l'appareil.
 */
export interface Coffre {
  lire(cle: string): Promise<string | null>;
  ecrire(cle: string, valeur: string): Promise<void>;
  effacer(cle: string): Promise<void>;
}

/**
 * La clé d'appareil d'une instance : P-256, née dans le Secure Enclave ou le
 * Keystore, jamais exportable.
 */
export interface CleAppareil {
  /** Crée la clé (en remplaçant une ancienne) et rend sa partie publique en base64. */
  creer(alias: string): Promise<string>;
  /** Signe (ECDSA, SHA-256, DER en base64). Lève `VERROUILLEE` si le téléphone doit être déverrouillé. */
  signer(alias: string, message: string): Promise<string>;
  /**
   * Signe après une confirmation de présence fraîche (biométrie ou code), quel
   * que soit l'état du déverrouillage : c'est le geste lourd qui la demande.
   */
  signerEnPresence(alias: string, message: string, raison: string): Promise<string>;
  /** Demande la biométrie ou le code pour ouvrir la clé le temps d'une session. */
  deverrouiller(raison: string): Promise<boolean>;
  supprimer(alias: string): Promise<void>;
}

/** Erreur levée par `CleAppareil.signer` quand il faut d'abord déverrouiller. */
export const CLE_VERROUILLEE = "VERROUILLEE";

/** La biométrie ou le code a été refusé ou annulé : rien n'est parti. */
export const PRESENCE_REFUSEE = "PRESENCE_REFUSEE";

export interface Horloge {
  maintenant(): number;
}
