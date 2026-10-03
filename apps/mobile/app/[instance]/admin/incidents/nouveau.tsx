import { INCIDENT_IMPACTS, type IncidentImpact } from "@gamedashboard/contracts";
import { Stack, useRouter } from "expo-router";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { Choix } from "@/composants/administration";
import { Bouton, Champ, Ecran, Texte } from "@/composants/base";
import { useIncidents } from "@/hooks/useAdministration";
import { useGeste } from "@/hooks/useGeste";

/** Ouvrir un incident en quelques mots : il paraît aussitôt sur /status. */
export default function NouvelIncident() {
  const t = useTranslations("mobile.administration.incidents");
  const ts = useTranslations("status");
  const router = useRouter();
  const geste = useGeste();
  const { ouvrir } = useIncidents();
  const [titre, setTitre] = useState("");
  const [message, setMessage] = useState("");
  const [impact, setImpact] = useState<IncidentImpact>("minor");
  const [envoi, setEnvoi] = useState(false);

  const publier = async () => {
    setEnvoi(true);
    const fait = await geste(() => ouvrir({ title: titre.trim(), impact, body: message.trim() }));
    setEnvoi(false);
    if (fait) router.back();
  };

  return (
    <Ecran>
      <Stack.Screen options={{ title: t("nouveau") }} />
      <Texte ton="discret">{t("public")}</Texte>
      <Champ libelle={t("titreChamp")} value={titre} onChangeText={setTitre} maxLength={200} />
      <Texte ton="discret">{t("impactChamp")}</Texte>
      <Choix
        valeurs={INCIDENT_IMPACTS}
        valeur={impact}
        libelle={(valeur) => ts(`impact.${valeur}`)}
        onChoisir={setImpact}
      />
      <Champ
        libelle={t("messageChamp")}
        value={message}
        onChangeText={setMessage}
        multiline
        maxLength={5000}
      />
      <Bouton
        titre={t("publier")}
        inactif={envoi || titre.trim() === "" || message.trim() === ""}
        onPress={() => void publier()}
      />
    </Ecran>
  );
}
