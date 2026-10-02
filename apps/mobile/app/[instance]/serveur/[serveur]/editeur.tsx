import { Stack, useLocalSearchParams, useNavigation } from "expo-router";
import { useEffect } from "react";
import { Alert } from "react-native";
import { useTranslations } from "use-intl";
import { Bandeau, Bouton, Chargement, Ecran, Rangee, Texte } from "@/composants/base";
import { ChampEditeur } from "@/composants/editeur";
import { useEditeur } from "@/hooks/useEditeur";
import { useGeste } from "@/hooks/useGeste";

/** Un fichier texte de 1 Mo au plus, à retoucher et enregistrer. */
export default function Editeur() {
  const { serveur: id, fichier } = useLocalSearchParams<{ serveur: string; fichier: string }>();
  const t = useTranslations("fileEditor");
  const tm = useTranslations("mobile.editeur");
  const tc = useTranslations("mobile.commun");
  const navigation = useNavigation();
  const geste = useGeste();
  const { erreur, texte, modifie, saisir, retablir, enregistrer } = useEditeur(id, fichier);

  // Quitter avec des modifications non enregistrées se confirme.
  useEffect(() => {
    if (!modifie) return;
    return navigation.addListener("beforeRemove", (evenement) => {
      evenement.preventDefault();
      Alert.alert(tm("quitterTitre"), tm("quitterCorps"), [
        { text: tc("annuler"), style: "cancel" },
        {
          text: tm("quitter"),
          style: "destructive",
          onPress: () => navigation.dispatch(evenement.data.action),
        },
      ]);
    });
  }, [modifie, navigation, tm, tc]);

  if (texte === null) return erreur ? <Bandeau titre={erreur} niveau="danger" /> : <Chargement />;
  return (
    <Ecran defile={false}>
      <Stack.Screen options={{ title: fichier.split("/").pop() }} />
      <Rangee>
        <Texte ton="discret">{modifie ? t("unsaved") : t("upToDate")}</Texte>
      </Rangee>
      <ChampEditeur texte={texte} onChange={saisir} />
      <Rangee>
        <Bouton titre={t("revert")} variante="secondaire" inactif={!modifie} onPress={retablir} />
        <Bouton
          titre={tm("enregistrer")}
          inactif={!modifie}
          onPress={() => geste(enregistrer, t("saveRefused"))}
        />
      </Rangee>
    </Ecran>
  );
}
