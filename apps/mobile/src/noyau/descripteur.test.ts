import { APP_PROTOCOL_VERSION } from "@gamedashboard/contracts";
import { describe, expect, it, vi } from "vitest";
import { CHEMIN_DESCRIPTEUR, juger, lireInstance } from "./descripteur";
import { reponse } from "./essais/outils-node";

const descripteur = {
  produit: "gamedashboard",
  api: APP_PROTOCOL_VERSION,
  version: "1.4.0",
  version_app_minimale: "1.0.0",
  instance: "6f1d1c8e-8a43-4d0f-9d0e-2f1f3a5b7c9d",
  nom: "Hébergeur Exemple",
  origine: "https://panel.example.com",
  notifications: "aucune",
};

describe("lireInstance", () => {
  it("reconnaît un panel par son descripteur", async () => {
    const fetch = vi.fn(async () => reponse(descripteur));
    const verdict = await lireInstance("https://panel.example.com", {
      fetch,
      versionApplication: "1.0.0",
    });
    expect(verdict).toEqual({
      etat: "ok",
      descripteur: {
        instance: descripteur.instance,
        nom: "Hébergeur Exemple",
        origine: "https://panel.example.com",
        version: "1.4.0",
        notifications: "aucune",
      },
    });
    expect(fetch).toHaveBeenCalledWith(
      `https://panel.example.com${CHEMIN_DESCRIPTEUR}`,
      expect.anything(),
    );
  });

  it("dit qu'une adresse n'est pas un panel, sans aller plus loin", async () => {
    // Absent, autre chose, ou servi par un autre domaine après redirection.
    const versions = { versionApplication: "1.0.0" };
    const absent = vi.fn(async () => reponse({ message: "Not Found" }, 404));
    const autre = vi.fn(async () => reponse({ produit: "autre-chose" }));
    const redirige = vi.fn(async () =>
      reponse(descripteur, 200, `https://ailleurs.example${CHEMIN_DESCRIPTEUR}`),
    );
    for (const fetch of [absent, autre, redirige]) {
      expect(await lireInstance("https://panel.example.com", { fetch, ...versions })).toEqual({
        etat: "pas-un-panel",
      });
    }
  });

  it("distingue un panel muet d'une adresse injoignable", async () => {
    const muet = vi.fn(async () => reponse({ message: "Panel momentanément indisponible." }, 503));
    const injoignable = vi.fn(async () => {
      throw new TypeError("Network request failed");
    });
    const versions = { versionApplication: "1.0.0" };
    expect(await lireInstance("https://p.example", { fetch: muet, ...versions })).toEqual({
      etat: "indisponible",
    });
    expect(await lireInstance("https://p.example", { fetch: injoignable, ...versions })).toEqual({
      etat: "injoignable",
    });
  });
});

describe("juger", () => {
  it("refuse une origine en clair et un descripteur sans identifiant", () => {
    expect(juger({ ...descripteur, origine: "http://panel.example.com" }, "1.0.0").etat).toBe(
      "pas-un-panel",
    );
    expect(juger({ ...descripteur, instance: "" }, "1.0.0").etat).toBe("pas-un-panel");
  });

  it("compare protocole et versions dans les deux sens", () => {
    expect(juger({ ...descripteur, api: APP_PROTOCOL_VERSION - 1 }, "1.0.0").etat).toBe(
      "panel-trop-ancien",
    );
    expect(juger({ ...descripteur, api: APP_PROTOCOL_VERSION + 1 }, "1.0.0").etat).toBe(
      "application-trop-ancienne",
    );
    expect(juger({ ...descripteur, version_app_minimale: "1.2.0" }, "1.1.9")).toEqual({
      etat: "application-trop-ancienne",
      minimale: "1.2.0",
    });
  });

  it("ignore les champs inconnus, place réservée à une future licence", () => {
    const verdict = juger(
      { ...descripteur, licence: { preuve: "…" }, notifications: "futur" },
      "1.0.0",
    );
    expect(verdict.etat).toBe("ok");
    expect(verdict.etat === "ok" && verdict.descripteur.notifications).toBe("aucune");
  });
});
