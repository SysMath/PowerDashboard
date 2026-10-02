import { describe, expect, it } from "vitest";
import {
  channelsFor,
  NOTIFICATION_EVENTS,
  notificationEvent,
  PUSH_OFF,
  storedChannels,
} from "./notifications-catalogue";

describe("choix des moyens d'acheminement", () => {
  it("sert la cloche même quand tout est coupé", () => {
    // Une notification qu'on n'a nulle part n'existe pas : qui coupe tout doit
    // encore pouvoir retrouver ce qui s'est passé en ouvrant le panel.
    expect(channelsFor("server.installed", [PUSH_OFF])).toEqual(["inapp"]);
  });

  it("applique le défaut quand l'utilisateur n'a rien réglé", () => {
    // `null` veut dire « aucune ligne enregistrée », ce qui n'est pas la même
    // chose qu'une liste vide : l'un est un silence, l'autre un refus.
    expect(channelsFor("backup.failed", null)).toEqual(["inapp", "email", "push"]);
    expect(channelsFor("backup.failed", [PUSH_OFF])).toEqual(["inapp"]);
  });

  it("passe outre le réglage sur ce qui se décide contre le client", () => {
    /*
     * Suspension pour impayé, serveur arrêté faute de quota : couper l'annonce
     * ferait découvrir la coupure par le silence de ses joueurs.
     */
    expect(channelsFor("billing.suspended", [])).toContain("email");
    expect(channelsFor("server.quota_stopped", [])).toContain("email");
  });

  it("s'en tient à la cloche pour un type inconnu", () => {
    // Un émetteur ajouté sans entrée au catalogue ne doit pas se mettre à
    // écrire des courriels que personne n'a acceptés.
    expect(channelsFor("quelque.chose.de.neuf", null)).toEqual(["inapp"]);
  });

  it("ignore un moyen qui n'existe pas", () => {
    // Une préférence enregistrée avant qu'un canal soit retiré — « discord »,
    // par exemple — ne doit pas ressortir comme une destination valide.
    expect(channelsFor("backup.failed", ["email", "discord", PUSH_OFF])).toEqual([
      "inapp",
      "email",
    ]);
  });
});

describe("téléphone", () => {
  it("suit le défaut sur un réglage enregistré avant son arrivée", () => {
    // Le choix d'alors ne portait que sur le courriel : il ne coupe pas le
    // téléphone, qui n'existait pas.
    expect(channelsFor("backup.failed", ["inapp"])).toEqual(["inapp", "push"]);
    expect(channelsFor("server.installed", ["inapp", "email"])).toEqual(["inapp", "email"]);
  });

  it("obéit à un choix explicite, dans un sens comme dans l'autre", () => {
    expect(channelsFor("server.installed", ["inapp", "push"])).toEqual(["inapp", "push"]);
    expect(channelsFor("backup.failed", ["inapp", "email", PUSH_OFF])).toEqual(["inapp", "email"]);
  });

  it("range toujours le téléphone, coupé ou non", () => {
    expect(storedChannels(["inapp", "email"])).toEqual(["inapp", "email", PUSH_OFF]);
    expect(storedChannels(["push", "discord"])).toEqual(["push"]);
  });
});

describe("catalogue", () => {
  it("ne contient aucun doublon de type", () => {
    const types = NOTIFICATION_EVENTS.map((event) => event.type);
    expect(new Set(types).size).toBe(types.length);
  });

  it("propose toujours la cloche dans ses défauts", () => {
    // Un événement dont le défaut n'inclut pas la cloche serait invisible pour
    // qui n'a pas d'adresse vérifiée.
    for (const event of NOTIFICATION_EVENTS) {
      expect(event.defaults, event.type).toContain("inapp");
    }
  });

  it("retrouve un événement par son type", () => {
    expect(notificationEvent("backup.failed")?.group).toBe("backup");
    expect(notificationEvent("inexistant")).toBe(null);
  });
});
