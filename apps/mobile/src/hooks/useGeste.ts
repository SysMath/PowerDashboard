import { useCallback } from "react";
import { Alert } from "react-native";
import { useTranslations } from "use-intl";
import { PRESENCE_REFUSEE } from "@/noyau/outils";

/**
 * Lance un geste et dit son refus. Une biométrie annulée ne dit rien : la
 * personne vient de renoncer, et rien n'est parti.
 */
export function useGeste() {
  const t = useTranslations("mobile.commun");
  return useCallback(
    async (geste: () => Promise<unknown>, titre?: string): Promise<boolean> => {
      try {
        await geste();
        return true;
      } catch (erreur) {
        const message = erreur instanceof Error ? erreur.message : String(erreur);
        if (message !== PRESENCE_REFUSEE) Alert.alert(titre ?? t("refuse"), message);
        return false;
      }
    },
    [t],
  );
}

/** Demande confirmation, puis lance le geste (biométrie comprise s'il est protégé). */
export function useConfirme() {
  const t = useTranslations("mobile.commun");
  const geste = useGeste();
  return useCallback(
    (
      texte: { titre: string; corps: string; bouton: string },
      action: () => Promise<unknown>,
      danger = false,
    ) =>
      Alert.alert(texte.titre, texte.corps, [
        { text: t("annuler"), style: "cancel" },
        {
          text: texte.bouton,
          style: danger ? "destructive" : "default",
          onPress: () => void geste(action),
        },
      ]),
    [t, geste],
  );
}
