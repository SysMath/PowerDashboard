import { Stack, useRouter } from "expo-router";
import { useTranslations } from "use-intl";
import { CarteMachine } from "@/composants/administration";
import { Bandeau, Chargement, Ecran } from "@/composants/base";
import { useInstance } from "@/etat/instance";
import { useMachines } from "@/hooks/useAdministration";

/** Les machines de jeu et leur santé, en lecture seule. */
export default function Machines() {
  const t = useTranslations("mobile.administration");
  const router = useRouter();
  const { instance } = useInstance();
  const { donnees, erreur } = useMachines();

  return (
    <Ecran>
      <Stack.Screen options={{ title: t("rubrique.machines") }} />
      {erreur ? (
        <Bandeau titre={t("erreur")} niveau="danger">
          {erreur}
        </Bandeau>
      ) : null}
      {donnees === null && !erreur ? <Chargement /> : null}
      {donnees?.length === 0 ? <Bandeau titre={t("machines.vide")} /> : null}
      {donnees?.map((node) => (
        <CarteMachine
          key={node.id}
          node={node}
          onPress={() => router.push(`/${instance.id}/admin/machines/${node.id}`)}
        />
      ))}
    </Ecran>
  );
}
