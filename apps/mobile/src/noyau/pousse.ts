import type { Descripteur } from "./descripteur";
import type { InstanceLiee } from "./instances";
import type { Coffre, Horloge } from "./outils";
import { appelerPanel, EchecPanel } from "./transport";

/**
 * Recevoir les notifications d'un panel (ADR 0010, lot 4).
 *
 * Le panel dit dans son descripteur comment il pousse : `direct` (il détient
 * le jeton d'accès Expo de l'éditeur, l'application lui donne son jeton Expo),
 * `relais` (l'application inscrit son jeton chez le relais de l'éditeur et
 * ne donne au panel que la poignée qu'il rend), ou `aucune`.
 *
 * **Le relais n'est suivi que s'il est connu de l'application** : un panel
 * quelconque ne doit pas pouvoir faire porter le jeton Expo du téléphone
 * ailleurs que chez l'éditeur. La liste vient de la construction
 * (`GAMEDASHBOARD_PUSH_RELAYS`), jamais du panel.
 */

export type IssueInscription =
  /** Le panel peut joindre le téléphone. */
  | "inscrite"
  /** Rien n'a changé depuis la dernière inscription. */
  | "deja"
  /** Le panel ne pousse pas, ou le téléphone ne veut pas : rien n'est déposé. */
  | "aucune"
  /** Le panel annonce un relais que l'application ne connaît pas. */
  | "relais-inconnu"
  /** Le panel ou le relais a refusé : on retentera à la prochaine ouverture. */
  | "refusee";

/** Au-delà, l'inscription est refaite même inchangée : le panel a pu l'oublier. */
export const POUSSE_RAFRAICHIR_MS = 7 * 24 * 3600_000;

const cleMemo = (id: string) => `gd.pousse.${id}`;

interface Memo {
  deviceId: string;
  mode: "direct" | "relais";
  relais: string | null;
  jeton: string;
  le: number;
}

export interface DepsPousse {
  fetch: typeof globalThis.fetch;
  coffre: Coffre;
  horloge: Horloge;
  /** Origines des relais de l'éditeur, en https. */
  relaisConnus: readonly string[];
}

/**
 * Dépose chez le panel de quoi joindre ce téléphone, si besoin.
 *
 * `jetonExpo` est `null` quand le téléphone ne peut ou ne veut pas recevoir
 * (permission refusée, construction sans projet Expo) : ce qui avait été
 * déposé est alors retiré.
 */
export async function inscrirePousse(
  deps: DepsPousse,
  entree: {
    instance: InstanceLiee;
    descripteur: Descripteur;
    jetonExpo: string | null;
    jetonAcces: () => Promise<string>;
  },
): Promise<IssueInscription> {
  const { instance, descripteur, jetonExpo } = entree;
  if (!instance.deviceId) return "aucune";
  const memo = await lireMemo(deps.coffre, instance.id);
  const mode = descripteur.notifications;
  const relais = mode === "relais" ? descripteur.relais : null;

  if (mode === "aucune" || !jetonExpo) return retirer(deps, entree, memo);
  if (mode === "relais" && (!relais || !deps.relaisConnus.includes(relais))) {
    await retirer(deps, entree, memo);
    return "relais-inconnu";
  }

  const maintenant = deps.horloge.maintenant();
  if (
    memo &&
    memo.deviceId === instance.deviceId &&
    memo.mode === mode &&
    memo.relais === relais &&
    memo.jeton === jetonExpo &&
    maintenant - memo.le < POUSSE_RAFRAICHIR_MS
  ) {
    return "deja";
  }

  try {
    const poignee =
      mode === "relais" && relais
        ? (
            await appelerPanel<{ poignee: string }>(deps.fetch, relais, {
              method: "POST",
              path: "/api/v1/relais/poignees",
              body: { instance: descripteur.instance, jeton: jetonExpo },
            })
          ).poignee
        : jetonExpo;
    await appelerPanel(deps.fetch, instance.adresse, {
      method: "PUT",
      path: "/api/v1/auth/app/push",
      body: { mode, poignee },
      jeton: await entree.jetonAcces(),
    });
  } catch (erreur) {
    if (erreur instanceof EchecPanel) return "refusee";
    throw erreur;
  }
  const suivant: Memo = {
    deviceId: instance.deviceId,
    mode,
    relais,
    jeton: jetonExpo,
    le: maintenant,
  };
  await deps.coffre.ecrire(cleMemo(instance.id), JSON.stringify(suivant));
  return "inscrite";
}

/** Retire ce qui avait été déposé chez ce panel, s'il y a lieu. */
async function retirer(
  deps: DepsPousse,
  entree: { instance: InstanceLiee; jetonAcces: () => Promise<string> },
  memo: Memo | null,
): Promise<"aucune"> {
  if (!memo) return "aucune";
  try {
    await appelerPanel(deps.fetch, entree.instance.adresse, {
      method: "DELETE",
      path: "/api/v1/auth/app/push",
      jeton: await entree.jetonAcces(),
    });
  } catch (erreur) {
    // Le panel retentera de pousser, l'envoi échouera et il oubliera la
    // poignée de lui-même ; on retentera le retrait à la prochaine ouverture.
    if (erreur instanceof EchecPanel) return "aucune";
    throw erreur;
  }
  await deps.coffre.effacer(cleMemo(entree.instance.id));
  return "aucune";
}

async function lireMemo(coffre: Coffre, id: string): Promise<Memo | null> {
  const brut = await coffre.lire(cleMemo(id));
  if (!brut) return null;
  try {
    return JSON.parse(brut) as Memo;
  } catch {
    return null;
  }
}

/** Oublie l'inscription d'un panel retiré du téléphone. */
export function oublierPousse(coffre: Coffre, id: string): Promise<void> {
  return coffre.effacer(cleMemo(id));
}

/**
 * Les relais de l'éditeur, tels que la construction les donne : origines
 * https séparées par des virgules. Le reste est ignoré.
 */
export function lireRelaisConnus(brut: string | undefined): string[] {
  const origines = (brut ?? "").split(",").flatMap((morceau) => {
    try {
      const url = new URL(morceau.trim());
      return url.protocol === "https:" && !url.username && !url.password ? [url.origin] : [];
    } catch {
      return [];
    }
  });
  return [...new Set(origines)];
}

/**
 * Où mène le toucher d'une notification : l'instance liée qui l'a envoyée,
 * reconnue par son identifiant de panel (le jeton Expo est le même pour
 * tous). `null` si rien ne correspond : panel retiré depuis, ou données
 * inattendues.
 */
export function cibleToucher(
  donnees: unknown,
  instances: readonly InstanceLiee[],
): { instanceId: string; notification: string } | null {
  if (!donnees || typeof donnees !== "object") return null;
  const { instance, notification } = donnees as Record<string, unknown>;
  if (typeof instance !== "string" || typeof notification !== "string") return null;
  const liee = instances.find((autre) => autre.instance === instance && autre.etat === "liee");
  return liee ? { instanceId: liee.id, notification } : null;
}
