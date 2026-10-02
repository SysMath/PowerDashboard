/**
 * Base64 et base64url, sans dépendre de `Buffer` (absent de React Native) ni
 * de `btoa` (qui ne prend que du latin-1).
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function versBase64(octets: Uint8Array): string {
  let sortie = "";
  for (let i = 0; i < octets.length; i += 3) {
    const a = octets[i] ?? 0;
    const b = octets[i + 1];
    const c = octets[i + 2];
    const triplet = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    sortie += ALPHABET[(triplet >> 18) & 63];
    sortie += ALPHABET[(triplet >> 12) & 63];
    sortie += b === undefined ? "=" : ALPHABET[(triplet >> 6) & 63];
    sortie += c === undefined ? "=" : ALPHABET[triplet & 63];
  }
  return sortie;
}

/** Base64url sans remplissage (RFC 4648 §5), celle du PKCE. */
export function versBase64Url(octets: Uint8Array): string {
  return versBase64(octets).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function depuisBase64(texte: string): Uint8Array {
  const propre = texte.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const octets: number[] = [];
  let tampon = 0;
  let bits = 0;
  for (const caractere of propre) {
    const valeur = ALPHABET.indexOf(caractere);
    if (valeur < 0) throw new Error("Base64 invalide.");
    tampon = (tampon << 6) | valeur;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      octets.push((tampon >> bits) & 0xff);
    }
  }
  return Uint8Array.from(octets);
}

/** Hexadécimal en minuscules, la forme de `secretSha256` dans le message signé. */
export function versHex(octets: Uint8Array): string {
  return Array.from(octets, (octet) => octet.toString(16).padStart(2, "0")).join("");
}
