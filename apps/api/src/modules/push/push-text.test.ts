import { describe, expect, it } from "vitest";
import { pushText } from "./push-text";

describe("texte d'une notification poussée", () => {
  it("nomme le serveur et l'événement, dans la langue du compte", () => {
    expect(pushText({ type: "server.unreachable", serveur: "Survie", langue: "fr" })).toEqual({
      title: "Survie",
      body: "Serveur injoignable",
    });
    expect(pushText({ type: "backup.failed", serveur: "Survie", langue: "en" })).toEqual({
      title: "Survie",
      body: "Backup failed",
    });
  });

  it("sans serveur, l'événement seul et une invitation à ouvrir l'application", () => {
    expect(pushText({ type: "billing.overdue", serveur: null, langue: "fr" })).toEqual({
      title: "Paiement en retard",
      body: "Ouvrez l'application pour la lire.",
    });
  });

  it("n'invente aucun texte pour un type inconnu", () => {
    expect(pushText({ type: "inconnu.type", serveur: null, langue: "fr" }).title).toBe(
      "Nouvelle notification",
    );
  });
});
