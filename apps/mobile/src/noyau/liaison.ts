import {
  APP_REDIRECT_URI,
  type AppDeviceGrant,
  type AppPlatform,
  appLinkMessage,
} from "@gamedashboard/contracts";
import { aliasCle, type InstanceLiee, type Registre } from "./instances";
import type { CleAppareil, Hasard, Horloge, Sha256 } from "./outils";
import { creerEtat, creerPkce } from "./pkce";
import { appelerPanel, EchecPanel } from "./transport";

/**
 * La liaison d'un téléphone à un panel (ADR 0010, « Lier un panel »).
 *
 * 1. L'application ouvre la page `/auth/app/authorize` du panel dans le
 *    navigateur système, avec un défi PKCE et un `state`.
 * 2. L'utilisateur s'y connecte par le chemin habituel, puis autorise.
 * 3. Le panel renvoie vers `gamedashboard://liaison?code=…&state=…`.
 * 4. L'application crée sa clé d'appareil, signe et échange le code.
 *
 * Aucun mot de passe ne passe par l'application : elle ne voit que le code.
 */

export interface DemandeLiaison {
  url: string;
  verifier: string;
  state: string;
}

export async function preparerLiaison(input: {
  instance: InstanceLiee;
  nomAppareil: string;
  plateforme: AppPlatform;
  hasard: Hasard;
  sha256: Sha256;
}): Promise<DemandeLiaison> {
  const { verifier, challenge } = await creerPkce(input.hasard, input.sha256);
  const state = creerEtat(input.hasard);
  const query = new URLSearchParams({
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    device_name: input.nomAppareil,
    platform: input.plateforme,
    redirect_uri: APP_REDIRECT_URI,
  });
  return { url: `${input.instance.adresse}/auth/app/authorize?${query}`, verifier, state };
}

export type RetourLiaison =
  | { code: string }
  | { erreur: "refusee" | "panel" | "etat" | "invalide" };

/**
 * Lit l'adresse de retour. Un `state` différent veut dire que ce retour ne
 * répond pas à la liaison ouverte : il est écarté sans rien échanger.
 */
export function lireRetour(adresse: string, stateAttendu: string): RetourLiaison {
  let url: URL;
  try {
    url = new URL(adresse);
  } catch {
    return { erreur: "invalide" };
  }
  if (`${url.protocol}//${url.host}${url.pathname}` !== APP_REDIRECT_URI) {
    return { erreur: "invalide" };
  }
  if (url.searchParams.get("state") !== stateAttendu) return { erreur: "etat" };
  const erreur = url.searchParams.get("error");
  if (erreur === "access_denied") return { erreur: "refusee" };
  if (erreur) return { erreur: "panel" };
  const code = url.searchParams.get("code");
  return code ? { code } : { erreur: "invalide" };
}

/**
 * Échange le code contre un appareil.
 *
 * La clé d'appareil naît ici, dans le Secure Enclave ou le Keystore, et ne
 * sert qu'à cette instance. La signature demande la biométrie : c'est le seul
 * moment de la liaison où le téléphone la réclame.
 */
export async function terminerLiaison(input: {
  instance: InstanceLiee;
  code: string;
  verifier: string;
  registre: Registre;
  cle: CleAppareil;
  fetch: typeof globalThis.fetch;
  horloge: Horloge;
  versionApplication: string;
  raison: string;
}): Promise<{ instance: InstanceLiee; grant: AppDeviceGrant }> {
  const alias = aliasCle(input.instance.id);
  const publicKey = await input.cle.creer(alias);
  const signedAt = input.horloge.maintenant();
  const signature = await input.cle.signerEnPresence(
    alias,
    appLinkMessage({ code: input.code, publicKey, signedAt }),
    input.raison,
  );

  let grant: AppDeviceGrant;
  try {
    grant = await appelerPanel<AppDeviceGrant>(input.fetch, input.instance.adresse, {
      method: "POST",
      path: "/api/v1/auth/app/token",
      body: {
        code: input.code,
        codeVerifier: input.verifier,
        publicKey,
        appVersion: input.versionApplication,
        signedAt,
        signature,
      },
    });
  } catch (error) {
    // Une clé sans appareil ne sert à rien : elle ne doit pas rester.
    await input.cle.supprimer(alias);
    throw error instanceof EchecPanel ? error : new EchecPanel(0, null);
  }

  // Le secret d'abord : sans lui, l'appareil créé chez le panel serait perdu.
  await input.registre.ecrireSecret(input.instance.id, grant.deviceSecret);
  const instance: InstanceLiee = {
    ...input.instance,
    deviceId: grant.deviceId,
    deviceExpiresAt: grant.deviceExpiresAt,
    lieeLe: new Date(input.horloge.maintenant()).toISOString(),
    etat: "liee",
  };
  await input.registre.enregistrer(instance);
  return { instance, grant };
}
