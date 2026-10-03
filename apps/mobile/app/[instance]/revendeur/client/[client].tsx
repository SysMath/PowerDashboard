import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { Alert } from "react-native";
import { useTranslations } from "use-intl";
import { Bandeau, Chargement, Ecran } from "@/composants/base";
import { CarteServeurParc } from "@/composants/revendeur";
import { useInstance } from "@/etat/instance";
import { useGeste } from "@/hooks/useGeste";
import { useParc } from "@/hooks/useRevendeur";
import { estSuspendu, serveursDuClient } from "@/noyau/revendeur";

/** Les serveurs d'un client : les ouvrir comme lui, les suspendre, les rétablir. */
export default function ClientRevendeur() {
  const { client: id } = useLocalSearchParams<{ client: string }>();
  const t = useTranslations("mobile.revendeur");
  const tc = useTranslations("mobile.commun");
  const router = useRouter();
  const { instance } = useInstance();
  const geste = useGeste();
  const { donnees, erreur, suspendre } = useParc();
  const client = donnees?.clients.find((autre) => autre.id === id);
  const serveurs = client && donnees ? serveursDuClient(donnees.servers, client) : [];

  const basculer = (serveur: (typeof serveurs)[number]) => {
    const suspendu = estSuspendu(serveur);
    const lancer = () =>
      geste(async () => {
        const ouvertes = await suspendre(serveur.id, !suspendu);
        if (ouvertes > 0) Alert.alert(t("suspendu"), t("sessionsOuvertes", { n: ouvertes }));
      });
    Alert.alert(
      t(suspendu ? "retablirTitre" : "suspendreTitre", { nom: serveur.name }),
      t(suspendu ? "retablirCorps" : "suspendreCorps"),
      [
        { text: tc("annuler"), style: "cancel" },
        {
          text: t(suspendu ? "retablir" : "suspendre"),
          style: suspendu ? "default" : "destructive",
          onPress: () => void lancer(),
        },
      ],
    );
  };

  return (
    <Ecran>
      <Stack.Screen options={{ title: client?.name ?? t("clients") }} />
      {erreur ? (
        <Bandeau titre={t("erreur")} niveau="danger">
          {erreur}
        </Bandeau>
      ) : null}
      {donnees === null && !erreur ? <Chargement /> : null}
      {donnees && serveurs.length === 0 ? <Bandeau titre={t("aucunServeur")} /> : null}
      {serveurs.map((serveur) => (
        <CarteServeurParc
          key={serveur.id}
          serveur={serveur}
          onOuvrir={() => router.push(`/${instance.id}/serveur/${serveur.id}`)}
          onSuspendre={() => basculer(serveur)}
        />
      ))}
    </Ecran>
  );
}
