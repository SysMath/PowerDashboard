import type { ExpoConfig } from "expo/config";
import { IDENTIFIANT } from "./identifiant.ts";
import { MANIFESTE_CONFIDENTIALITE } from "./magasins/confidentialite.ts";
import { avecSignature } from "./plugins/signature.ts";

/**
 * L'application mobile GameDashboard (ADR 0010).
 *
 * Une seule application, publiée sous le compte de l'éditeur, qui se lie à
 * n'importe quel panel auto-hébergé : aucune adresse de panel n'est écrite
 * ici. Le schéma `gamedashboard://` reçoit le retour de la liaison (PKCE) ;
 * pas de lien universel, que l'application ne pourrait déclarer pour chaque
 * domaine.
 */

/**
 * Version et numéro de construction, posés par `mobile.yml` : la version
 * vient de l'étiquette `mobile-vX.Y.Z`, le numéro de l'exécution, qui ne fait
 * que croître comme l'exigent les deux magasins.
 */
function lireVersions(env: NodeJS.ProcessEnv): { version: string; construction: number } {
  const version = env.GAMEDASHBOARD_MOBILE_VERSION || "1.0.0";
  const construction = Number(env.GAMEDASHBOARD_MOBILE_BUILD || "1");
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Version invalide : ${version}`);
  if (!Number.isSafeInteger(construction) || construction < 1) {
    throw new Error(`Numéro de construction invalide : ${construction}`);
  }
  return { version, construction };
}

const { version, construction } = lireVersions(process.env);

/**
 * Notifications poussées (ADR 0010, lot 4), posées par `mobile.yml` depuis
 * l'environnement « magasins » :
 * - `EXPO_PROJECT_ID` : le projet Expo de l'éditeur, auquel Expo Push rattache
 *   les jetons des téléphones. Absent, l'application ne demande aucune
 *   permission et relève la cloche de chaque panel à l'ouverture ;
 * - `GAMEDASHBOARD_PUSH_RELAYS` : les relais de l'éditeur (origines https,
 *   séparées par des virgules), les seuls auxquels l'application confie son
 *   jeton Expo ;
 * - `GD_GOOGLE_SERVICES` : le chemin du `google-services.json` de Firebase,
 *   par lequel Android reçoit (FCM).
 */
function lirePousse(env: NodeJS.ProcessEnv) {
  const projet = env.EXPO_PROJECT_ID?.trim() || undefined;
  if (projet && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projet)) {
    throw new Error(`Projet Expo invalide : ${projet}`);
  }
  return {
    projet,
    relais: env.GAMEDASHBOARD_PUSH_RELAYS?.trim() ?? "",
    googleServices: env.GD_GOOGLE_SERVICES?.trim() || undefined,
  };
}

const pousse = lirePousse(process.env);

const config: ExpoConfig = {
  name: "GameDashboard",
  slug: "gamedashboard",
  version,
  scheme: "gamedashboard",
  orientation: "portrait",
  userInterfaceStyle: "automatic",
  platforms: ["ios", "android"],
  ios: {
    bundleIdentifier: IDENTIFIANT,
    buildNumber: String(construction),
    supportsTablet: true,
    config: { usesNonExemptEncryption: false },
    // Exigé par Apple depuis 2024 : voir magasins/confidentialite.ts.
    privacyManifests: MANIFESTE_CONFIDENTIALITE,
    infoPlist: {
      NSFaceIDUsageDescription:
        "Face ID ouvre la clé qui relie ce téléphone à vos panels et confirme les gestes importants.",
    },
  },
  android: {
    package: IDENTIFIANT,
    versionCode: construction,
    // Le trousseau ne doit pas partir dans une sauvegarde : la clé d'appareil
    // n'en sortirait pas, et le secret restauré seul serait rejoué.
    allowBackup: false,
    ...(pousse.googleServices ? { googleServicesFile: pousse.googleServices } : {}),
    permissions: ["android.permission.USE_BIOMETRIC", "android.permission.CAMERA"],
    // Ajoutées d'office par le modèle d'Expo, inutiles ici : l'application
    // n'écrit aucun fichier partagé et ne dessine pas par-dessus les autres.
    blockedPermissions: [
      "android.permission.RECORD_AUDIO",
      "android.permission.READ_EXTERNAL_STORAGE",
      "android.permission.WRITE_EXTERNAL_STORAGE",
      "android.permission.SYSTEM_ALERT_WINDOW",
    ],
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    [
      "expo-local-authentication",
      {
        faceIDPermission:
          "Face ID ouvre la clé qui relie ce téléphone à vos panels et confirme les gestes importants.",
      },
    ],
    [
      "expo-camera",
      {
        cameraPermission: "La caméra lit le code QR affiché par votre panel.",
        microphonePermission: false,
        recordAudioAndroid: false,
      },
    ],
    // `production` : le profil de distribution porte le droit aux
    // notifications d'Apple (aps-environment).
    ["expo-notifications", { mode: "production", defaultChannel: "default" }],
  ],
  extra: {
    ...(pousse.projet ? { eas: { projectId: pousse.projet } } : {}),
    relais: pousse.relais,
  },
  // Pas de mise à jour « à chaud » : chaque version passe par les magasins,
  // donc par leur vérification (ADR 0010, « Construire et publier »).
  updates: { enabled: false },
};

export default avecSignature(config, { identifiant: IDENTIFIANT });
