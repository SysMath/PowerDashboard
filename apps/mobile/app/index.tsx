import { Redirect, Stack, useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { useTranslations } from "use-intl";
import { Bouton, Chargement, Ecran } from "@/composants/base";
import { ListeInstances } from "@/composants/instances";
import { useApplis } from "@/etat/applis";
import type { InstanceLiee } from "@/noyau/instances";

/** Au lancement, un seul panel lié s'ouvre directement ; ensuite, la liste. */
let lancement = true;

/** Les panels liés à ce téléphone, chacun à part. */
export default function Accueil() {
  const { registre } = useApplis();
  const router = useRouter();
  const t = useTranslations("mobile.instances");
  const [instances, setInstances] = useState<InstanceLiee[] | null>(null);

  useFocusEffect(
    useCallback(() => {
      registre.lister().then(setInstances);
    }, [registre]),
  );

  if (instances === null) return <Chargement />;
  if (instances.length === 0) return <Redirect href="/ajouter" />;
  if (lancement && instances.length === 1 && instances[0]) {
    lancement = false;
    return <Redirect href={`/${instances[0].id}`} />;
  }
  lancement = false;
  return (
    <Ecran>
      <Stack.Screen options={{ title: t("titre") }} />
      <ListeInstances instances={instances} onOuvrir={(i) => router.push(`/${i.id}`)} />
      <Bouton titre={t("ajouter")} variante="secondaire" onPress={() => router.push("/ajouter")} />
    </Ecran>
  );
}
