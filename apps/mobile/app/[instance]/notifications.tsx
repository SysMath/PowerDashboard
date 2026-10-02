import { Stack, useRouter } from "expo-router";
import { useTranslations } from "use-intl";
import { Bandeau, Bouton, Chargement, Ecran } from "@/composants/base";
import { ListeNotifications } from "@/composants/cloche";
import { useInstance } from "@/etat/instance";
import { useCloche } from "@/hooks/useServeurs";
import { ouvrirPanel } from "@/natif/navigateur";
import { cibleNotification } from "@/noyau/notifications";

/** La cloche du panel, relue à l'ouverture (ADR 0010 : « notifications : aucune »). */
export default function Notifications() {
  const t = useTranslations("mobile.cloche");
  const router = useRouter();
  const { instance } = useInstance();
  const { donnees, erreur, toutLire } = useCloche();

  return (
    <Ecran>
      <Stack.Screen options={{ title: t("titre") }} />
      {erreur ? <Bandeau titre={erreur} niveau="danger" /> : null}
      {donnees === null ? (
        <Chargement />
      ) : (
        <>
          {donnees.unread > 0 ? (
            <Bouton titre={t("toutLire")} variante="secondaire" onPress={() => void toutLire()} />
          ) : null}
          <ListeNotifications
            notifications={donnees.items}
            onOuvrir={(notification) => {
              const cible = cibleNotification(notification.href);
              if (cible && "serveur" in cible)
                router.push(`/${instance.id}/serveur/${cible.serveur}`);
              else if (cible) void ouvrirPanel(instance.adresse, cible.chemin);
            }}
          />
        </>
      )}
    </Ecran>
  );
}
