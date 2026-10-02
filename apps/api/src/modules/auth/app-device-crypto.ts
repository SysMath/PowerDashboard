import { createHash, createPublicKey, type KeyObject, verify } from "node:crypto";

/**
 * Cryptographie de l'appareil mobile (ADR 0010).
 *
 * Le téléphone garde une clé P-256 non exportable (Secure Enclave, Android
 * Keystore) et signe en ECDSA / SHA-256. Le panel n'en connaît que la partie
 * publique, et ne fait ici que vérifier.
 */

/**
 * En-tête SPKI DER d'une clé publique P-256, à placer devant le point.
 *
 * iOS exporte la clé publique en point brut X9.63 (65 octets, `0x04 || X || Y`),
 * Android en SPKI : accepter les deux évite à l'application de réécrire de
 * l'ASN.1 à la main.
 */
const P256_SPKI_HEADER = Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex");

function decodeBase64(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/**
 * Lit une clé publique d'appareil, ou `null` si ce n'en est pas une.
 *
 * Seule la courbe P-256 passe : une clé RSA ou une autre courbe n'est pas ce
 * que produit un trousseau matériel de téléphone, et l'accepter ouvrirait
 * des signatures plus faibles qu'annoncé.
 */
export function importDevicePublicKey(encoded: string): KeyObject | null {
  try {
    const bytes = decodeBase64(encoded);
    const der =
      bytes.length === 65 && bytes[0] === 0x04 ? Buffer.concat([P256_SPKI_HEADER, bytes]) : bytes;
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ec") return null;
    if (key.asymmetricKeyDetails?.namedCurve !== "prime256v1") return null;
    return key;
  } catch {
    return null;
  }
}

/** Forme canonique d'une clé acceptée : SPKI DER en base64, celle qu'on garde en base. */
export function canonicalPublicKey(key: KeyObject): string {
  return key.export({ format: "der", type: "spki" }).toString("base64");
}

/**
 * Vérifie une signature ECDSA P-256 / SHA-256 (DER, comme la produisent les
 * deux trousseaux). Toute erreur de lecture vaut refus.
 */
export function verifyDeviceSignature(
  publicKey: string,
  message: string,
  signature: string,
): boolean {
  const key = importDevicePublicKey(publicKey);
  if (!key) return false;
  try {
    return verify(
      "sha256",
      Buffer.from(message, "utf8"),
      { key, dsaEncoding: "der" },
      decodeBase64(signature),
    );
  } catch {
    return false;
  }
}

/** Défi PKCE S256 d'un vérificateur (RFC 7636, §4.2). */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/** Une signature horodatée est-elle assez récente, dans un sens comme dans l'autre ? */
export function freshSignature(signedAt: number, now: number, skewMs: number): boolean {
  return Math.abs(now - signedAt) <= skewMs;
}
