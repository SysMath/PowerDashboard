import { GameDashboardClient } from "@gamedashboard/sdk";
import { createContext, type ReactNode, useContext, useMemo, useRef } from "react";
import { useTranslations } from "use-intl";
import { versionApplication } from "@/natif/appareil";
import { cle } from "@/natif/cle";
import { coffre } from "@/natif/coffre";
import { hasard, sha256 } from "@/natif/crypto";
import { type InstanceLiee, Registre } from "@/noyau/instances";
import { type RaisonPresence, raisonPresence } from "@/noyau/presence";
import { SessionAppareil } from "@/noyau/session";

/**
 * Ce que toute l'application partage : le registre des panels liés, et une
 * session d'appareil par panel, gardée tant que l'application vit (le jeton
 * d'accès ne quitte jamais la mémoire).
 */
export interface Applis {
  registre: Registre;
  session(instanceId: string): SessionAppareil;
  client(instance: InstanceLiee): GameDashboardClient;
}

const horloge = { maintenant: () => Date.now() };

function creerApplis(traduire: (raison: RaisonPresence) => string): Applis {
  const registre = new Registre(coffre, hasard);
  const sessions = new Map<string, SessionAppareil>();
  const session = (instanceId: string) => {
    let existante = sessions.get(instanceId);
    if (!existante) {
      existante = new SessionAppareil({
        instanceId,
        registre,
        cle,
        fetch: (...args) => fetch(...args),
        horloge,
        sha256,
        versionApplication,
      });
      sessions.set(instanceId, existante);
    }
    return existante;
  };
  return {
    registre,
    session,
    client: (instance) => {
      const s = session(instance.id);
      return new GameDashboardClient({
        baseUrl: instance.adresse,
        token: () => s.jeton(),
        // Un 401 en cours de route : le jeton a pu être retiré entre-temps.
        // Un renouvellement, un seul ; s'il échoue, l'erreur remonte à l'écran.
        onUnauthorized: () =>
          s.renouveler().then(
            () => true,
            () => false,
          ),
        // Restaurer, supprimer : la biométrie, avec une invite qui nomme le
        // geste, signe le défi du panel pour ce chemin seul.
        presence: (method, path) =>
          s.presence(method, path, traduire(raisonPresence(method, path))),
      });
    },
  };
}

const Contexte = createContext<Applis | null>(null);

export function FournisseurApplis({ children }: { children: ReactNode }) {
  const t = useTranslations("mobile.presence");
  // Une référence : les sessions vivent autant que l'application, la langue
  // peut changer sous elles.
  const traduire = useRef(t);
  traduire.current = t;
  const applis = useMemo(() => creerApplis((raison) => traduire.current(raison)), []);
  return <Contexte.Provider value={applis}>{children}</Contexte.Provider>;
}

export function useApplis(): Applis {
  const applis = useContext(Contexte);
  if (!applis) throw new Error("FournisseurApplis manquant.");
  return applis;
}
