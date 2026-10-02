import { INCIDENT_STATES, type IncidentState } from "@gamedashboard/contracts";
import { Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { CarteIncident, Choix, FilIncident } from "@/composants/administration";
import { Bandeau, Bouton, Champ, Chargement, Ecran, Texte } from "@/composants/base";
import { useIncidents } from "@/hooks/useAdministration";
import { useGeste } from "@/hooks/useGeste";
import { useRole } from "@/hooks/useRevendeur";

/** Un incident : son fil, une mise à jour, sa clôture (état « résolu », définitive). */
export default function Incident() {
  const { incident: id } = useLocalSearchParams<{ incident: string }>();
  const t = useTranslations("mobile.administration.incidents");
  const ts = useTranslations("status");
  const ecrire = useRole() === "admin";
  const geste = useGeste();
  const { donnees, erreur, publier } = useIncidents();
  const incident = donnees?.find((autre) => autre.id === id);
  const [etat, setEtat] = useState<IncidentState | null>(null);
  const [message, setMessage] = useState("");
  const [envoi, setEnvoi] = useState(false);
  const choisi = etat ?? incident?.state ?? "investigating";

  const envoyer = async () => {
    setEnvoi(true);
    const fait = await geste(() => publier(id, { state: choisi, body: message.trim() }));
    setEnvoi(false);
    if (fait) setMessage("");
  };

  return (
    <Ecran>
      <Stack.Screen options={{ title: incident?.title ?? t("titre") }} />
      {erreur ? <Bandeau titre={erreur} niveau="danger" /> : null}
      {incident ? <CarteIncident incident={incident} /> : erreur ? null : <Chargement />}
      {incident ? <FilIncident incident={incident} /> : null}
      {incident?.resolvedAt ? <Bandeau titre={t("closFige")} /> : null}
      {incident && ecrire && !incident.resolvedAt ? (
        <>
          <Texte ton="titre">{t("miseAJour")}</Texte>
          <Choix
            valeurs={INCIDENT_STATES}
            valeur={choisi}
            libelle={(valeur) => ts(`incidentState.${valeur}`)}
            onChoisir={setEtat}
          />
          {choisi === "resolved" ? <Texte ton="discret">{t("cloture")}</Texte> : null}
          <Champ
            libelle={t("messageChamp")}
            value={message}
            onChangeText={setMessage}
            multiline
            maxLength={5000}
          />
          <Bouton
            titre={t("publier")}
            inactif={envoi || message.trim() === ""}
            onPress={() => void envoyer()}
          />
        </>
      ) : null}
    </Ecran>
  );
}
