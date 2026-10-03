import { Stack, useRouter } from "expo-router";
import { useTranslations } from "use-intl";
import {
  CarteIncident,
  CarteMachine,
  CarteMiseAJour,
  CarteServeurEnEchec,
  Rubriques,
} from "@/composants/administration";
import { Bandeau, Bouton, Chargement, Ecran, Texte } from "@/composants/base";
import { useInstance } from "@/etat/instance";
import { useApercu } from "@/hooks/useAdministration";
import { usePanelWeb } from "@/hooks/usePanelWeb";
import { useRole } from "@/hooks/useRevendeur";

/** Ce qui ne va pas sur la plateforme ; chaque ligne mène à son écran. */
export default function Administration() {
  const t = useTranslations("mobile.administration");
  const router = useRouter();
  const { instance } = useInstance();
  const panelWeb = usePanelWeb();
  const ecrire = useRole() === "admin";
  const { donnees, erreur, verifier } = useApercu();
  const aller = (chemin: string) => router.push(`/${instance.id}/admin/${chemin}`);
  const calme =
    donnees?.injoignables.length === 0 &&
    donnees.enEchec.length === 0 &&
    donnees.incidents.length === 0;

  return (
    <Ecran>
      <Stack.Screen options={{ title: t("titre") }} />
      <Rubriques onAller={aller} />
      {erreur ? (
        <Bandeau titre={t("erreur")} niveau="danger">
          {erreur}
        </Bandeau>
      ) : null}
      {donnees === null && !erreur ? <Chargement /> : null}
      {calme ? <Bandeau titre={t("calme")} niveau="success" /> : null}
      {donnees?.injoignables.map((node) => (
        <CarteMachine key={node.id} node={node} onPress={() => aller(`machines/${node.id}`)} />
      ))}
      {donnees?.enEchec.map((serveur) => (
        <CarteServeurEnEchec
          key={serveur.id}
          serveur={serveur}
          onPress={() => router.push(`/${instance.id}/serveur/${serveur.id}`)}
        />
      ))}
      {donnees?.incidents.map((incident) => (
        <CarteIncident
          key={incident.id}
          incident={incident}
          onPress={() => aller(`incidents/${incident.id}`)}
        />
      ))}
      {donnees ? (
        <CarteMiseAJour statut={donnees.statut} ecrire={ecrire} verifier={verifier} />
      ) : null}
      <Texte ton="discret">{t("webAide")}</Texte>
      <Bouton titre={t("ouvrirPanel")} variante="secondaire" onPress={() => panelWeb("/admin")} />
    </Ecran>
  );
}
