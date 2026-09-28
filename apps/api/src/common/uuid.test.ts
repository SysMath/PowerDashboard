import { describe, expect, it } from "vitest";
import { isUuid } from "./uuid";

describe("isUuid", () => {
  it("reconnaît un UUID, quelle que soit la casse", () => {
    expect(isUuid("0b0c1a4e-3c57-4c2e-9d36-3f1f5e9f0a11")).toBe(true);
    expect(isUuid("0B0C1A4E-3C57-4C2E-9D36-3F1F5E9F0A11")).toBe(true);
  });

  it("refuse ce que PostgreSQL ne convertirait pas", () => {
    for (const valeur of [
      "",
      "4271",
      "nimporte-quoi",
      "0b0c1a4e3c574c2e9d363f1f5e9f0a11",
      null,
      42,
    ]) {
      expect(isUuid(valeur)).toBe(false);
    }
  });
});
