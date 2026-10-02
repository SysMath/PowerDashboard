import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useTranslations } from "use-intl";
import { Bandeau, Chargement, Ecran } from "@/composants/base";
import { Dossier, FilAriane } from "@/composants/fichiers";
import { useInstance } from "@/etat/instance";
import { useFichiers } from "@/hooks/useFichiers";
import { normaliser } from "@/noyau/fichiers";

/** Un dossier du serveur ; chaque sous-dossier ouvre un nouvel écran. */
export default function Fichiers() {
  const params = useLocalSearchParams<{ serveur: string; chemin?: string }>();
  const id = params.serveur;
  const chemin = normaliser(params.chemin ?? "/");
  const t = useTranslations("files");
  const router = useRouter();
  const { instance } = useInstance();
  const gestes = useFichiers(id, chemin);
  const base = `/${instance.id}/serveur/${id}`;
  const aller = (cible: string) =>
    router.push({ pathname: `${base}/fichiers`, params: { chemin: cible } });
  const ouvrir = (cible: string, dossier: boolean) =>
    dossier
      ? aller(cible)
      : router.push({ pathname: `${base}/editeur`, params: { fichier: cible } });

  return (
    <Ecran>
      <Stack.Screen options={{ title: chemin === "/" ? t("title") : chemin.split("/").pop() }} />
      <FilAriane chemin={chemin} onAller={aller} />
      {gestes.erreur ? <Bandeau titre={t("unreadable")}>{gestes.erreur}</Bandeau> : null}
      {gestes.donnees ? (
        <Dossier chemin={chemin} entrees={gestes.donnees} gestes={gestes} onOuvrir={ouvrir} />
      ) : gestes.erreur ? null : (
        <Chargement />
      )}
    </Ecran>
  );
}
