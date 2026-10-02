import type { AppPlatform } from "@gamedashboard/contracts";
import Constants from "expo-constants";
import { Platform } from "react-native";

/** La plateforme, telle que le panel la range. */
export const plateforme: AppPlatform = Platform.OS === "ios" ? "ios" : "android";

/** La version de l'application, envoyée au panel et comparée à sa version minimale. */
export const versionApplication: string = Constants.expoConfig?.version ?? "0.0.0";

/**
 * Le nom proposé pour ce téléphone, modifiable avant la liaison.
 *
 * iOS ne donne plus le nom choisi par l'utilisateur sans autorisation
 * particulière : on propose le modèle (« iPhone »), Android donne le sien.
 */
export function nomParDefaut(): string {
  if (Platform.OS === "ios") return Platform.isPad ? "iPad" : "iPhone";
  const constantes = Platform.constants as { Model?: string; Brand?: string };
  return constantes.Model?.trim() || "Android";
}
