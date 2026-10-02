import { useCallback } from "react";
import { useInstance } from "@/etat/instance";
import { periodeMois, resumerConsommation } from "@/noyau/revendeur";
import { useDonnees } from "./useDonnees";

/** Le rôle du compte sur ce panel : il dit quels espaces montrer. */
export function useRole(): string | null {
  const { client } = useInstance();
  const { donnees } = useDonnees(
    useCallback(() => client.me().then(({ user }) => user.role), [client]),
  );
  return donnees;
}

/**
 * Le parc du revendeur, relu toutes les trente secondes, et la suspension
 * d'un serveur (biométrie demandée par le SDK). Rend le nombre de sessions
 * SFTP que le daemon n'a pas pu couper.
 */
export function useParc() {
  const { client } = useInstance();
  const lecture = useDonnees(
    useCallback(() => client.resellerOverview(), [client]),
    30_000,
  );
  const suspendre = (serverId: string, suspendu: boolean) =>
    client
      .setResellerServerSuspended(serverId, suspendu)
      .then((issue) => issue.sessionsNotClosed)
      .finally(lecture.recharger);
  return { ...lecture, suspendre };
}

/** La consommation du mois (`decalage` 0) ou d'un précédent, résumée par serveur. */
export function useConsommation(decalage: number) {
  const { client } = useInstance();
  return useDonnees(
    useCallback(
      () => client.resellerConsumption(periodeMois(new Date(), decalage)).then(resumerConsommation),
      [client, decalage],
    ),
  );
}
