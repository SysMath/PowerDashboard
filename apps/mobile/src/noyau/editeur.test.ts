import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FICHIER_CONFIDENTIALITE, POLITIQUE_CONFIDENTIALITE } from "./editeur";

describe("politique de confidentialité", () => {
  it("vise un fichier qui existe dans le dépôt, sur la branche principale", () => {
    const racine = fileURLToPath(new URL("../../../../", import.meta.url));
    expect(existsSync(`${racine}${FICHIER_CONFIDENTIALITE}`)).toBe(true);
    expect(POLITIQUE_CONFIDENTIALITE).toMatch(
      /^https:\/\/github\.com\/SysMath\/PowerDashboard\/blob\/main\/docs\//,
    );
  });
});
