import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  freshSignature,
  importDevicePublicKey,
  pkceChallenge,
  verifyDeviceSignature,
} from "./app-device-crypto";

/** Vérifications de la clé d'appareil (ADR 0010) : P-256 seulement, DER. */

function p256() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { privateKey, spki: publicKey.export({ format: "der", type: "spki" }) };
}

describe("clé d'appareil", () => {
  it("lit une clé SPKI et un point brut d'iOS, en base64 ou base64url", () => {
    const { spki } = p256();
    expect(importDevicePublicKey(spki.toString("base64"))).not.toBeNull();
    expect(importDevicePublicKey(spki.toString("base64url"))).not.toBeNull();
    expect(importDevicePublicKey(spki.subarray(-65).toString("base64"))).not.toBeNull();
  });

  it("refuse une autre courbe, une clé RSA et n'importe quoi", () => {
    const autre = generateKeyPairSync("ec", { namedCurve: "secp384r1" }).publicKey;
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey;
    for (const cle of [autre, rsa]) {
      expect(
        importDevicePublicKey(cle.export({ format: "der", type: "spki" }).toString("base64")),
      ).toBeNull();
    }
    expect(importDevicePublicKey("pas-une-cle")).toBeNull();
  });

  it("vérifie une signature DER, et seulement pour son message", () => {
    const { privateKey, spki } = p256();
    const signature = sign("sha256", Buffer.from("bonjour"), {
      key: privateKey,
      dsaEncoding: "der",
    });
    const cle = spki.toString("base64");
    expect(verifyDeviceSignature(cle, "bonjour", signature.toString("base64url"))).toBe(true);
    expect(verifyDeviceSignature(cle, "au revoir", signature.toString("base64url"))).toBe(false);
    expect(verifyDeviceSignature(cle, "bonjour", "AAAA")).toBe(false);
  });
});

describe("PKCE et fraîcheur", () => {
  it("calcule le défi S256 du RFC 7636 (annexe B)", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
    expect(pkceChallenge("x")).toBe(createHash("sha256").update("x").digest("base64url"));
  });

  it("borne l'écart d'horloge dans les deux sens", () => {
    expect(freshSignature(1_000, 1_000 + 299_000, 300_000)).toBe(true);
    expect(freshSignature(1_000 + 301_000, 1_000, 300_000)).toBe(false);
  });
});
