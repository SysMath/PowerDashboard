import { openServerConsole, type ServerConsole } from "@gamedashboard/sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import { useInstance } from "@/etat/instance";
import { ajouterLignes, type LigneConsole, lireReleve, type Releve } from "@/noyau/console";

export type PhaseConsole = "connexion" | "ouverte" | "fermee";

/**
 * La console en direct, ouverte chez le daemon avec l'origine du panel
 * (ADR 0010, « La console »). Les commandes passent par le panel, qui les
 * vérifie et les consigne.
 */
export function useConsole(serveurId: string) {
  const { client, instance, signaler } = useInstance();
  const [lignes, setLignes] = useState<LigneConsole[]>([]);
  const [etat, setEtat] = useState<string | null>(null);
  const [releve, setReleve] = useState<Releve | null>(null);
  const [phase, setPhase] = useState<PhaseConsole>("connexion");
  const [tour, setTour] = useState(0);
  const ouverteRef = useRef<ServerConsole | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `tour` rouvre la console à la demande
  useEffect(() => {
    let fini = false;
    setPhase("connexion");
    openServerConsole(
      client,
      serveurId,
      (event) => {
        if (fini) return;
        if (event.kind === "output" || event.kind === "install" || event.kind === "error") {
          setPhase("ouverte");
          setLignes((avant) => ajouterLignes(avant, [event.text]));
        } else if (event.kind === "status") {
          setPhase("ouverte");
          setEtat(event.text);
        } else if (event.kind === "stats") {
          setReleve(lireReleve(event.text));
        } else if (event.kind === "closed") {
          setPhase("fermee");
        }
      },
      { origin: instance.origine },
    ).then(
      (ouverte) => {
        if (fini) ouverte.close();
        else ouverteRef.current = ouverte;
      },
      (error: unknown) => {
        signaler(error);
        if (!fini) setPhase("fermee");
      },
    );
    return () => {
      fini = true;
      ouverteRef.current?.close();
      ouverteRef.current = null;
    };
  }, [client, serveurId, instance.origine, signaler, tour]);

  const envoyer = useCallback(async (commande: string) => {
    await ouverteRef.current?.send(commande);
  }, []);

  return { lignes, etat, releve, phase, envoyer, rouvrir: () => setTour((t) => t + 1) };
}
