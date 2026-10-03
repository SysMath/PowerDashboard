import type { ExpoConfig } from "expo/config";

/**
 * Le manifeste de confidentialité d'iOS (`PrivacyInfo.xcprivacy`), écrit par
 * `expo prebuild` depuis app.config.ts. Apple refuse une version qui emploie
 * une interface « à raison exigée » sans la déclarer.
 *
 * - Aucun pistage, aucun domaine de pistage.
 * - Aucune donnée collectée par l'éditeur : ce qui part va au panel que la
 *   personne relie, ou au service de notifications (voir
 *   docs/confidentialite-application.md).
 * - Les interfaces déclarées sont celles de React Native et d'Expo, avec les
 *   raisons qu'Expo recommande : réglages de l'application (CA92.1), dates
 *   des fichiers de l'application (C617.1, 0A2A.1, 3B52.1), espace disque
 *   avant d'écrire (E174.1, 85F4.1), temps depuis le démarrage pour mesurer
 *   des durées (35F9.1).
 */
type Manifeste = NonNullable<NonNullable<ExpoConfig["ios"]>["privacyManifests"]>;

export const MANIFESTE_CONFIDENTIALITE = {
  NSPrivacyTracking: false,
  NSPrivacyTrackingDomains: [],
  NSPrivacyCollectedDataTypes: [],
  NSPrivacyAccessedAPITypes: [
    {
      NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryUserDefaults",
      NSPrivacyAccessedAPITypeReasons: ["CA92.1"],
    },
    {
      NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryFileTimestamp",
      NSPrivacyAccessedAPITypeReasons: ["C617.1", "0A2A.1", "3B52.1"],
    },
    {
      NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryDiskSpace",
      NSPrivacyAccessedAPITypeReasons: ["E174.1", "85F4.1"],
    },
    {
      NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategorySystemBootTime",
      NSPrivacyAccessedAPITypeReasons: ["35F9.1"],
    },
  ],
} satisfies Manifeste;
