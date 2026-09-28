import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { ApplicationController } from "../modules/application/application.controller";
import { ServerFeaturesController } from "../modules/client/server-features.controller";
import { BrandingController } from "../modules/reseller/branding.controller";

/**
 * Un paramètre d'adresse répété (`?q=a&q=b`) est refusé par un 400.
 *
 * Il arrivait en tableau jusqu'à un `.trim()` ou une requête SQL, et la
 * réponse était une erreur 500 — sur la marque, route publique, comme sur
 * l'API applicative et l'espace client.
 */

const DOUBLE = ["a", "b"];

/** Un contrôleur dont chaque dépendance est un espion qui ne doit jamais servir. */
function monter<T>(Classe: new (...deps: never[]) => T, taille: number) {
  const espion = vi.fn(async () => {
    throw new Error("dépendance appelée");
  });
  const dependance = new Proxy({}, { get: () => espion });
  const deps = Array.from({ length: taille }, () => dependance) as never[];
  return { controleur: new Classe(...deps), espion };
}

describe("paramètres d'adresse répétés", () => {
  it("marque : ?host répété", async () => {
    const { controleur, espion } = monter(BrandingController, 2);
    await expect(controleur.resolve(DOUBLE)).rejects.toBeInstanceOf(BadRequestException);
    expect(espion).not.toHaveBeenCalled();
  });

  it("API applicative : critères de recherche et propriétaire répétés", async () => {
    const { controleur, espion } = monter(ApplicationController, 9);
    const requete = { application: { resellerId: null } } as never;
    await expect(controleur.findUser(requete, DOUBLE)).rejects.toBeInstanceOf(BadRequestException);
    await expect(controleur.findUser(requete, undefined, DOUBLE)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(controleur.findUser(requete, undefined, undefined, DOUBLE)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(controleur.servers(requete, DOUBLE)).rejects.toBeInstanceOf(BadRequestException);
    expect(espion).not.toHaveBeenCalled();
  });

  it("espace client : recherche et page répétées", async () => {
    const { controleur, espion } = monter(ServerFeaturesController, 15);
    const requete = { user: { id: "u-1" }, scopes: null } as never;
    for (const appel of [
      () => controleur.marketplaceCatalogue(requete, "srv-1", DOUBLE),
      () => controleur.engineState(requete, "srv-1", DOUBLE),
      () => controleur.listActivity(requete, "srv-1", DOUBLE),
      () => controleur.listActivity(requete, "srv-1", undefined, DOUBLE),
    ]) {
      await expect(appel()).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(espion).not.toHaveBeenCalled();
  });
});
