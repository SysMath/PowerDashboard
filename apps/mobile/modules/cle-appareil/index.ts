import { requireNativeModule } from "expo";

/**
 * La clé d'appareil, côté natif (ADR 0010).
 *
 * Une clé P-256 par panel lié, née dans le Secure Enclave (iOS) ou le Keystore
 * Android (StrongBox quand il existe), jamais exportable. Elle ne signe qu'après
 * la biométrie ou le code du téléphone : une fois ouverte, pendant
 * `FENETRE_DEVERROUILLAGE_S` ; ou sur le moment, pour un geste lourd.
 *
 * Signatures ECDSA / SHA-256 en DER, clé publique en base64 : le point brut de
 * 65 octets sur iOS, le SPKI sur Android. Le panel accepte les deux.
 */
interface CleAppareilNatif {
  creer(alias: string): Promise<string>;
  signer(alias: string, message: string): Promise<string>;
  /** iOS seulement : Android passe par expo-local-authentication. */
  deverrouiller(raison: string): Promise<boolean>;
  signerEnPresence(alias: string, message: string, raison: string): Promise<string>;
  supprimer(alias: string): Promise<void>;
}

/** Le déverrouillage vaut quinze minutes, la durée d'un jeton d'accès. */
export const FENETRE_DEVERROUILLAGE_S = 15 * 60;

export default requireNativeModule<CleAppareilNatif>("CleAppareil");
