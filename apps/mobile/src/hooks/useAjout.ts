import { useRouter } from "expo-router";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { useApplis } from "@/etat/applis";
import { plateforme, versionApplication } from "@/natif/appareil";
import { cle } from "@/natif/cle";
import { hasard, sha256 } from "@/natif/crypto";
import { ouvrirLiaison } from "@/natif/navigateur";
import { normaliserAdresse } from "@/noyau/adresse";
import { type Descripteur, lireInstance, type VerdictInstance } from "@/noyau/descripteur";
import { lireRetour, preparerLiaison, terminerLiaison } from "@/noyau/liaison";

export type EtapeAjout =
  | { etape: "saisie"; probleme: string | null }
  | { etape: "verification" }
  | { etape: "fiche"; adresse: string; descripteur: Descripteur; probleme: string | null }
  | { etape: "liaison"; adresse: string; descripteur: Descripteur };

/**
 * Ajouter un panel : vérifier l'adresse et son descripteur, montrer le nom et
 * le domaine, puis lier ce téléphone par le navigateur.
 */
export function useAjout() {
  const { registre, session } = useApplis();
  const router = useRouter();
  const t = useTranslations("mobile.ajout");
  const [etape, setEtape] = useState<EtapeAjout>({ etape: "saisie", probleme: null });

  const verifier = async (saisie: string) => {
    const lue = normaliserAdresse(saisie);
    if ("erreur" in lue) return setEtape({ etape: "saisie", probleme: t(`adresse.${lue.erreur}`) });
    setEtape({ etape: "verification" });
    const verdict: VerdictInstance = await lireInstance(lue.adresse, { fetch, versionApplication });
    if (verdict.etat !== "ok") {
      return setEtape({ etape: "saisie", probleme: t(`verdict.${verdict.etat}`) });
    }
    const connue = (await registre.lister()).find((i) => i.adresse === lue.adresse);
    if (connue?.etat === "liee" && connue.instance === verdict.descripteur.instance) {
      return router.replace(`/${connue.id}`);
    }
    setEtape({
      etape: "fiche",
      adresse: lue.adresse,
      descripteur: verdict.descripteur,
      probleme: null,
    });
  };

  const relier = async (nomAppareil: string) => {
    if (etape.etape !== "fiche") return;
    const { adresse, descripteur } = etape;
    setEtape({ etape: "liaison", adresse, descripteur });
    const echec = (cle: string) =>
      setEtape({ etape: "fiche", adresse, descripteur, probleme: t(`liaison.${cle}`) });
    try {
      const instance = await registre.preparer(adresse, descripteur);
      const demande = await preparerLiaison({ instance, nomAppareil, plateforme, hasard, sha256 });
      const retour = await ouvrirLiaison(demande.url);
      if (!retour) return echec("annulee");
      const lu = lireRetour(retour, demande.state);
      if ("erreur" in lu) return echec(lu.erreur);
      const fin = await terminerLiaison({
        instance,
        code: lu.code,
        verifier: demande.verifier,
        registre,
        cle,
        fetch,
        horloge: { maintenant: () => Date.now() },
        versionApplication,
        raison: t("raison"),
      });
      session(instance.id).adopter(fin.grant);
      router.replace(`/${instance.id}`);
    } catch {
      echec("echec");
    }
  };

  return {
    etape,
    verifier,
    relier,
    recommencer: () => setEtape({ etape: "saisie", probleme: null }),
  };
}
