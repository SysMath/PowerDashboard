import type { PowerSignal } from "@gamedashboard/contracts";
import { useCallback } from "react";
import { useInstance } from "@/etat/instance";
import { useDonnees } from "./useDonnees";

/** La liste des serveurs, relue toutes les quinze secondes. */
export function useServeurs() {
  const { client } = useInstance();
  return useDonnees(
    useCallback(() => client.servers(), [client]),
    15_000,
  );
}

/** Un serveur, relu toutes les dix secondes, et ses ordres d'alimentation. */
export function useServeur(id: string) {
  const { client } = useInstance();
  const lecture = useDonnees(
    useCallback(() => client.server(id), [client, id]),
    10_000,
  );
  const alimenter = async (signal: PowerSignal) => {
    await client.power(id, signal);
    lecture.recharger();
  };
  return { ...lecture, alimenter };
}

/** Les joueurs connectés et les actions que l'egg déclare. */
export function useJoueurs(id: string) {
  const { client } = useInstance();
  const lecture = useDonnees(
    useCallback(() => client.players(id), [client, id]),
    15_000,
  );
  const agir = async (action: string, joueur: string) => {
    await client.playerAction(id, { action, player: joueur });
    lecture.recharger();
  };
  return { ...lecture, agir };
}

/** La cloche du compte. */
export function useCloche() {
  const { client } = useInstance();
  const lecture = useDonnees(
    useCallback(() => client.notifications(), [client]),
    30_000,
  );
  const toutLire = async () => {
    await client.markNotificationsRead();
    lecture.recharger();
  };
  return { ...lecture, toutLire };
}
