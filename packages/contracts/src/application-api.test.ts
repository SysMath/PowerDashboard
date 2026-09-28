import { describe, expect, it } from "vitest";
import {
  APPLICATION_SCOPE_CATALOGUE,
  APPLICATION_SCOPES,
  type ApplicationScope,
  ApplicationServerCreate,
  ApplicationServerOwner,
  ApplicationUserCreate,
  ApplicationUserUpdate,
  hasApplicationScope,
  isApplicationScope,
  isUsableIdempotencyKey,
} from "./application-api";

describe("isApplicationScope", () => {
  it("reconnaît une portée du catalogue", () => {
    expect(isApplicationScope("servers.create")).toBe(true);
  });

  it("refuse une portée inventée", () => {
    expect(isApplicationScope("servers.everything")).toBe(false);
  });

  it("refuse une permission de serveur, qui appartient à l'autre système de clés", () => {
    // `power.restart` est une portée de clé **personnelle**. L'accepter ici
    // laisserait croire qu'une clé applicative peut redémarrer un serveur,
    // alors qu'aucune route de cette API ne le propose.
    expect(isApplicationScope("power.restart")).toBe(false);
  });
});

describe("hasApplicationScope", () => {
  it("accorde ce qui est explicitement accordé", () => {
    expect(hasApplicationScope(["servers.create"], "servers.create")).toBe(true);
  });

  it("n'accorde rien par joker", () => {
    // Le jour où une portée est ajoutée, un joker l'aurait donnée
    // rétroactivement à toutes les clés existantes.
    expect(hasApplicationScope(["*"], "users.delete")).toBe(false);
    expect(hasApplicationScope(["servers.*"], "servers.delete")).toBe(false);
  });

  it("ne déduit pas la lecture de l'écriture", () => {
    expect(hasApplicationScope(["users.write"], "users.read")).toBe(false);
  });

  it("ne déduit pas la suppression de la création", () => {
    // La confusion la plus coûteuse de la liste : un système qui provisionne
    // n'a aucune raison de pouvoir effacer.
    expect(hasApplicationScope(["servers.create"], "servers.delete")).toBe(false);
  });

  it("refuse tout à une clé sans portée", () => {
    for (const scope of APPLICATION_SCOPES) {
      expect(hasApplicationScope([], scope)).toBe(false);
    }
  });
});

describe("APPLICATION_SCOPE_CATALOGUE", () => {
  it("décrit exactement les portées existantes", () => {
    // Une portée absente du catalogue est vérifiable par l'API mais impossible
    // à accorder depuis l'écran : elle n'existe donc pour personne.
    const listed = APPLICATION_SCOPE_CATALOGUE.flatMap((group) =>
      group.scopes.map((entry) => entry.scope),
    ).sort();
    expect(listed).toEqual([...APPLICATION_SCOPES].sort());
  });

  it("ne décrit aucune portée deux fois", () => {
    const listed = APPLICATION_SCOPE_CATALOGUE.flatMap((group) =>
      group.scopes.map((entry) => entry.scope),
    );
    expect(new Set<ApplicationScope>(listed).size).toBe(listed.length);
  });
});

describe("isUsableIdempotencyKey", () => {
  it("refuse une clé trop courte pour être unique", () => {
    // Deux systèmes qui envoient « 1 » se verraient répondre la commande de
    // l'autre.
    expect(isUsableIdempotencyKey("1")).toBe(false);
    expect(isUsableIdempotencyKey("abc")).toBe(false);
  });

  it("accepte un identifiant de commande réaliste", () => {
    expect(isUsableIdempotencyKey("order-2026-000148")).toBe(true);
  });

  it("refuse une clé démesurée", () => {
    expect(isUsableIdempotencyKey("x".repeat(5000))).toBe(false);
  });

  it("ne se laisse pas tromper par des espaces", () => {
    expect(isUsableIdempotencyKey("        ")).toBe(false);
  });
});

/**
 * Corps de création de l'API applicative (ASVS 5.1.4, 13.2.2).
 *
 * Le défaut : aucun champ texte n'était borné. Une adresse, un nom ou une
 * variable d'un mégaoctet passaient la validation et n'étaient arrêtés que par
 * la base — `value too long`, donc une erreur 500 rendue à un système tiers
 * qui la rejoue, au lieu d'un refus qui dit quoi changer. Les bornes suivent
 * les colonnes qui reçoivent chaque champ.
 */
describe("corps de création de l'API applicative", () => {
  const compte = { email: "client@exemple.fr", nameFirst: "Ada", nameLast: "Lovelace" };
  const serveur = {
    ownerId: "0b0c1a4e-3c57-4c2e-9d36-3f1f5e9f0a11",
    eggId: "5f7c2d1e-8a0b-4c3d-9e2f-1a2b3c4d5e6f",
    name: "Survie",
    variables: { SERVER_JARFILE: "server.jar" },
  };

  it("acceptent un corps réaliste", () => {
    expect(ApplicationUserCreate.safeParse({ ...compte, externalId: "whmcs-148" }).success).toBe(
      true,
    );
    expect(ApplicationServerCreate.safeParse(serveur).success).toBe(true);
  });

  it("refusent un compte aux champs plus longs que leurs colonnes", () => {
    for (const trop of [
      { email: `${"a".repeat(250)}@exemple.fr` },
      { nameFirst: "a".repeat(101) },
      { nameLast: "a".repeat(101) },
      { externalId: "a".repeat(256) },
    ]) {
      expect(
        ApplicationUserCreate.safeParse({ ...compte, ...trop }).success,
        Object.keys(trop).join(),
      ).toBe(false);
    }
    expect(ApplicationUserUpdate.safeParse({ nameFirst: "a".repeat(101) }).success).toBe(false);
    expect(ApplicationUserUpdate.safeParse({ externalId: "a".repeat(256) }).success).toBe(false);
  });

  it("refusent un serveur au nom, aux identifiants ou aux variables démesurés", () => {
    for (const trop of [
      { name: "a".repeat(121) },
      { ownerId: "a".repeat(65) },
      { eggId: "a".repeat(65) },
      { planId: "a".repeat(65) },
      { locationId: "a".repeat(65) },
      { nodeId: "a".repeat(65) },
      { variables: { SERVER_JARFILE: "a".repeat(4097) } },
      { variables: { ["A".repeat(121)]: "1" } },
      {
        variables: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`VAR_${i}`, "1"])),
      },
    ]) {
      expect(ApplicationServerCreate.safeParse({ ...serveur, ...trop }).success).toBe(false);
    }
  });
});

/**
 * Changement de titulaire : un UUID, rien d'autre.
 *
 * L'identifiant part tel quel vers `users.id` : une valeur illisible y devenait
 * une erreur 500 de PostgreSQL, qu'une boutique prend pour une panne et rejoue.
 */
describe("corps du changement de titulaire", () => {
  it("accepte un identifiant de compte du panel", () => {
    expect(
      ApplicationServerOwner.safeParse({ ownerId: "0b0c1a4e-3c57-4c2e-9d36-3f1f5e9f0a11" }).success,
    ).toBe(true);
  });

  it("refuse un corps vide, un identifiant illisible ou démesuré", () => {
    for (const corps of [{}, { ownerId: "" }, { ownerId: "4271" }, { ownerId: "a".repeat(65) }]) {
      expect(ApplicationServerOwner.safeParse(corps).success, JSON.stringify(corps)).toBe(false);
    }
  });

  it("se demande par une portée à part, que le catalogue propose", () => {
    expect(isApplicationScope("servers.owner")).toBe(true);
    const accordables = APPLICATION_SCOPE_CATALOGUE.flatMap((g) => g.scopes.map((s) => s.scope));
    expect(accordables).toContain("servers.owner");
  });
});
