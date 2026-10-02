import { Stack, useRouter } from "expo-router";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { CarteCompte } from "@/composants/administration";
import { Bandeau, Champ, Chargement, Ecran, Texte } from "@/composants/base";
import { useInstance } from "@/etat/instance";
import { useComptes } from "@/hooks/useAdministration";
import { filtrerComptes } from "@/noyau/administration";

const AFFICHES = 50;

/** Les comptes : chercher par nom ou adresse, ouvrir une fiche. */
export default function Comptes() {
  const t = useTranslations("mobile.administration.comptes");
  const router = useRouter();
  const { instance } = useInstance();
  const [recherche, setRecherche] = useState("");
  const { donnees, erreur } = useComptes();
  const tous = donnees ? filtrerComptes(donnees, recherche) : [];

  return (
    <Ecran>
      <Stack.Screen options={{ title: t("titre") }} />
      <Champ
        libelle={t("chercher")}
        value={recherche}
        onChangeText={setRecherche}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
      />
      {erreur ? <Bandeau titre={erreur} niveau="danger" /> : null}
      {donnees === null && !erreur ? <Chargement /> : null}
      {donnees && tous.length === 0 ? <Bandeau titre={t("aucun")} /> : null}
      {tous.slice(0, AFFICHES).map((compte) => (
        <CarteCompte
          key={compte.id}
          compte={compte}
          onPress={() => router.push(`/${instance.id}/admin/comptes/${compte.id}`)}
        />
      ))}
      {tous.length > AFFICHES ? (
        <Texte ton="discret">{t("affiner", { n: tous.length - AFFICHES })}</Texte>
      ) : null}
    </Ecran>
  );
}
