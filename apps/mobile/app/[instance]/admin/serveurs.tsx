import { Stack, useRouter } from "expo-router";
import { useState } from "react";
import { Alert } from "react-native";
import { useTranslations } from "use-intl";
import { CarteServeurAdmin } from "@/composants/administration";
import { Bandeau, Champ, Chargement, Ecran, Texte } from "@/composants/base";
import { useInstance } from "@/etat/instance";
import { useParcAdmin } from "@/hooks/useAdministration";
import { useConfirme } from "@/hooks/useGeste";
import { useRole } from "@/hooks/useRevendeur";
import { filtrerServeurs } from "@/noyau/administration";
import { estSuspendu } from "@/noyau/revendeur";

const AFFICHES = 50;

/** Tout le parc : chercher, ouvrir avec les écrans du client, suspendre. */
export default function ServeursAdmin() {
  const t = useTranslations("mobile.administration.serveurs");
  const tr = useTranslations("mobile.revendeur");
  const router = useRouter();
  const { instance } = useInstance();
  const ecrire = useRole() === "admin";
  const confirme = useConfirme();
  const [recherche, setRecherche] = useState("");
  const { donnees, erreur, suspendre } = useParcAdmin();
  const tous = donnees ? filtrerServeurs(donnees, recherche) : [];
  const trouves = tous.slice(0, AFFICHES);

  const basculer = (serveur: (typeof trouves)[number]) => {
    const suspendu = estSuspendu(serveur);
    confirme(
      {
        titre: tr(suspendu ? "retablirTitre" : "suspendreTitre", { nom: serveur.name }),
        corps: tr(suspendu ? "retablirCorps" : "suspendreCorps"),
        bouton: tr(suspendu ? "retablir" : "suspendre"),
      },
      async () => {
        const ouvertes = await suspendre(serveur.id, !suspendu);
        if (ouvertes > 0) Alert.alert(tr("suspendu"), tr("sessionsOuvertes", { n: ouvertes }));
      },
      !suspendu,
    );
  };

  return (
    <Ecran>
      <Stack.Screen options={{ title: t("titre") }} />
      <Champ
        libelle={t("chercher")}
        value={recherche}
        onChangeText={setRecherche}
        autoCapitalize="none"
        autoCorrect={false}
      />
      {erreur ? <Bandeau titre={erreur} niveau="danger" /> : null}
      {donnees === null && !erreur ? <Chargement /> : null}
      {donnees && trouves.length === 0 ? <Bandeau titre={t("aucun")} /> : null}
      {trouves.map((serveur) => (
        <CarteServeurAdmin
          key={serveur.id}
          serveur={serveur}
          ecrire={ecrire}
          onOuvrir={() => router.push(`/${instance.id}/serveur/${serveur.id}`)}
          onSuspendre={() => basculer(serveur)}
        />
      ))}
      {tous.length > AFFICHES ? (
        <Texte ton="discret">{t("affiner", { n: tous.length - AFFICHES })}</Texte>
      ) : null}
    </Ecran>
  );
}
