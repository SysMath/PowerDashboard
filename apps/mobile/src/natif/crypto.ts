import * as Crypto from "expo-crypto";
import type { Hasard, Sha256 } from "@/noyau/outils";

/** Le générateur cryptographique du système (SecRandomCopyBytes, SecureRandom). */
export const hasard: Hasard = (taille) => Crypto.getRandomBytes(taille);

export const sha256: Sha256 = async (texte) =>
  new Uint8Array(
    await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, new TextEncoder().encode(texte)),
  );
