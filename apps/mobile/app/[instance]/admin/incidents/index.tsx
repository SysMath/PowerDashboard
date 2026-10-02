import { Stack, useRouter } from "expo-router";
import { useTranslations } from "use-intl";
import { CarteIncident } from "@/composants/administration";
import { Bandeau, Bouton, Chargement, Ecran, Texte } from "@/composants/base";
import { useInstance } from "@/etat/instance";
import { useIncidents } from "@/hooks/useAdministration";
import { useRole } from "@/hooks/useRevendeur";
import { estOuvert } from "@/noyau/administration";

/** Les incidents de la page d'état : les ouverts d'abord, puis les derniers clos. */
export default function Incidents() {
  const t = useTranslations("mobile.administration.incidents");
  const router = useRouter();
  const { instance } = useInstance();
  const ecrire = useRole() === "admin";
  const { donnees, erreur } = useIncidents();
  const ouverts = donnees?.filter(estOuvert) ?? [];
  const clos = donnees?.filter((incident) => !estOuvert(incident)).slice(0, 10) ?? [];
  const ouvrir = (id: string) => router.push(`/${instance.id}/admin/incidents/${id}`);

  return (
    <Ecran>
      <Stack.Screen options={{ title: t("titre") }} />
      {ecrire ? (
        <Bouton
          titre={t("nouveau")}
          onPress={() => router.push(`/${instance.id}/admin/incidents/nouveau`)}
        />
      ) : null}
      {erreur ? <Bandeau titre={erreur} niveau="danger" /> : null}
      {donnees === null && !erreur ? <Chargement /> : null}
      {donnees && ouverts.length === 0 ? (
        <Bandeau titre={t("aucunOuvert")} niveau="success" />
      ) : null}
      {ouverts.map((incident) => (
        <CarteIncident key={incident.id} incident={incident} onPress={() => ouvrir(incident.id)} />
      ))}
      {clos.length > 0 ? <Texte ton="titre">{t("clos")}</Texte> : null}
      {clos.map((incident) => (
        <CarteIncident key={incident.id} incident={incident} onPress={() => ouvrir(incident.id)} />
      ))}
    </Ecran>
  );
}
