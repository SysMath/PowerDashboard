import { describe, expect, it } from "vitest";
import { policeMono } from "./police";

describe("police à chasse fixe", () => {
  it("nomme sous iOS une famille qui y existe", () => {
    // « monospace » n'existe pas sous iOS : la console y perdait ses colonnes.
    expect(policeMono("ios")).toBe("Menlo");
    expect(policeMono("android")).toBe("monospace");
  });
});
