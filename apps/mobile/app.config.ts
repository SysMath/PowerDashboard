import type { ExpoConfig } from "expo/config";
import { IDENTIFIANT } from "./identifiant.ts";
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
  ],
  // Pas de mise à jour « à chaud » : chaque version passe par les magasins,
  // donc par leur vérification (ADR 0010, « Construire et publier »).
  updates: { enabled: false },
};

export default avecSignature(config, { identifiant: IDENTIFIANT });
