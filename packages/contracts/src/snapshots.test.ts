import { describe, expect, it } from "vitest";
import { ServerLimitsPatch } from "./server";
import {
  AgentSnapshotReport,
  agentSettingsFromPolicy,
  DEFAULT_SNAPSHOT_POLICY,
  resolveSnapshotPolicy,
  SNAPSHOT_BOUNDS,
  SnapshotName,
  SnapshotPolicy,
} from "./snapshots";

const UUID = "0b9f4c1e-2f53-4c7a-9a55-3c1d2e4f5a6b";

describe("SnapshotPolicy", () => {
  it("accepte les défauts de l'ADR 0009", () => {
    expect(SnapshotPolicy.safeParse(DEFAULT_SNAPSHOT_POLICY).success).toBe(true);
  });

  it("refuse les bornes que l'agent refuserait aussi", () => {
    const hors = [
      { freeSpaceThresholdPct: SNAPSHOT_BOUNDS.freeSpaceMin - 1 },
      { maxAgeDays: SNAPSHOT_BOUNDS.maxAgeDaysMax + 1 },
      { levels: [{ intervalMinutes: 4, retentionHours: 1, enabled: true }] },
      {
        levels: Array.from({ length: SNAPSHOT_BOUNDS.levelsMax + 1 }, () => ({
          intervalMinutes: 60,
          retentionHours: 24,
          enabled: true,
        })),
      },
    ];
    for (const patch of hors) {
      expect(SnapshotPolicy.safeParse({ ...DEFAULT_SNAPSHOT_POLICY, ...patch }).success).toBe(
        false,
      );
    }
  });

  it("exige une rétention d'au moins un intervalle, et pas au-delà de la durée maximale", () => {
    const courte = SnapshotPolicy.safeParse({
      ...DEFAULT_SNAPSHOT_POLICY,
      levels: [{ intervalMinutes: 24 * 60, retentionHours: 12, enabled: true }],
    });
    expect(courte.success).toBe(false);
    const longue = SnapshotPolicy.safeParse({
      ...DEFAULT_SNAPSHOT_POLICY,
      maxAgeDays: 7,
      levels: [{ intervalMinutes: 60, retentionHours: 8 * 24, enabled: true }],
    });
    expect(longue.success).toBe(false);
  });

  it("ramène aux défauts des réglages en base devenus invalides", () => {
    expect(resolveSnapshotPolicy({ enabled: "oui" })).toEqual(DEFAULT_SNAPSHOT_POLICY);
    expect(resolveSnapshotPolicy(null)).toEqual(DEFAULT_SNAPSHOT_POLICY);
  });
});

describe("agentSettingsFromPolicy", () => {
  it("traduit en secondes et ne garde que les niveaux allumés", () => {
    const policy: SnapshotPolicy = {
      ...DEFAULT_SNAPSHOT_POLICY,
      levels: [
        { intervalMinutes: 60, retentionHours: 24, enabled: true },
        { intervalMinutes: 1440, retentionHours: 168, enabled: false },
      ],
    };
    expect(agentSettingsFromPolicy(policy, true)).toEqual({
      actif: true,
      niveaux: [{ intervalle_s: 3600, retention_s: 86_400 }],
      duree_max_s: 30 * 86_400,
      seuil_libre_pct: 15,
      regroupement_s: 60,
    });
  });

  it("éteint l'agent quand la fonction n'est pas offerte, même réglée allumée", () => {
    expect(agentSettingsFromPolicy(DEFAULT_SNAPSHOT_POLICY, false).actif).toBe(false);
    expect(
      agentSettingsFromPolicy({ ...DEFAULT_SNAPSHOT_POLICY, enabled: false }, true).actif,
    ).toBe(false);
  });
});

describe("AgentSnapshotReport", () => {
  it("accepte les listes nulles que Go écrit pour une liste vide", () => {
    const parsed = AgentSnapshotReport.parse({
      version: "0.1.0",
      systeme: "btrfs",
      espace: { total: 100, libre: 50 },
      suspendu: false,
      instantanes: [
        { nom: "gd-20260930T120000.000Z", pris_le: "2026-09-30T12:00:00Z", serveurs: null },
      ],
      ordres: null,
    });
    expect(parsed.ordres).toEqual([]);
    expect(parsed.instantanes[0]?.serveurs).toEqual([]);
  });

  it("refuse un nom que l'agent n'a pas pu tirer", () => {
    for (const nom of ["gd-x", "../gd-20260930T120000.000Z", "gd-20260930T120000.000Z@x"]) {
      expect(SnapshotName.safeParse(nom).success).toBe(false);
    }
    const rapport = AgentSnapshotReport.safeParse({
      version: "0.1.0",
      systeme: "zfs",
      suspendu: false,
      instantanes: [],
      ordres: [{ id: UUID, etat: "reussi", instantane: "pool/data@gd" }],
    });
    expect(rapport.success).toBe(false);
  });
});

describe("limite d'instantanés d'un serveur", () => {
  it("se pose, se rend au node par null, et reste bornée", () => {
    expect(ServerLimitsPatch.safeParse({ snapshots: 5 }).success).toBe(true);
    expect(ServerLimitsPatch.parse({ snapshots: null })).toEqual({ snapshots: null });
    expect(
      ServerLimitsPatch.safeParse({ snapshots: SNAPSHOT_BOUNDS.pinLimitMax + 1 }).success,
    ).toBe(false);
    expect(ServerLimitsPatch.safeParse({ snapshots: -1 }).success).toBe(false);
  });
});
