import { Alert } from "react-native";
import { useTranslations } from "use-intl";
import { useInstance } from "@/etat/instance";
import { ouvrirPanel } from "@/natif/navigateur";

/** Ouvre une page du panel dans le navigateur ; la démo n'en a pas, elle le dit. */
export function usePanelWeb() {
  const { instance, demo } = useInstance();
  const t = useTranslations("mobile.demo");
  return (chemin?: string) => {
    if (demo) Alert.alert(t("titre"), t("web"));
    else void ouvrirPanel(instance.adresse, chemin);
  };
}
