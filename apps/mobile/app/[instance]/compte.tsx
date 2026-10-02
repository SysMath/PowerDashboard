import { Stack, useRouter } from "expo-router";
import { Alert } from "react-native";
import { useFormatter, useTranslations } from "use-intl";
import { Bouton, Carte, Ecran, Texte } from "@/composants/base";
import { useInstance } from "@/etat/instance";
import { ouvrirPanel } from "@/natif/navigateur";
import { domaineDe } from "@/noyau/adresse";

/**
 * Ce téléphone et ce panel : la liaison, son échéance, le panel dans le
 * navigateur pour tout ce qui reste sur le web, et la déliaison.
 */
export default function Compte() {
  const t = useTranslations("mobile.compte");
  const tc = useTranslations("mobile.commun");
  const format = useFormatter();
  const router = useRouter();
  const { instance, session } = useInstance();

  const delier = () =>
    Alert.alert(t("delierTitre"), t("delierCorps"), [
      { text: tc("annuler"), style: "cancel" },
      {
        text: t("delier"),
        style: "destructive",
        onPress: async () => {
          await session.delier();
          router.dismissAll();
          router.replace("/");
        },
      },
    ]);

  return (
    <Ecran>
      <Stack.Screen options={{ title: t("titre") }} />
      <Carte>
        <Texte ton="titre">{instance.nom}</Texte>
        <Texte>{domaineDe(instance.adresse)}</Texte>
        <Texte ton="discret">
          {t("lieeLe", { date: format.dateTime(new Date(instance.lieeLe), { dateStyle: "long" }) })}
        </Texte>
        {instance.deviceExpiresAt ? (
          <Texte ton="discret">
            {t("expire", {
              date: format.dateTime(new Date(instance.deviceExpiresAt), { dateStyle: "long" }),
            })}
          </Texte>
        ) : null}
      </Carte>
      <Texte ton="discret">{t("webAide")}</Texte>
      <Bouton
        titre={t("ouvrirPanel")}
        variante="secondaire"
        onPress={() => ouvrirPanel(instance.adresse)}
      />
      <Bouton titre={t("panels")} variante="secondaire" onPress={() => router.navigate("/")} />
      <Bouton titre={t("delier")} variante="danger" onPress={delier} />
    </Ecran>
  );
}
