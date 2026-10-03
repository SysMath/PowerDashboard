import type { ResellerServer } from "@gamedashboard/contracts";
import { describe, expect, it } from "vitest";
import { raisonPresence } from "./presence";
import {
  enveloppe,
  periodeMois,
  resumerConsommation,
  serveursDuClient,
  suspendable,
  trierClients,
} from "./revendeur";

const serveur = (nom: string, ownerEmail: string, state: string | null = null) =>
  ({ id: nom, name: nom, ownerEmail, state }) as ResellerServer;

describe("enveloppe", () => {
  it("dit ce qu'il reste, sans limite comme sans reste négatif", () => {
    const lignes = enveloppe({
      quota: { memoryMb: 8192, diskMb: null, serversMax: 3 },
      usage: { memoryMb: 6144, diskMb: 50_000, servers: 4, basis: "measured", unmeasured: 0 },
    });
    expect(lignes).toEqual([
      { dimension: "memoryMb", utilise: 6144, limite: 8192, reste: 2048, depasse: false },
      { dimension: "diskMb", utilise: 50_000, limite: null, reste: null, depasse: false },
      { dimension: "servers", utilise: 4, limite: 3, reste: 0, depasse: true },
    ]);
  });
});

describe("parc", () => {
  it("ne propose la suspension que là où l'API l'accepte", () => {
    expect(suspendable(serveur("a", "x", null))).toBe(true);
    expect(suspendable(serveur("a", "x", "suspended"))).toBe(true);
    expect(suspendable(serveur("a", "x", "installing"))).toBe(false);
    expect(suspendable(serveur("a", "x", "transferring"))).toBe(false);
  });

  it("rattache les serveurs au client par son adresse, sans la casse", () => {
    const parc = [
      serveur("Zeta", "Ana@Exemple.fr"),
      serveur("Alpha", "ana@exemple.fr"),
      serveur("B", "bob@exemple.fr"),
    ];
    expect(serveursDuClient(parc, { email: "ana@exemple.fr" }).map((s) => s.name)).toEqual([
      "Alpha",
      "Zeta",
    ]);
  });

  it("montre d'abord les clients qui ont le plus de serveurs", () => {
    const clients = [
      { id: "1", name: "Bob", email: "b", servers: 1, memoryMb: 0 },
      { id: "2", name: "Ana", email: "a", servers: 1, memoryMb: 0 },
      { id: "3", name: "Zoé", email: "z", servers: 4, memoryMb: 0 },
    ];
    expect(trierClients(clients).map((c) => c.name)).toEqual(["Zoé", "Ana", "Bob"]);
  });
});

describe("consommation", () => {
  it("rend le mois courant jusqu'à aujourd'hui, et le précédent en entier", () => {
    const maintenant = new Date("2026-03-15T22:00:00Z");
    expect(periodeMois(maintenant)).toEqual({ from: "2026-03-01", to: "2026-03-15" });
    expect(periodeMois(maintenant, 1)).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(periodeMois(new Date("2026-01-10T00:00:00Z"), 1)).toEqual({
      from: "2025-12-01",
      to: "2025-12-31",
    });
  });

  it("résume par serveur, en pondérant par les relevés", () => {
    const resume = resumerConsommation([
      {
        serverId: "s1",
        serverName: "Survie",
        samples: 100,
        onlineSamples: 100,
        cpuAvgPct: 50,
        memoryMaxBytes: 1000,
        networkRxBytes: 10,
        networkTxBytes: 5,
        playersMax: 3,
        complete: true,
      },
      {
        serverId: "s1",
        serverName: "Survie",
        samples: 300,
        onlineSamples: 0,
        cpuAvgPct: 10,
        memoryMaxBytes: 4000,
        networkRxBytes: 1,
        networkTxBytes: 1,
        playersMax: null,
        complete: false,
      },
      { serverId: "s0", serverName: "Atelier", samples: 0, onlineSamples: 0 },
      { day: "2026-03-01" },
    ]);
    expect(resume).toEqual([
      {
        serverId: "s0",
        nom: "Atelier",
        jours: 1,
        disponibilite: null,
        processeurMoyen: null,
        memoireMax: 0,
        reseau: 0,
        joueursMax: null,
        incomplet: false,
      },
      {
        serverId: "s1",
        nom: "Survie",
        jours: 2,
        disponibilite: 0.25,
        processeurMoyen: 20,
        memoireMax: 4000,
        reseau: 17,
        joueursMax: 3,
        incomplet: true,
      },
    ]);
  });
});

describe("invite biométrique", () => {
  it("nomme la suspension d'un serveur du parc", () => {
    expect(raisonPresence("POST", "/api/v1/reseller/servers/31201e0c/suspension")).toBe(
      "suspensionServeur",
    );
    expect(raisonPresence("POST", "/api/v1/client/servers/31201e0c/power")).toBe("geste");
  });
});
