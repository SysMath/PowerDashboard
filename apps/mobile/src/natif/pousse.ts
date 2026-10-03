import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { lireRelaisConnus } from "@/noyau/pousse";

/**
 * Les notifications poussées du téléphone, par expo-notifications (ADR 0010).
 *
 * Le projet Expo de l'éditeur et ses relais viennent de la construction
 * (`app.config.ts`). Sans projet, l'application ne demande rien : chaque
 * panel relève alors sa cloche à l'ouverture, comme en mode `aucune`.
 */

const extra = (Constants.expoConfig?.extra ?? {}) as {
  eas?: { projectId?: string };
  relais?: string;
};

const projet = extra.eas?.projectId;

/** Les relais de l'éditeur, seuls à recevoir le jeton Expo du téléphone. */
export const relaisConnus = lireRelaisConnus(extra.relais);

/** Canal Android des alertes ; Expo Push y range ce qui arrive sans canal. */
const CANAL = "default";

// Une notification reçue l'application ouverte s'affiche comme les autres.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/**
 * Le jeton Expo du téléphone, après la permission ; `null` si elle est
 * refusée ou si la construction n'a pas de projet Expo. La permission n'est
 * demandée qu'une fois : un refus est respecté jusqu'aux réglages du système.
 */
export async function jetonExpo(nomCanal: string): Promise<string | null> {
  if (!projet) return null;
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync(CANAL, {
      name: nomCanal,
      importance: Notifications.AndroidImportance.HIGH,
    });
  }
  let permission = await Notifications.getPermissionsAsync();
  if (!permission.granted && permission.canAskAgain) {
    permission = await Notifications.requestPermissionsAsync();
  }
  if (!permission.granted) return null;
  try {
    return (await Notifications.getExpoPushTokenAsync({ projectId: projet })).data;
  } catch {
    // Services de Google absents, réseau coupé : on retentera à la prochaine ouverture.
    return null;
  }
}

export const useDernierToucher = Notifications.useLastNotificationResponse;
export const TOUCHER_PAR_DEFAUT = Notifications.DEFAULT_ACTION_IDENTIFIER;
