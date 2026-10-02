import {
  type ClientServerView,
  closedSignals,
  nodeOutageBlock,
  type ServerBlock,
  serverBlock,
} from "@gamedashboard/contracts";

/**
 * Ce que l'écran d'un serveur peut proposer, avec les règles du web : la
 * machine muette prime, puis l'état de gestion (installation, transfert,
 * suspension), puis l'état du conteneur.
 */
export function lireServeur(
  serveur: ClientServerView,
  etatDirect: string | null,
): {
  blocage: ServerBlock | null;
  /** État du conteneur ; `null` quand on ne sait pas (machine muette, blocage). */
  etat: string | null;
  fermes: { start: boolean; restart: boolean; stop: boolean; kill: boolean };
} {
  const blocage = nodeOutageBlock(serveur.nodeUnreachableSince) ?? serverBlock(serveur.state);
  // Une machine muette ne dit rien du serveur : « hors ligne » serait une
  // affirmation fausse. On ne sait pas, et on le dit.
  const etat = blocage ? null : (etatDirect ?? serveur.runtimeState ?? "offline");
  return {
    blocage,
    etat,
    fermes: closedSignals(etat ?? "offline", { blocked: blocage !== null }),
  };
}
