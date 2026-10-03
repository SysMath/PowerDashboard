import type { AdminActivityEntry, IncidentImpact, IncidentState } from "@gamedashboard/contracts";
import { useCallback, useEffect, useState } from "react";
import { useInstance } from "@/etat/instance";
import { apercu } from "@/noyau/administration";
import { useDonnees } from "./useDonnees";

/*
 * Les lectures et les gestes de l'administration simple (ADR 0010, lot 6).
 * Chaque geste demande la biométrie (le SDK le sait) puis relit l'écran.
 */

/** Ce qui ne va pas sur la plateforme, relu toutes les trente secondes. */
export function useApercu() {
  const { client } = useInstance();
  const lecture = useDonnees(
    useCallback(async () => {
      const [noeuds, serveurs, incidents, miseAJour] = await Promise.all([
        client.adminNodes(),
        client.adminServers(),
        client.adminIncidents(),
        client.panelUpdate(),
      ]);
      return { ...apercu({ noeuds, serveurs, incidents, miseAJour }), statut: miseAJour };
    }, [client]),
    30_000,
  );
  const verifier = () => client.checkPanelUpdate().finally(lecture.recharger);
  return { ...lecture, verifier };
}

export function useMachines() {
  const { client } = useInstance();
  return useDonnees(
    useCallback(() => client.adminNodes(), [client]),
    30_000,
  );
}

/** L'agent d'une machine et ce qu'il offre, fonction par fonction. */
export function useAgent(nodeId: string) {
  const { client } = useInstance();
  return useDonnees(useCallback(() => client.adminNodeAgent(nodeId), [client, nodeId]));
}

/** Tout le parc ; la suspension rend les sessions SFTP restées ouvertes. */
export function useParcAdmin() {
  const { client } = useInstance();
  const lecture = useDonnees(
    useCallback(() => client.adminServers(), [client]),
    30_000,
  );
  const suspendre = (serverId: string, suspendu: boolean) =>
    client
      .setAdminServerSuspended(serverId, suspendu)
      .then((issue) => issue.sessionsNotClosed)
      .finally(lecture.recharger);
  return { ...lecture, suspendre };
}

export function useComptes() {
  const { client } = useInstance();
  const lecture = useDonnees(useCallback(() => client.adminUsers(), [client]));
  const apres = <T>(geste: Promise<T>) => geste.finally(lecture.recharger);
  return {
    ...lecture,
    suspendre: (userId: string, motif: string) =>
      apres(client.setAdminUserSuspended(userId, { suspended: true, reason: motif.trim() })),
    retablir: (userId: string) => apres(client.setAdminUserSuspended(userId, { suspended: false })),
    deconnecter: (userId: string) => apres(client.revokeAdminUserSessions(userId)),
  };
}

export function useIncidents() {
  const { client } = useInstance();
  const lecture = useDonnees(
    useCallback(() => client.adminIncidents(), [client]),
    30_000,
  );
  const apres = <T>(geste: Promise<T>) => geste.finally(lecture.recharger);
  return {
    ...lecture,
    ouvrir: (input: { title: string; impact: IncidentImpact; body: string }) =>
      apres(client.openIncident(input)),
    publier: (incidentId: string, input: { state: IncidentState; body: string }) =>
      apres(client.postIncidentUpdate(incidentId, input)),
  };
}

/** Le journal, page après page ; une nouvelle recherche repart de la première. */
export function useJournal(recherche: string) {
  const { client, signaler } = useInstance();
  const [lignes, setLignes] = useState<AdminActivityEntry[]>([]);
  // La page appartient à une recherche : une nouvelle recherche repart de 1.
  const [position, setPosition] = useState({ recherche, page: 1 });
  const page = position.recherche === recherche ? position.page : 1;
  const [suite, setSuite] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [chargement, setChargement] = useState(true);

  useEffect(() => {
    let annule = false;
    setChargement(true);
    client.adminActivity({ query: recherche.trim(), page }).then(
      (resultat) => {
        if (annule) return;
        setLignes((avant) => (page === 1 ? resultat.items : [...avant, ...resultat.items]));
        setSuite(resultat.hasMore);
        setErreur(null);
        setChargement(false);
      },
      (error: unknown) => {
        if (annule) return;
        signaler(error);
        setErreur(error instanceof Error ? error.message : String(error));
        setChargement(false);
      },
    );
    return () => {
      annule = true;
    };
  }, [client, signaler, recherche, page]);

  return {
    lignes,
    suite,
    erreur,
    chargement,
    plus: () => setPosition({ recherche, page: page + 1 }),
  };
}
