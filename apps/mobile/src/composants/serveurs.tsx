import type { ClientServerView } from "@gamedashboard/contracts";
import { formatMb } from "@gamedashboard/sdk/format";
import { useTranslations } from "use-intl";
import { lireServeur } from "@/noyau/alimentation";
import { Carte, Pastille, Rangee, Texte } from "./base";

/** Le ton du point d'état : vert en ligne, orange en transition, gris sinon. */
export function niveauEtat(etat: string | null): "success" | "warning" | "danger" | "neutre" {
  if (etat === "running") return "success";
  if (etat === "starting" || etat === "stopping") return "warning";
  if (etat === "crash_loop" || etat === "install_failed") return "danger";
  return "neutre";
}

/** Le libellé d'état : celui du blocage s'il y en a un, sinon celui du conteneur. */
export function useLibelleEtat() {
  const t = useTranslations("serverState");
  return (serveur: ClientServerView, etat: string | null) => {
    const { blocage } = lireServeur(serveur, etat);
    if (blocage) return blocage.label;
    const lu = etat ?? serveur.runtimeState ?? "offline";
    return t.has(lu) ? t(lu) : t("offline");
  };
}

export function CarteServeur({
  serveur,
  onPress,
}: {
  serveur: ClientServerView;
  onPress: () => void;
}) {
  const libelle = useLibelleEtat();
  const t = useTranslations("mobile.serveurs");
  const { blocage, etat } = lireServeur(serveur, null);
  return (
    <Carte onPress={onPress}>
      <Rangee>
        <Pastille niveau={blocage ? "warning" : niveauEtat(etat)} />
        <Texte>{serveur.name}</Texte>
      </Rangee>
      <Texte ton="discret">
        {libelle(serveur, null)} · {serveur.game}
        {serveur.players !== null ? ` · ${t("joueurs", { n: serveur.players })}` : ""}
      </Texte>
      {serveur.memoryMb !== null ? (
        <Texte ton="discret">
          {t("memoire", {
            utilise: formatMb(serveur.memoryMb),
            max: formatMb(serveur.memoryMaxMb),
          })}
        </Texte>
      ) : null}
    </Carte>
  );
}
