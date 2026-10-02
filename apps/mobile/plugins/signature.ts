import { type ConfigPlugin, withAppBuildGradle, withXcodeProject } from "expo/config-plugins.js";

/**
 * Signature des binaires publiés (ADR 0010, « Construire et publier »).
 *
 * Les projets natifs sortent de `expo prebuild` à chaque construction : la
 * signature s'y pose ici, jamais à la main. Aucun secret n'est écrit dans un
 * fichier : Gradle lit la clé d'envoi dans l'environnement de `mobile.yml`
 * au moment de compiler, et Xcode ne reçoit que l'équipe et le nom du profil,
 * qui n'ouvrent rien.
 */

export const MARQUE_GRADLE = "// GameDashboard : signature des magasins";

const BLOC_GRADLE = `${MARQUE_GRADLE} (apps/mobile/plugins/signature.ts).
// Lue à la compilation dans l'environnement de mobile.yml, jamais écrite dans
// un fichier. Sans elle, la version de publication garde la clé de débogage
// du modèle d'Expo et ne part dans aucun magasin.
def gdMagasin = System.getenv("GD_ANDROID_KEYSTORE")
if (gdMagasin) {
    android.signingConfigs.create("magasin") {
        storeFile = file(gdMagasin)
        storePassword = System.getenv("GD_ANDROID_KEYSTORE_PASSWORD")
        keyAlias = System.getenv("GD_ANDROID_KEY_ALIAS")
        keyPassword = System.getenv("GD_ANDROID_KEY_PASSWORD")
    }
    android.buildTypes.release.signingConfig = android.signingConfigs.magasin
}
`;

/** Ajoute la signature des magasins au `build.gradle` de l'application, une fois. */
export function signatureGradle(texte: string): string {
  if (texte.includes(MARQUE_GRADLE)) return texte;
  return `${texte.trimEnd()}\n\n${BLOC_GRADLE}`;
}

export interface ReglagesIos {
  identifiant: string;
  equipe: string;
  profil: string;
}

interface ProjetXcode {
  pbxXCBuildConfigurationSection(): Record<string, unknown>;
}

interface ConfigurationXcode {
  name?: string;
  buildSettings?: Record<string, string>;
}

const sansGuillemets = (valeur: string | undefined) => valeur?.replace(/^"(.*)"$/, "$1");

/**
 * Signature manuelle de la seule cible de l'application, en publication.
 *
 * Passés à `xcodebuild`, ces réglages vaudraient pour chaque cible, y compris
 * celles de CocoaPods, qui refusent un profil : ils se posent donc dans le
 * projet, sur la configuration `Release` dont l'identifiant est le nôtre.
 * Rend le nombre de configurations réglées.
 */
export function signatureIos(projet: ProjetXcode, reglages: ReglagesIos): number {
  let reglees = 0;
  for (const valeur of Object.values(projet.pbxXCBuildConfigurationSection())) {
    if (typeof valeur !== "object" || valeur === null) continue;
    const { name, buildSettings } = valeur as ConfigurationXcode;
    if (name !== "Release" || !buildSettings) continue;
    if (sansGuillemets(buildSettings.PRODUCT_BUNDLE_IDENTIFIER) !== reglages.identifiant) continue;
    buildSettings.CODE_SIGN_STYLE = "Manual";
    buildSettings.DEVELOPMENT_TEAM = reglages.equipe;
    // Les deux formes : le projet d'Expo pose la conditionnelle au niveau du
    // projet, que la cible remplace ainsi sans ambiguïté.
    buildSettings.CODE_SIGN_IDENTITY = '"Apple Distribution"';
    buildSettings['"CODE_SIGN_IDENTITY[sdk=iphoneos*]"'] = '"Apple Distribution"';
    buildSettings.PROVISIONING_PROFILE_SPECIFIER = JSON.stringify(reglages.profil);
    reglees += 1;
  }
  return reglees;
}

/**
 * Le greffon d'Expo. Côté iOS, il ne règle rien sans `GD_IOS_EQUIPE` et
 * `GD_IOS_PROFIL` (posés par `mobile.yml`) : un `prebuild` de développement
 * garde la signature automatique de Xcode.
 */
export const avecSignature: ConfigPlugin<{ identifiant: string }> = (config, { identifiant }) => {
  let suite = withAppBuildGradle(config, (mod) => {
    mod.modResults.contents = signatureGradle(mod.modResults.contents);
    return mod;
  });
  const equipe = process.env.GD_IOS_EQUIPE;
  const profil = process.env.GD_IOS_PROFIL;
  if (equipe && profil) {
    suite = withXcodeProject(suite, (mod) => {
      if (signatureIos(mod.modResults, { identifiant, equipe, profil }) === 0) {
        throw new Error(`Aucune configuration Release pour ${identifiant} dans le projet Xcode.`);
      }
      return mod;
    });
  }
  return suite;
};
