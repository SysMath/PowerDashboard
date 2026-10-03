import * as SecureStore from "expo-secure-store";
import type { Coffre } from "@/noyau/outils";

/**
 * Le trousseau du téléphone, par expo-secure-store.
 *
 * `WHEN_UNLOCKED_THIS_DEVICE_ONLY` : lisible seulement téléphone déverrouillé,
 * jamais copié vers une sauvegarde ni un autre appareil. Pas d'authentification
 * par valeur : c'est la clé d'appareil qui l'exige, et un secret lu sans elle
 * ne sert à rien (le renouvellement doit être signé).
 */
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export const coffre: Coffre = {
  lire: (cle) => SecureStore.getItemAsync(cle, OPTIONS),
  ecrire: (cle, valeur) => SecureStore.setItemAsync(cle, valeur, OPTIONS),
  effacer: (cle) => SecureStore.deleteItemAsync(cle, OPTIONS),
};
