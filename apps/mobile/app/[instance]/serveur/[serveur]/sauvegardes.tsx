import { Stack, useLocalSearchParams } from "expo-router";
import { useTranslations } from "use-intl";
import { Bandeau, Chargement, Ecran } from "@/composants/base";
import { ListeSauvegardes } from "@/composants/sauvegardes";
import { useSauvegardes } from "@/hooks/useSauvegardes";

/** Les sauvegardes du serveur : créer, verrouiller, restaurer, supprimer. */
export default function Sauvegardes() {
  const { serveur: id } = useLocalSearchParams<{ serveur: string }>();
  const t = useTranslations("backups");
  const { donnees, erreur, ...gestes } = useSauvegardes(id);

  return (
    <Ecran>
      <Stack.Screen options={{ title: t("title") }} />
      {erreur ? <Bandeau titre={erreur} niveau="danger" /> : null}
      {donnees ? <ListeSauvegardes liste={donnees} gestes={gestes} /> : <Chargement />}
    </Ecran>
  );
}
