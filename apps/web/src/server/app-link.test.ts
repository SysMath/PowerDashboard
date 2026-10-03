import { APP_REDIRECT_URI } from "@gamedashboard/contracts";
import { describe, expect, it } from "vitest";
import { appLinkReturn, decodeAppLink, encodeAppLink, readAppLinkQuery } from "./app-link";

/**
 * Demande de liaison de l'application mobile, côté interface (ADR 0010).
 *
 * Le code ne doit partir que vers l'application, jamais vers une adresse
 * venue de la demande, et un cookie fabriqué à la main ne doit rien ouvrir.
 */

const adresse = new URLSearchParams({
  code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  code_challenge_method: "S256",
  state: "etat-de-la-liaison-1234",
  device_name: "iPhone de Matheo",
  platform: "ios",
  redirect_uri: APP_REDIRECT_URI,
});

describe("demande de liaison", () => {
  it("se lit dans l'adresse, traverse le cookie et se relit à l'identique", () => {
    const demande = readAppLinkQuery(adresse);
    expect(demande?.device_name).toBe("iPhone de Matheo");
    expect(decodeAppLink(encodeAppLink(demande as never))).toEqual(demande);
  });

  it("refuse une adresse de retour étrangère", () => {
    const piege = new URLSearchParams(adresse);
    piege.set("redirect_uri", "https://evil.example/recu");
    expect(readAppLinkQuery(piege)).toBeNull();
  });

  it("refuse un cookie illisible ou falsifié", () => {
    expect(decodeAppLink(undefined)).toBeNull();
    expect(decodeAppLink("pas du base64 {")).toBeNull();
    const falsifie = Buffer.from(
      JSON.stringify({ ...Object.fromEntries(adresse), redirect_uri: "https://evil.example" }),
    ).toString("base64url");
    expect(decodeAppLink(falsifie)).toBeNull();
  });

  it("rend la main à l'application seulement, avec le state", () => {
    const retour = new URL(appLinkReturn({ state: "etat-1234567890123" }, { code: "abc" }));
    expect(`${retour.protocol}//${retour.host}`).toBe(APP_REDIRECT_URI);
    expect(retour.searchParams.get("code")).toBe("abc");
    expect(retour.searchParams.get("state")).toBe("etat-1234567890123");

    const refus = new URL(
      appLinkReturn({ state: "etat-1234567890123" }, { error: "access_denied" }),
    );
    expect(refus.searchParams.get("error")).toBe("access_denied");
    expect(refus.searchParams.has("code")).toBe(false);
  });
});
