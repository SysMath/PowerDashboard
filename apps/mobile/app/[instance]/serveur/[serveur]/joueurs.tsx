import { Stack, useLocalSearchParams } from "expo-router";
import { useTranslations } from "use-intl";
import { Bandeau, Chargement, Ecran } from "@/composants/base";
import { ListeJoueurs } from "@/composants/joueurs";
import { useJoueurs } from "@/hooks/useServeurs";

/** Joueurs connectés et modération déclarée par l'egg. */
export default function Joueurs() {
  const { serveur: id } = useLocalSearchParams<{ serveur: string }>();
  const t = useTranslations("players");
  const { donnees, erreur, agir } = useJoueurs(id);

  return (
    <Ecran>
      <Stack.Screen options={{ title: t("title") }} />
      {erreur ? <Bandeau titre={erreur} niveau="danger" /> : null}
      {donnees ? <ListeJoueurs vue={donnees} onAgir={agir} /> : <Chargement />}
    </Ecran>
  );
}
