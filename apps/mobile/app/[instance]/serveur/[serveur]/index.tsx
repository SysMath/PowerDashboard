import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useTranslations } from "use-intl";
import { BlocageServeur, PanneauAlimentation } from "@/composants/alimentation";
import {
  Bandeau,
  Bouton,
  Carte,
  Chargement,
  Ecran,
  Pastille,
  Rangee,
  Texte,
} from "@/composants/base";
import { niveauEtat, useLibelleEtat } from "@/composants/serveurs";
import { useInstance } from "@/etat/instance";
import { useServeur } from "@/hooks/useServeurs";
import { lireServeur } from "@/noyau/alimentation";

/** Un serveur : son état, l'alimentation, et l'accès à la console et aux joueurs. */
export default function Serveur() {
  const { serveur: id } = useLocalSearchParams<{ serveur: string }>();
  const t = useTranslations("mobile.serveur");
  const tn = useTranslations("nodeOutage");
  const router = useRouter();
  const { instance } = useInstance();
  const { donnees: serveur, erreur, alimenter } = useServeur(id);
  const libelle = useLibelleEtat();

  if (!serveur) return erreur ? <Bandeau titre={erreur} niveau="danger" /> : <Chargement />;
  const { blocage, etat, fermes } = lireServeur(serveur, null);
  const muette = serveur.nodeUnreachableSince !== null;

  return (
    <Ecran>
      <Stack.Screen options={{ title: serveur.name }} />
      <Carte>
        <Rangee>
          <Pastille niveau={blocage ? "warning" : niveauEtat(etat)} />
          <Texte>{libelle(serveur, null)}</Texte>
        </Rangee>
        <Texte ton="discret">
          {serveur.game} · {serveur.address}
        </Texte>
      </Carte>
      {muette ? (
        <Bandeau titre={tn("title", { node: serveur.nodeName })} niveau="warning">
          {tn("body")}
        </Bandeau>
      ) : blocage ? (
        <BlocageServeur blocage={blocage} />
      ) : null}
      <PanneauAlimentation fermes={fermes} onSignal={alimenter} />
      <Bouton
        titre={t("console")}
        variante="secondaire"
        inactif={muette}
        onPress={() => router.push(`/${instance.id}/serveur/${id}/console`)}
      />
      <Bouton
        titre={t("joueurs")}
        variante="secondaire"
        onPress={() => router.push(`/${instance.id}/serveur/${id}/joueurs`)}
      />
    </Ecran>
  );
}
