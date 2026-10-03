import { useCallback, useEffect, useState } from "react";
import { AppState } from "react-native";
import { useInstance } from "@/etat/instance";

/**
 * Une lecture de l'API, relue à intervalle tant que l'écran est affiché et
 * l'application au premier plan. Une erreur qui concerne tout le panel
 * (verrou, liaison perdue) remonte au cadre de l'instance.
 *
 * `lire` doit être stable (`useCallback`) : la lecture recommence quand elle
 * change.
 */
export function useDonnees<T>(
  lire: () => Promise<T>,
  intervalleMs?: number,
): { donnees: T | null; erreur: string | null; chargement: boolean; recharger: () => void } {
  const { signaler } = useInstance();
  const [donnees, setDonnees] = useState<T | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [chargement, setChargement] = useState(true);
  const recharger = useCallback(() => {
    setChargement(true);
    lire().then(
      (valeur) => {
        setDonnees(valeur);
        setErreur(null);
        setChargement(false);
      },
      (error: unknown) => {
        signaler(error);
        setErreur(error instanceof Error ? error.message : String(error));
        setChargement(false);
      },
    );
  }, [lire, signaler]);

  useEffect(() => {
    recharger();
    if (!intervalleMs) return;
    const minuterie = setInterval(() => {
      if (AppState.currentState === "active") recharger();
    }, intervalleMs);
    return () => clearInterval(minuterie);
  }, [recharger, intervalleMs]);

  return { donnees, erreur, chargement, recharger };
}
