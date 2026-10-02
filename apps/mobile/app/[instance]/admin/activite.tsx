import { Stack } from "expo-router";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { LigneJournal } from "@/composants/administration";
import { Bandeau, Bouton, Champ, Chargement, Ecran } from "@/composants/base";
import { useJournal } from "@/hooks/useAdministration";

/** Le journal de la plateforme, en lecture : chercher, remonter page après page. */
export default function Activite() {
  const t = useTranslations("mobile.administration.activite");
  const [saisie, setSaisie] = useState("");
  const [recherche, setRecherche] = useState("");
  const { lignes, suite, erreur, chargement, plus } = useJournal(recherche);

  return (
    <Ecran>
      <Stack.Screen options={{ title: t("titre") }} />
      <Champ
        libelle={t("chercher")}
        value={saisie}
        onChangeText={setSaisie}
        onSubmitEditing={() => setRecherche(saisie)}
        returnKeyType="search"
        autoCapitalize="none"
        autoCorrect={false}
      />
      {erreur ? <Bandeau titre={erreur} niveau="danger" /> : null}
      {!chargement && !erreur && lignes.length === 0 ? <Bandeau titre={t("vide")} /> : null}
      {lignes.map((ligne) => (
        <LigneJournal key={ligne.id} ligne={ligne} />
      ))}
      {chargement ? <Chargement /> : null}
      {suite && !chargement ? (
        <Bouton titre={t("plus")} variante="secondaire" onPress={plus} />
      ) : null}
    </Ecran>
  );
}
