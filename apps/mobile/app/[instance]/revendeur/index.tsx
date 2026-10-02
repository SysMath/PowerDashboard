import { Stack, useRouter } from "expo-router";
import { useTranslations } from "use-intl";
import { Bandeau, Bouton, Carte, Chargement, Ecran, Texte } from "@/composants/base";
import { CarteEnveloppe } from "@/composants/revendeur";
import { useInstance } from "@/etat/instance";
import { useParc } from "@/hooks/useRevendeur";
import { ouvrirPanel } from "@/natif/navigateur";
import { trierClients } from "@/noyau/revendeur";

/** L'espace revendeur : l'enveloppe, la consommation, les clients. */
export default function Revendeur() {
  const t = useTranslations("mobile.revendeur");
  const router = useRouter();
  const { instance } = useInstance();
  const { donnees, erreur } = useParc();

  return (
    <Ecran>
      <Stack.Screen options={{ title: t("titre") }} />
      {erreur ? (
        <Bandeau titre={t("erreur")} niveau="danger">
          {erreur}
        </Bandeau>
      ) : null}
      {donnees === null ? (
        erreur ? null : (
          <Chargement />
        )
      ) : (
        <>
          <CarteEnveloppe rapport={donnees.quota} />
          <Bouton
            titre={t("consommation")}
            variante="secondaire"
            onPress={() => router.push(`/${instance.id}/revendeur/consommation`)}
          />
          <Texte ton="titre">{t("clients")}</Texte>
          {donnees.clients.length === 0 ? <Bandeau titre={t("aucunClient")} /> : null}
          {trierClients(donnees.clients).map((client) => (
            <Carte
              key={client.id}
              onPress={() => router.push(`/${instance.id}/revendeur/client/${client.id}`)}
            >
              <Texte>{client.name}</Texte>
              <Texte ton="discret">
                {client.email} · {t("nbServeurs", { n: client.servers })}
              </Texte>
            </Carte>
          ))}
        </>
      )}
      <Texte ton="discret">{t("webAide")}</Texte>
      <Bouton
        titre={t("ouvrirPanel")}
        variante="secondaire"
        onPress={() => ouvrirPanel(instance.adresse, "/reseller")}
      />
    </Ecran>
  );
}
