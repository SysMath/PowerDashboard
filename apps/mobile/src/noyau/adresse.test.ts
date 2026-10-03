import { describe, expect, it } from "vitest";
import { domaineDe, normaliserAdresse } from "./adresse";
import { depuisBase64, versBase64, versBase64Url, versHex } from "./base64";
import { comparerVersions } from "./versions";

describe("normaliserAdresse", () => {
  it("garde l'origine seule, en https://", () => {
    expect(normaliserAdresse("panel.example.com")).toEqual({
      adresse: "https://panel.example.com",
    });
    expect(normaliserAdresse("  https://Panel.Example.com/login?x=1#a ")).toEqual({
      adresse: "https://panel.example.com",
    });
    expect(normaliserAdresse("https://panel.example.com:8443/")).toEqual({
      adresse: "https://panel.example.com:8443",
    });
  });

  it("refuse le clair, les autres schémas et les identifiants dans l'adresse", () => {
    // En clair, le code de liaison et le jeton se liraient sur le réseau.
    expect(normaliserAdresse("http://panel.example.com")).toEqual({ erreur: "http" });
    expect(normaliserAdresse("javascript:alert(1)")).toEqual({ erreur: "invalide" });
    expect(normaliserAdresse("ftp://panel.example.com")).toEqual({ erreur: "invalide" });
    expect(normaliserAdresse("https://moi:secret@panel.example.com")).toEqual({
      erreur: "invalide",
    });
    expect(normaliserAdresse("   ")).toEqual({ erreur: "vide" });
  });

  it("montre le domaine exact, port compris", () => {
    expect(domaineDe("https://panel.example.com:8443")).toBe("panel.example.com:8443");
  });
});

describe("base64", () => {
  it("encode comme Node, en base64 et en base64url", () => {
    for (const taille of [0, 1, 2, 3, 31, 32, 65]) {
      const octets = new Uint8Array(Array.from({ length: taille }, (_, i) => (i * 37 + 11) % 256));
      expect(versBase64(octets)).toBe(Buffer.from(octets).toString("base64"));
      expect(versBase64Url(octets)).toBe(Buffer.from(octets).toString("base64url"));
      expect(Array.from(depuisBase64(versBase64(octets)))).toEqual(Array.from(octets));
    }
    expect(versHex(Uint8Array.from([0, 15, 255]))).toBe("000fff");
  });
});

describe("comparerVersions", () => {
  it("compare nombre par nombre, pas comme du texte", () => {
    expect(comparerVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(comparerVersions("1.0.0", "1.0.0")).toBe(0);
    expect(comparerVersions("0.9.9", "1.0.0")).toBeLessThan(0);
    expect(comparerVersions("1.2.0-rc.1", "1.2.0")).toBe(0);
  });
});
