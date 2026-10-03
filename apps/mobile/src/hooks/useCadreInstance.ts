import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "use-intl";
import { useApplis } from "@/etat/applis";
import type { InstanceOuverte } from "@/etat/instance";
import { versionApplication } from "@/natif/appareil";
import { cle, estVerrouillee } from "@/natif/cle";
import { lireInstance } from "@/noyau/descripteur";
import type { InstanceLiee } from "@/noyau/instances";
import { LiaisonPerdue } from "@/noyau/session";
import { EchecPanel } from "@/noyau/transport";

export type EtatCadre =
  | { etat: "chargement" }
  | { etat: "introuvable" }
  | { etat: "verrouille" }
  | { etat: "hors-ligne" }
  | { etat: "a-confirmer"; instance: InstanceLiee }
  | { etat: "a-relier"; instance: InstanceLiee }
  | { etat: "ouvert"; ouverte: InstanceOuverte };

/**
 * Le cadre d'un panel lié : il vérifie que le panel est toujours le même,
 * ouvre la clé d'appareil (biométrie à l'ouverture, ADR 0010), puis donne aux
 * écrans la session et le client. Une erreur d'un écran qui touche le panel
 * entier (verrou, appareil retiré) ramène ici.
 */
export function useCadreInstance(instanceId: string) {
  const { registre, session, client } = useApplis();
  const t = useTranslations("mobile.verrou");
  const [cadre, setCadre] = useState<EtatCadre>({ etat: "chargement" });
  const [tour, setTour] = useState(0);

  const signaler = useCallback((erreur: unknown) => {
    if (estVerrouillee(erreur)) setTour((n) => n + 1);
    else if (erreur instanceof LiaisonPerdue) setTour((n) => n + 1);
  }, []);

  const ouvrir = useCallback(
    async (demander: boolean): Promise<EtatCadre> => {
      let instance = await registre.trouver(instanceId);
      if (!instance) return { etat: "introuvable" };
      const verdict = await lireInstance(instance.adresse, { fetch, versionApplication });
      const descripteur = verdict.etat === "ok" ? verdict.descripteur : null;
      if (verdict.etat === "ok") {
        instance = (await registre.verifierIdentite(instanceId, verdict.descripteur)) ?? instance;
      }
      if (instance.etat === "a-confirmer") return { etat: "a-confirmer", instance };
      if (instance.etat === "a-relier") return { etat: "a-relier", instance };
      const s = session(instanceId);
      try {
        await s.jeton();
      } catch (erreur) {
        if (estVerrouillee(erreur) && demander && (await cle.deverrouiller(t("raison")))) {
          return ouvrir(false);
        }
        if (estVerrouillee(erreur)) return { etat: "verrouille" };
        if (erreur instanceof LiaisonPerdue) {
          const perdue = (await registre.trouver(instanceId)) ?? instance;
          return { etat: "a-relier", instance: perdue };
        }
        if (erreur instanceof EchecPanel && erreur.status === 0) return { etat: "hors-ligne" };
        throw erreur;
      }
      return {
        etat: "ouvert",
        ouverte: { instance, session: s, client: client(instance), descripteur, signaler },
      };
    },
    [registre, session, client, instanceId, signaler, t],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: `tour` relance l'ouverture
  useEffect(() => {
    let actif = true;
    ouvrir(true).then(
      (suivant) => actif && setCadre(suivant),
      () => actif && setCadre({ etat: "hors-ligne" }),
    );
    return () => {
      actif = false;
    };
  }, [ouvrir, tour]);

  const reessayer = useCallback(() => setTour((n) => n + 1), []);
  return useMemo(() => ({ cadre, reessayer }), [cadre, reessayer]);
}
