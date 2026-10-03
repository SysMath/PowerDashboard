import { versBase64Url } from "./base64";
import type { Hasard, Sha256 } from "./outils";

/**
 * PKCE (RFC 7636), méthode S256.
 *
 * Le vérificateur ne quitte jamais l'application ; le panel ne voit que son
 * condensat. Un code de liaison intercepté (une autre application qui aurait
 * revendiqué le schéma `gamedashboard://`) ne s'échange donc pas.
 */
export async function creerPkce(
  hasard: Hasard,
  sha256: Sha256,
): Promise<{ verifier: string; challenge: string }> {
  // 32 octets : 43 caractères en base64url, le minimum de la RFC.
  const verifier = versBase64Url(hasard(32));
  return { verifier, challenge: versBase64Url(await sha256(verifier)) };
}

/** `state` : relu au retour, pour ne reprendre que la liaison qu'on a ouverte. */
export function creerEtat(hasard: Hasard): string {
  return versBase64Url(hasard(24));
}
