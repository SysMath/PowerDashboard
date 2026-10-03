import { useCallback } from "react";
import { useInstance } from "@/etat/instance";
import { enCours } from "@/noyau/sauvegardes";
import { useDonnees } from "./useDonnees";

/**
 * Les sauvegardes d'un serveur et leurs gestes. La liste se relit toutes les
 * trente secondes, et toutes les cinq tant qu'une archive est en cours.
 */
export function useSauvegardes(id: string) {
  const { client } = useInstance();
  const lecture = useDonnees(
    useCallback(() => client.backups(id), [client, id]),
    30_000,
  );
  const suivi = useDonnees(
    useCallback(
      () => (enCours(lecture.donnees) ? client.backups(id) : Promise.resolve(null)),
      [client, id, lecture.donnees],
    ),
    5_000,
  );
  const donnees = suivi.donnees ?? lecture.donnees;
  const apres = <T>(geste: Promise<T>) => geste.finally(lecture.recharger);
  return {
    ...lecture,
    donnees,
    creer: (nom: string) => apres(client.createBackup(id, nom)),
    verrouiller: (sauvegarde: string, verrou: boolean) =>
      apres(client.lockBackup(id, sauvegarde, verrou)),
    restaurer: (sauvegarde: string, vider: boolean) =>
      apres(client.restoreBackup(id, sauvegarde, vider)),
    supprimer: (sauvegarde: string) => apres(client.deleteBackup(id, sauvegarde)),
  };
}
