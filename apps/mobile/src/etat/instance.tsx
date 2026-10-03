import type { GameDashboardClient } from "@gamedashboard/sdk";
import { createContext, useContext } from "react";
import type { Descripteur } from "@/noyau/descripteur";
import type { InstanceLiee } from "@/noyau/instances";
import type { SessionAppareil } from "@/noyau/session";

/** Le panel ouvert : son instance, sa session et son client. */
export interface InstanceOuverte {
  instance: InstanceLiee;
  /** Ce que les écrans demandent à la session : le jeton, la déliaison. */
  session: Pick<SessionAppareil, "jeton" | "delier">;
  client: GameDashboardClient;
  /** Le descripteur lu à l'ouverture ; `null` s'il n'a pas pu l'être. */
  descripteur: Descripteur | null;
  /** Une erreur d'un écran qui concerne tout le panel (verrou, liaison perdue). */
  signaler(erreur: unknown): void;
  /** Le panel fictif du mode démo : rien ne sort du téléphone. */
  demo?: boolean;
  /** La socket de console, quand elle n'est pas celle du système (démo). */
  webSocket?: typeof WebSocket;
}

export const ContexteInstance = createContext<InstanceOuverte | null>(null);

export function useInstance(): InstanceOuverte {
  const ouverte = useContext(ContexteInstance);
  if (!ouverte) throw new Error("Aucun panel ouvert.");
  return ouverte;
}
