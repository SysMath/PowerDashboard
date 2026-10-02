import { Stack } from "expo-router";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { Bandeau, Bouton, Chargement, Ecran, Rangee, Texte } from "@/composants/base";
import { CarteConsommation } from "@/composants/revendeur";
import { useConsommation } from "@/hooks/useRevendeur";

/** La consommation du parc sur le mois, serveur par serveur. */
export default function Consommation() {
  const t = useTranslations("mobile.revendeur.conso");
  const [decalage, setDecalage] = useState(0);
  const { donnees, erreur } = useConsommation(decalage);

  return (
    <Ecran>
      <Stack.Screen options={{ title: t("titre") }} />
      <Rangee>
        <Bouton
          titre={t("ceMois")}
          variante={decalage === 0 ? "primaire" : "secondaire"}
          onPress={() => setDecalage(0)}
        />
        <Bouton
          titre={t("moisDernier")}
          variante={decalage === 1 ? "primaire" : "secondaire"}
          onPress={() => setDecalage(1)}
        />
      </Rangee>
      <Texte ton="discret">{t("aide")}</Texte>
      {erreur ? <Bandeau titre={erreur} niveau="danger" /> : null}
      {donnees === null && !erreur ? <Chargement /> : null}
      {donnees?.length === 0 ? <Bandeau titre={t("vide")} /> : null}
      {donnees?.map((resume) => (
        <CarteConsommation key={resume.serverId} resume={resume} />
      ))}
    </Ecran>
  );
}
