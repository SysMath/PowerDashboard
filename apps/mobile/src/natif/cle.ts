import * as LocalAuthentication from "expo-local-authentication";
import { Platform } from "react-native";
import { CLE_VERROUILLEE, type CleAppareil, PRESENCE_REFUSEE } from "@/noyau/outils";
import CleAppareilNatif from "../../modules/cle-appareil";

/**
 * La clé d'appareil, telle que le noyau la voit.
 *
 * Sur iOS, le module natif tient tout : l'invite Face ID et le contexte qui
 * ouvre la clé. Sur Android, l'invite passe par expo-local-authentication
 * (biométrie forte ou code), qui ouvre la clé du Keystore pour sa fenêtre.
 */
async function inviter(raison: string): Promise<boolean> {
  const resultat = await LocalAuthentication.authenticateAsync({
    promptMessage: raison,
    // La biométrie faible (classe 2) n'ouvre pas une clé du Keystore.
    biometricsSecurityLevel: "strong",
    disableDeviceFallback: false,
  });
  return resultat.success;
}

/** Les erreurs natives deviennent celles que le noyau connaît. */
async function traduire<T>(appel: () => Promise<T>): Promise<T> {
  try {
    return await appel();
  } catch (error) {
    const texte = `${(error as { code?: string }).code ?? ""} ${(error as Error).message ?? ""}`;
    if (texte.includes("VERROUILLEE")) throw new Error(CLE_VERROUILLEE);
    if (texte.includes(PRESENCE_REFUSEE)) throw new Error(PRESENCE_REFUSEE);
    throw error;
  }
}

export const cle: CleAppareil = {
  creer: (alias) => CleAppareilNatif.creer(alias),
  signer: (alias, message) => traduire(() => CleAppareilNatif.signer(alias, message)),
  async signerEnPresence(alias, message, raison) {
    if (Platform.OS === "android" && !(await inviter(raison))) {
      throw new Error(PRESENCE_REFUSEE);
    }
    return traduire(() => CleAppareilNatif.signerEnPresence(alias, message, raison));
  },
  deverrouiller: (raison) =>
    Platform.OS === "android" ? inviter(raison) : CleAppareilNatif.deverrouiller(raison),
  supprimer: (alias) => CleAppareilNatif.supprimer(alias),
};

/** L'erreur dit-elle qu'il faut d'abord déverrouiller ? */
export function estVerrouillee(error: unknown): boolean {
  return error instanceof Error && error.message === CLE_VERROUILLEE;
}
