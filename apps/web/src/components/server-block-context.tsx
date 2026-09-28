"use client";

import {
  backupDeletionBlocked,
  nodeOutageBlock,
  reinstallBlocked,
  type ServerBlock,
  serverBlock,
} from "@gamedashboard/contracts";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { ServerBlockNotice } from "./server-block-notice";

/**
 * Le blocage du serveur regardé, partagé par toutes ses pages.
 *
 * Il vient du layout, qui lit déjà la fiche du serveur pour la barre latérale :
 * aucune page n'a besoin de la redemander, et surtout aucune ne peut se
 * tromper de source. Une lecture par écran donnerait sept réponses qui
 * pourraient diverger — c'est la manière dont trois copies de la règle d'accès
 * ont fini par se contredire.
 *
 * Pourquoi un contexte plutôt qu'un bandeau posé une fois dans le layout : la
 * question n'est pas seulement d'afficher un message, c'est de **désactiver
 * les commandes**. Le bandeau seul laisserait les boutons actifs, et on
 * apprendrait la règle en la heurtant — exactement ce que l'API vient de
 * cesser de faire.
 */
interface Etat {
  /** L'état brut, parce qu'une décision au moins ne se prend pas sur le blocage seul. */
  state: string | null;
  block: ServerBlock | null;
  /**
   * D'où vient le blocage.
   *
   * `"node"` quand c'est la machine qui se tait. La distinction ne sert qu'à
   * l'affichage : le cadre du serveur pose déjà un bandeau plus riche pour ce
   * cas — il nomme la machine et dit depuis quand — et les écrans doivent donc
   * se taire plutôt que d'empiler un second message disant la même chose en
   * moins précis.
   */
  source: "state" | "node" | null;
}

const ServerBlockContext = createContext<Etat>({ state: null, block: null, source: null });

export function ServerBlockProvider({
  state,
  nodeUnreachableSince,
  children,
}: {
  /** L'état de gestion du serveur, tel que l'API le rend. */
  state: string | null | undefined;
  /**
   * Depuis quand la machine se tait, ou `null`.
   *
   * **Il l'emporte sur l'état de gestion.** Un serveur peut être parfaitement
   * en ordre du point de vue du panel et parfaitement inatteignable dans les
   * faits : c'est alors la machine qui commande, parce que c'est elle qui fera
   * échouer tout ce qu'on tentera. Un écran qui n'afficherait que l'état de
   * gestion proposerait des boutons dont aucun n'aboutirait.
   */
  nodeUnreachableSince?: string | null;
  children: ReactNode;
}) {
  const valeur = useMemo(() => {
    const panneMachine = nodeOutageBlock(nodeUnreachableSince);
    return {
      state: state ?? null,
      block: panneMachine ?? serverBlock(state),
      source: panneMachine ? ("node" as const) : serverBlock(state) ? ("state" as const) : null,
    };
  }, [state, nodeUnreachableSince]);
  return <ServerBlockContext value={valeur}>{children}</ServerBlockContext>;
}

/**
 * Le blocage en cours, ou `null` si le serveur obéit.
 *
 * Rend `null` hors d'un espace serveur — un écran d'administration n'est pas
 * bloqué par l'état d'un serveur qu'il ne regarde pas.
 */
export function useServerBlock(): ServerBlock | null {
  return useContext(ServerBlockContext).block;
}

/**
 * Vrai quand une réinstallation n'aurait pas de sens maintenant.
 *
 * Distinct du blocage, et c'est tout l'objet de cette fonction :
 * `install_failed` bloque tout le reste et **appelle** précisément une
 * réinstallation. Griser ce bouton-là renverrait vers le seul geste qu'on
 * vient d'interdire — le bandeau dit « relancez une installation » juste
 * au-dessus.
 */
export function useReinstallBlocked(): boolean {
  return reinstallBlocked(useContext(ServerBlockContext).state);
}

/** Vrai pendant une restauration : les sauvegardes ne se suppriment pas. */
export function useBackupDeletionBlocked(): boolean {
  return backupDeletionBlocked(useContext(ServerBlockContext).state);
}

/**
 * Le bandeau, pour la fente `notice` du gabarit.
 *
 * Ne rend rien quand il n'y a rien à dire : les écrans peuvent donc le poser
 * sans condition, et il n'y a pas un `bloc ? … : null` à maintenir dans
 * chacun d'eux.
 *
 * La console garde le sien, plus riche : elle seule reçoit du daemon ce que
 * l'installation raconte au fil de l'eau.
 */
export function ServerBlockBanner() {
  const { block, source } = useContext(ServerBlockContext);
  // La panne de machine est annoncée une fois, par le cadre du serveur, avec
  // le nom de la machine et depuis quand. Le répéter ici donnerait deux
  // bandeaux empilés dont le second en dit moins.
  if (source === "node") return null;
  return block ? <ServerBlockNotice block={block} /> : null;
}
