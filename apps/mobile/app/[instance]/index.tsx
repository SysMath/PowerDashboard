import { Stack, useRouter } from "expo-router";
import { useTranslations } from "use-intl";
import { Bandeau, Bouton, Chargement, Ecran, Rangee } from "@/composants/base";
import { CarteServeur } from "@/composants/serveurs";
import { useInstance } from "@/etat/instance";
import { useCloche, useServeurs } from "@/hooks/useServeurs";

/** Les serveurs du compte sur ce panel, y compris ceux où l'on est invité. */
export default function Serveurs() {
  const t = useTranslations("mobile.serveurs");
  const router = useRouter();
  const { instance } = useInstance();
  const { donnees, erreur, chargement } = useServeurs();
  const cloche = useCloche();
  const nonLues = cloche.donnees?.unread ?? 0;

  return (
    <Ecran>
      <Stack.Screen options={{ title: instance.nom }} />
      <Rangee>
        <Bouton
          titre={nonLues > 0 ? t("clocheNonLues", { n: nonLues }) : t("cloche")}
          variante="secondaire"
          onPress={() => router.push(`/${instance.id}/notifications`)}
        />
        <Bouton
          titre={t("compte")}
          variante="secondaire"
          onPress={() => router.push(`/${instance.id}/compte`)}
        />
      </Rangee>
      {erreur ? (
        <Bandeau titre={t("erreur")} niveau="danger">
          {erreur}
        </Bandeau>
      ) : null}
      {chargement && !donnees ? <Chargement /> : null}
      {donnees?.length === 0 ? <Bandeau titre={t("vide")} /> : null}
      {donnees?.map((serveur) => (
        <CarteServeur
          key={serveur.id}
          serveur={serveur}
          onPress={() => router.push(`/${instance.id}/serveur/${serveur.id}`)}
        />
      ))}
    </Ecran>
  );
}
