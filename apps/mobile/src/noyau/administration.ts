import {
  type AdminIncident,
  type AdminNode,
  type AdminServer,
  type AdminUser,
  type NodeStatus,
  nodeStatus,
  type UpdateStatus,
} from "@gamedashboard/contracts";

/**
 * L'administration simple de l'application (ADR 0010, lot 6) : voir ce qui
 * ne va pas, agir sur un serveur, un compte, un incident ou la mise à jour.
 * Ce qui se règle reste au navigateur.
 */

/**
 * L'état d'une machine, même règle que le web. Une machine jamais vue n'a
 * pas battu depuis l'origine des temps : elle est injoignable.
 */
export function etatMachine(
  node: Pick<AdminNode, "lastHeartbeatAt" | "maintenance">,
  maintenant: number = Date.now(),
): NodeStatus {
  return nodeStatus(
    {
      lastHeartbeatAt: node.lastHeartbeatAt ?? new Date(0).toISOString(),
      maintenance: node.maintenance,
    },
    maintenant,
  );
}

/** Un serveur qui demande quelqu'un : installation ratée ou arrêts en boucle. */
export function estEnEchec(serveur: Pick<AdminServer, "state" | "runtimeState">): boolean {
  return serveur.state === "install_failed" || serveur.runtimeState === "crash_loop";
}

export const estOuvert = (incident: Pick<AdminIncident, "resolvedAt">) =>
  incident.resolvedAt === null;

export type EtatMiseAJour = "inactive" | "en-cours" | "echec" | "disponible" | "a-jour";

/**
 * Où en est la mise à jour autonome, même lecture que la carte du web. Une
 * version déjà refusée n'est plus « disponible » : elle ne sera pas retentée.
 */
export function etatMiseAJour(statut: UpdateStatus): EtatMiseAJour {
  if (!statut.actif) return "inactive";
  if (statut.operation) return "en-cours";
  const derniere = statut.derniereRelease;
  const resultat = statut.dernierResultat;
  if (resultat && resultat.etat !== "installee" && resultat.version === derniere) return "echec";
  if (derniere !== null && derniere !== statut.enService && !statut.refusees.includes(derniere)) {
    return "disponible";
  }
  return "a-jour";
}

export interface Apercu {
  injoignables: AdminNode[];
  enEchec: AdminServer[];
  incidents: AdminIncident[];
  miseAJour: EtatMiseAJour;
}

/** Ce qui ne va pas, en une lecture : chaque ligne mène à son écran. */
export function apercu(
  lectures: {
    noeuds: readonly AdminNode[];
    serveurs: readonly AdminServer[];
    incidents: readonly AdminIncident[];
    miseAJour: UpdateStatus;
  },
  maintenant: number = Date.now(),
): Apercu {
  return {
    injoignables: lectures.noeuds.filter((node) => etatMachine(node, maintenant) === "unreachable"),
    enEchec: lectures.serveurs.filter(estEnEchec),
    incidents: lectures.incidents.filter(estOuvert),
    miseAJour: etatMiseAJour(lectures.miseAJour),
  };
}

/** Sans casse ni accents : « eloise » trouve « Éloïse ». */
const pli = (texte: string) => texte.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

function cherche<T>(liste: readonly T[], recherche: string, champs: (element: T) => string[]) {
  const mots = pli(recherche).split(/\s+/).filter(Boolean);
  if (mots.length === 0) return [...liste];
  return liste.filter((element) => {
    const texte = pli(champs(element).join(" "));
    return mots.every((mot) => texte.includes(mot));
  });
}

/** Tout le parc : nom, identifiant court, titulaire, machine, egg. */
export const filtrerServeurs = (serveurs: readonly AdminServer[], recherche: string) =>
  cherche(serveurs, recherche, (s) => [s.name, s.shortId, s.owner, s.ownerEmail, s.node, s.egg]);

export const filtrerComptes = (comptes: readonly AdminUser[], recherche: string) =>
  cherche(comptes, recherche, (c) => [c.name, c.email]);

export const MOTIF_MAX = 500;

/** Le motif d'une suspension de compte : exigé, 500 caractères au plus. */
export function refusMotif(motif: string): "vide" | "long" | null {
  const net = motif.trim();
  if (net === "") return "vide";
  return net.length > MOTIF_MAX ? "long" : null;
}
