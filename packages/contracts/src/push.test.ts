import { describe, expect, it } from "vitest";
import {
  appPushBodySchema,
  pushMessageSchema,
  pushMode,
  pushRelayUrl,
  pushServerName,
} from "./push";

const NOTIFICATION = "0b9b8f2e-4d6c-4b1e-9a51-2f3d1c0e7a11";

describe("mode des notifications poussées", () => {
  it("passe en direct avec le jeton Expo, par le relais sinon, et se tait sans rien", () => {
    expect(pushMode({ EXPO_ACCESS_TOKEN: "jeton" })).toBe("direct");
    expect(pushMode({ PUSH_RELAY_URL: "https://relais.exemple.fr" })).toBe("relais");
    expect(pushMode({})).toBe("aucune");
  });

  it("laisse l'exploitant refuser le relais", () => {
    expect(pushMode({ PUSH_MODE: "aucune", PUSH_RELAY_URL: "https://relais.exemple.fr" })).toBe(
      "aucune",
    );
  });

  it("n'accepte qu'un relais en https://, sans identifiants", () => {
    expect(pushRelayUrl({ PUSH_RELAY_URL: "https://relais.exemple.fr/" })).toBe(
      "https://relais.exemple.fr",
    );
    expect(pushRelayUrl({ PUSH_RELAY_URL: "http://relais.exemple.fr" })).toBe(null);
    expect(pushRelayUrl({ PUSH_RELAY_URL: "https://a:b@relais.exemple.fr" })).toBe(null);
    expect(pushMode({ PUSH_RELAY_URL: "http://relais.exemple.fr" })).toBe("aucune");
  });
});

describe("contenu poussé", () => {
  it("ne transporte que le type, le nom du serveur et l'identifiant", () => {
    const message = pushMessageSchema.parse({
      type: "server.unreachable",
      serveur: "Survie",
      notification: NOTIFICATION,
      langue: "fr",
      // Rien d'autre ne passe, pas même par inadvertance.
      corps: "adresse 10.0.0.4, ligne de console…",
    });
    expect(Object.keys(message).sort()).toEqual(["langue", "notification", "serveur", "type"]);
  });

  it("refuse un type que le panel n'émet pas : aucun texte libre ne part", () => {
    const essai = { serveur: null, notification: NOTIFICATION, langue: "fr" };
    expect(pushMessageSchema.safeParse({ ...essai, type: "Vous avez gagné" }).success).toBe(false);
  });

  it("borne le nom du serveur", () => {
    expect(pushServerName(`  Survie\n${"x".repeat(100)}`)?.length).toBe(64);
    expect(pushServerName("   ")).toBe(null);
  });
});

describe("dépôt de l'application", () => {
  it("accepte un jeton Expo en direct et une poignée par le relais, rien d'autre", () => {
    expect(
      appPushBodySchema.safeParse({ mode: "direct", poignee: "ExponentPushToken[abcdEFGH1234]" })
        .success,
    ).toBe(true);
    expect(appPushBodySchema.safeParse({ mode: "relais", poignee: "a".repeat(43) }).success).toBe(
      true,
    );
    expect(appPushBodySchema.safeParse({ mode: "direct", poignee: "a".repeat(43) }).success).toBe(
      false,
    );
    expect(appPushBodySchema.safeParse({ mode: "aucune", poignee: "x" }).success).toBe(false);
  });
});
