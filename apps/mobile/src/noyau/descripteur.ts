import { APP_PROTOCOL_VERSION, instanceDescriptorSchema } from "@gamedashboard/contracts";
import { comparerVersions } from "./versions";

/**
 * Reconnaître un panel avant toute connexion (ADR 0010, « Lier un panel »).
 *
 * L'application ne montre la page de connexion d'une adresse qu'après avoir lu
 * son descripteur d'instance : une adresse qui n'en sert pas un valide n'est
 * pas un panel GameDashboard, et l'on s'arrête là.
 */

export type Descripteur = {
  instance: string;
  nom: string;
  origine: string;
  version: string | null;
  notifications: "direct" | "relais" | "aucune";
  /** Le relais annoncé en mode `relais` (origine https), `null` sinon. */
  relais: string | null;
};

export type VerdictInstance =
  | { etat: "ok"; descripteur: Descripteur }
  /** Rien n'a répondu : réseau, nom inconnu, certificat refusé, délai. */
  | { etat: "injoignable" }
  /** Le panel répond qu'il est momentanément muet (503). */
  | { etat: "indisponible" }
  /** L'adresse répond, mais pas comme un panel GameDashboard. */
  | { etat: "pas-un-panel" }
  /** Le panel parle un protocole plus ancien que celui de l'application. */
  | { etat: "panel-trop-ancien" }
  /** Le panel demande une version plus récente de l'application. */
  | { etat: "application-trop-ancienne"; minimale: string };

export const CHEMIN_DESCRIPTEUR = "/.well-known/gamedashboard";

export async function lireInstance(
  adresse: string,
  options: { fetch: typeof globalThis.fetch; versionApplication: string; delaiMs?: number },
): Promise<VerdictInstance> {
  const controleur = new AbortController();
  const minuterie = setTimeout(() => controleur.abort(), options.delaiMs ?? 10_000);
  let reponse: Response;
  let corps: unknown;
  try {
    reponse = await options.fetch(`${adresse}${CHEMIN_DESCRIPTEUR}`, {
      headers: { Accept: "application/json" },
      signal: controleur.signal,
    });
    corps = await reponse.json().catch(() => null);
  } catch {
    return { etat: "injoignable" };
  } finally {
    clearTimeout(minuterie);
  }

  if (reponse.status === 503) return { etat: "indisponible" };
  // Une redirection vers un autre domaine ne fait pas de cette adresse un
  // panel : c'est l'autre domaine qui aurait répondu.
  if (!reponse.ok || (reponse.url && new URL(reponse.url).origin !== adresse)) {
    return { etat: "pas-un-panel" };
  }
  return juger(corps, options.versionApplication);
}

/** Le jugement seul, sur un corps déjà lu. */
export function juger(corps: unknown, versionApplication: string): VerdictInstance {
  const lu = instanceDescriptorSchema.safeParse(corps);
  if (!lu.success) return { etat: "pas-un-panel" };
  const d = lu.data;
  if (d.api < APP_PROTOCOL_VERSION) return { etat: "panel-trop-ancien" };
  if (d.api > APP_PROTOCOL_VERSION) {
    return { etat: "application-trop-ancienne", minimale: d.version_app_minimale };
  }
  if (comparerVersions(versionApplication, d.version_app_minimale) < 0) {
    return { etat: "application-trop-ancienne", minimale: d.version_app_minimale };
  }
  return {
    etat: "ok",
    descripteur: {
      instance: d.instance,
      nom: d.nom,
      origine: new URL(d.origine).origin,
      version: d.version,
      // Un mode qu'une version future ajouterait vaut « aucune » ici :
      // l'application relève alors la cloche à l'ouverture.
      notifications:
        d.notifications === "direct" || d.notifications === "relais" ? d.notifications : "aucune",
      relais: d.notifications === "relais" ? origineHttps(d.relais) : null,
    },
  };
}

/** L'origine d'une adresse en https://, ou `null`. */
function origineHttps(adresse: string | undefined): string | null {
  if (!adresse) return null;
  try {
    const url = new URL(adresse);
    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}
