import { describe, expect, it } from "vitest";
import { MANIFESTE_CONFIDENTIALITE } from "./confidentialite";

/** Les raisons qu'Apple admet, catégorie par catégorie (documentation d'Apple). */
const RAISONS: Record<string, string[]> = {
  NSPrivacyAccessedAPICategoryUserDefaults: ["CA92.1", "1C8F.1", "C56D.1", "AC6B.1"],
  NSPrivacyAccessedAPICategoryFileTimestamp: ["DDA9.1", "C617.1", "3B52.1", "0A2A.1"],
  NSPrivacyAccessedAPICategoryDiskSpace: ["85F4.1", "E174.1", "7D9E.1", "B728.1"],
  NSPrivacyAccessedAPICategorySystemBootTime: ["35F9.1", "8FFB.1", "3D61.1"],
  NSPrivacyAccessedAPICategoryActiveKeyboards: ["3EC4.1", "54BD.1"],
};

describe("manifeste de confidentialité d'iOS", () => {
  it("ne piste pas et ne déclare aucune collecte par l'éditeur", () => {
    expect(MANIFESTE_CONFIDENTIALITE.NSPrivacyTracking).toBe(false);
    expect(MANIFESTE_CONFIDENTIALITE.NSPrivacyTrackingDomains).toEqual([]);
    expect(MANIFESTE_CONFIDENTIALITE.NSPrivacyCollectedDataTypes).toEqual([]);
  });

  it("ne donne que des raisons qu'Apple admet, une catégorie une seule fois", () => {
    const categories = MANIFESTE_CONFIDENTIALITE.NSPrivacyAccessedAPITypes.map(
      (entree) => entree.NSPrivacyAccessedAPIType,
    );
    expect(new Set(categories).size).toBe(categories.length);
    for (const entree of MANIFESTE_CONFIDENTIALITE.NSPrivacyAccessedAPITypes) {
      const admises = RAISONS[entree.NSPrivacyAccessedAPIType] ?? [];
      expect(entree.NSPrivacyAccessedAPITypeReasons.length).toBeGreaterThan(0);
      for (const raison of entree.NSPrivacyAccessedAPITypeReasons) {
        expect(admises, entree.NSPrivacyAccessedAPIType).toContain(raison);
      }
    }
  });
});
