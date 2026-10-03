import { describe, expect, it } from "vitest";
import { MARQUE_GRADLE, signatureGradle, signatureIos } from "./signature";

const GRADLE = `android {
    buildTypes {
        release {
            signingConfig signingConfigs.debug
        }
    }
}
`;

describe("signature des magasins", () => {
  it("ajoute à Gradle une signature lue dans l'environnement, une seule fois", () => {
    const une = signatureGradle(GRADLE);
    expect(une.startsWith(GRADLE.trimEnd())).toBe(true);
    expect(une).toContain('def gdMagasin = System.getenv("GD_ANDROID_KEYSTORE")');
    expect(une).toContain(
      "android.buildTypes.release.signingConfig = android.signingConfigs.magasin",
    );
    expect(signatureGradle(une)).toBe(une);
    expect(une.split(MARQUE_GRADLE).length).toBe(2);
  });

  it("n'écrit aucun secret dans le projet Gradle", () => {
    const bloc = signatureGradle(GRADLE).slice(GRADLE.trimEnd().length);
    for (const ligne of bloc.split("\n").filter((l) => /Password|keyAlias|storeFile/.test(l))) {
      expect(ligne).toMatch(/System\.getenv\("GD_ANDROID_\w+"\)|file\(gdMagasin\)/);
    }
  });

  it("signe à la main la seule configuration Release de l'application", () => {
    const section: Record<string, unknown> = {
      app_debug: { name: "Debug", buildSettings: { PRODUCT_BUNDLE_IDENTIFIER: '"fr.gd.app"' } },
      app_release: {
        name: "Release",
        buildSettings: { PRODUCT_BUNDLE_IDENTIFIER: '"fr.gd.app"', CODE_SIGN_STYLE: "Automatic" },
      },
      pod_release: {
        name: "Release",
        buildSettings: { PRODUCT_BUNDLE_IDENTIFIER: "org.cocoapods.x" },
      },
      app_release_comment: "Release",
    };
    const projet = { pbxXCBuildConfigurationSection: () => section };
    const reglees = signatureIos(projet, {
      identifiant: "fr.gd.app",
      equipe: "ABCDE12345",
      profil: "GameDashboard Magasin",
    });
    expect(reglees).toBe(1);
    expect(section.app_release).toEqual({
      name: "Release",
      buildSettings: {
        PRODUCT_BUNDLE_IDENTIFIER: '"fr.gd.app"',
        CODE_SIGN_STYLE: "Manual",
        DEVELOPMENT_TEAM: "ABCDE12345",
        CODE_SIGN_IDENTITY: '"Apple Distribution"',
        '"CODE_SIGN_IDENTITY[sdk=iphoneos*]"': '"Apple Distribution"',
        PROVISIONING_PROFILE_SPECIFIER: '"GameDashboard Magasin"',
      },
    });
    expect(section.app_debug).toEqual({
      name: "Debug",
      buildSettings: { PRODUCT_BUNDLE_IDENTIFIER: '"fr.gd.app"' },
    });
    expect(section.pod_release).toEqual({
      name: "Release",
      buildSettings: { PRODUCT_BUNDLE_IDENTIFIER: "org.cocoapods.x" },
    });
  });
});
