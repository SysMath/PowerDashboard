import type { PowerSignal, ServerBlock } from "@gamedashboard/contracts";
import { Alert } from "react-native";
import { useTranslations } from "use-intl";
import { Bandeau, Bouton, Rangee } from "./base";

const SIGNAUX: PowerSignal[] = ["start", "restart", "stop", "kill"];

/**
 * Démarrer, redémarrer, arrêter, tuer : avec confirmation pour tout ce qui
 * coupe le serveur (ADR 0010). Les boutons fermés le sont pour les mêmes
 * raisons que sur le web (`closedSignals`).
 */
export function PanneauAlimentation(props: {
  fermes: Record<PowerSignal, boolean>;
  onSignal: (signal: PowerSignal) => Promise<void>;
}) {
  const t = useTranslations("mobile.alimentation");
  const tc = useTranslations("mobile.commun");
  const envoyer = (signal: PowerSignal) => {
    const agir = () => {
      props
        .onSignal(signal)
        .catch((erreur: unknown) =>
          Alert.alert(t("refuse"), erreur instanceof Error ? erreur.message : String(erreur)),
        );
    };
    if (signal === "start") return agir();
    Alert.alert(t(`confirmer.${signal}`), t("confirmerCorps"), [
      { text: tc("annuler"), style: "cancel" },
      { text: t(`signal.${signal}`), style: "destructive", onPress: agir },
    ]);
  };
  return (
    <Rangee>
      {SIGNAUX.map((signal) => (
        <Bouton
          key={signal}
          titre={t(`signal.${signal}`)}
          variante={signal === "start" ? "primaire" : signal === "kill" ? "danger" : "secondaire"}
          inactif={props.fermes[signal]}
          onPress={() => envoyer(signal)}
        />
      ))}
    </Rangee>
  );
}

/** Ce qui empêche le serveur d'obéir, avec le texte du web. */
export function BlocageServeur({ blocage }: { blocage: ServerBlock }) {
  return (
    <Bandeau titre={blocage.label} niveau={blocage.transient ? "info" : "warning"}>
      {blocage.body}
    </Bandeau>
  );
}
