import type { GameDashboardClient } from "@gamedashboard/sdk";
import { createContext, useContext } from "react";
import type { Descripteur } from "@/noyau/descripteur";
import type { InstanceLiee } from "@/noyau/instances";
import type { SessionAppareil } from "@/noyau/session";

/** Le panel ouvert : son instance, sa session et son client. */
export interface InstanceOuverte {
  instance: InstanceLiee;
  session: SessionAppareil;
  client: GameDashboardClient;
  /** Le descripteur lu à l'ouverture ; `null` s'il n'a pas pu l'être. */
  descripteur: Descripteur | null;
  /** Une erreur d'un écran qui concerne tout le panel (verrou, liaison perdue). */
  signaler(erreur: unknown): void;
}

export const ContexteInstance = createContext<InstanceOuverte | null>(null);

export function useInstance(): InstanceOuverte {
  const ouverte = useContext(ContexteInstance);
  if (!ouverte) throw new Error("Aucun panel ouvert.");
  return ouverte;
}
