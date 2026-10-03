import type {
  AdminIncident,
  AdminNode,
  AdminServer,
  AdminUser,
  UpdateStatus,
} from "@gamedashboard/contracts";
import { describe, expect, it } from "vitest";
import {
  apercu,
  estEnEchec,
  etatMachine,
  etatMiseAJour,
  filtrerComptes,
  filtrerServeurs,
  refusMotif,
} from "./administration";
import { raisonPresence } from "./presence";

const MAINTENANT = Date.parse("2026-10-02T12:00:00Z");
const ilYa = (secondes: number) => new Date(MAINTENANT - secondes * 1000).toISOString();

const machine = (name: string, lastHeartbeatAt: string | null, maintenance = false) =>
  ({ id: name, name, lastHeartbeatAt, maintenance }) as AdminNode;

const serveur = (name: string, state: string | null, runtimeState: string | null = null) =>
  ({
    id: name,
    name,
    shortId: `${name}-id`,
    owner: "Éloïse Martin",
    ownerEmail: "eloise@exemple.fr",
    node: "Paris-1",
    egg: "Minecraft Java",
    state,
    runtimeState,
  }) as AdminServer;

const actif = (partiel: Partial<Extract<UpdateStatus, { actif: true }>>): UpdateStatus => ({
  actif: true,
  version: "v1.2.0",
  enService: "v1.2.0",
  precedente: null,
  derniereVerification: null,
  derniereRelease: "v1.2.0",
  operation: null,
  dernierResultat: null,
  refusees: [],
  ...partiel,
});

describe("machines", () => {
  it("suit la règle du web, et une machine jamais vue est injoignable", () => {
    expect(etatMachine(machine("a", ilYa(5)), MAINTENANT)).toBe("online");
    expect(etatMachine(machine("b", ilYa(90)), MAINTENANT)).toBe("stale");
    expect(etatMachine(machine("c", ilYa(5), true), MAINTENANT)).toBe("maintenance");
    expect(etatMachine(machine("d", ilYa(600), true), MAINTENANT)).toBe("unreachable");
    expect(etatMachine(machine("e", null), MAINTENANT)).toBe("unreachable");
  });
});

describe("serveurs en échec", () => {
  it("retient l'installation ratée et les arrêts en boucle, rien d'autre", () => {
    expect(estEnEchec(serveur("a", "install_failed"))).toBe(true);
    expect(estEnEchec(serveur("b", null, "crash_loop"))).toBe(true);
    expect(estEnEchec(serveur("c", "suspended"))).toBe(false);
    expect(estEnEchec(serveur("d", null, "offline"))).toBe(false);
  });
});

describe("mise à jour", () => {
  it("lit l'état comme la carte du web", () => {
    expect(etatMiseAJour({ actif: false })).toBe("inactive");
    expect(etatMiseAJour(actif({}))).toBe("a-jour");
    expect(etatMiseAJour(actif({ derniereRelease: "v1.3.0" }))).toBe("disponible");
    expect(
      etatMiseAJour(
        actif({
          derniereRelease: "v1.3.0",
          operation: { etape: "repetition", version: "v1.3.0", depuis: ilYa(10) },
        }),
      ),
    ).toBe("en-cours");
  });

  it("ne dit pas disponible une version refusée, et dit l'échec de la dernière", () => {
    expect(etatMiseAJour(actif({ derniereRelease: "v1.3.0", refusees: ["v1.3.0"] }))).toBe(
      "a-jour",
    );
    expect(
      etatMiseAJour(
        actif({
          derniereRelease: "v1.3.0",
          dernierResultat: { etat: "erreur", version: "v1.3.0", date: ilYa(60) },
        }),
      ),
    ).toBe("echec");
  });
});

describe("aperçu", () => {
  it("ne garde que ce qui demande quelqu'un", () => {
    const vue = apercu(
      {
        noeuds: [machine("ok", ilYa(5)), machine("tombee", ilYa(600)), machine("neuve", null)],
        serveurs: [serveur("sain", null, "running"), serveur("rate", "install_failed")],
        incidents: [
          { id: "1", resolvedAt: null } as AdminIncident,
          { id: "2", resolvedAt: ilYa(60) } as AdminIncident,
        ],
        miseAJour: actif({ derniereRelease: "v1.3.0" }),
      },
      MAINTENANT,
    );
    expect(vue.injoignables.map((n) => n.name)).toEqual(["tombee", "neuve"]);
    expect(vue.enEchec.map((s) => s.name)).toEqual(["rate"]);
    expect(vue.incidents.map((i) => i.id)).toEqual(["1"]);
    expect(vue.miseAJour).toBe("disponible");
  });
});

describe("recherche", () => {
  it("cherche sans casse ni accents, chaque mot dans un champ ou un autre", () => {
    const parc = [serveur("survie", null), { ...serveur("creatif", null), owner: "Paul" }];
    expect(filtrerServeurs(parc, "ELOISE survie").map((s) => s.name)).toEqual(["survie"]);
    expect(filtrerServeurs(parc, "paris").map((s) => s.name)).toEqual(["survie", "creatif"]);
    expect(filtrerServeurs(parc, "creatif-id")).toHaveLength(1);
    expect(filtrerServeurs(parc, "  ")).toHaveLength(2);
    const comptes = [{ name: "Zoé Durand", email: "zoe@exemple.fr" } as AdminUser];
    expect(filtrerComptes(comptes, "zoe")).toHaveLength(1);
    expect(filtrerComptes(comptes, "martin")).toHaveLength(0);
  });
});

describe("motif de suspension", () => {
  it("est exigé et borné comme dans l'API", () => {
    expect(refusMotif("  ")).toBe("vide");
    expect(refusMotif("x".repeat(501))).toBe("long");
    expect(refusMotif(" impayé chez le facturier ")).toBeNull();
  });
});

describe("invite biométrique de l'administration", () => {
  it("nomme chaque geste", () => {
    expect(raisonPresence("POST", "/api/v1/admin/servers/abc/suspend")).toBe("suspensionServeur");
    expect(raisonPresence("POST", "/api/v1/admin/users/abc/suspend")).toBe("suspensionCompte");
    expect(raisonPresence("POST", "/api/v1/admin/users/abc/revoke-sessions")).toBe(
      "deconnecterPartout",
    );
    expect(raisonPresence("POST", "/api/v1/admin/incidents")).toBe("publierIncident");
    expect(raisonPresence("POST", "/api/v1/admin/incidents/abc/updates")).toBe("publierIncident");
    expect(raisonPresence("POST", "/api/v1/admin/updates/check")).toBe("miseAJourPanel");
    expect(raisonPresence("GET", "/api/v1/admin/incidents")).toBe("geste");
  });
});
