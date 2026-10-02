import { APP_PRESENCE_ROUTES, type ClientBackupView } from "@gamedashboard/contracts";
import { describe, expect, it } from "vitest";
import { raisonPresence } from "./presence";
import {
  actionsSauvegarde,
  enCours,
  etatSauvegarde,
  nomParDefaut,
  quotaAtteint,
  restaurable,
} from "./sauvegardes";

const sauvegarde = (isSuccessful: boolean | null): ClientBackupView => ({
  id: "b1",
  name: "avant",
  bytes: 10,
  checksum: null,
  isSuccessful,
  isLocked: false,
  createdAt: "2026-10-02T12:00:00Z",
  completedAt: null,
});

describe("sauvegardes", () => {
  it("ne restaure qu'une archive terminée et réussie", () => {
    expect(etatSauvegarde(sauvegarde(null))).toBe("en-cours");
    expect(restaurable(sauvegarde(null))).toBe(false);
    expect(restaurable(sauvegarde(false))).toBe(false);
    expect(restaurable(sauvegarde(true))).toBe(true);
  });

  it("suit le quota comme le web et repère une sauvegarde en cours", () => {
    expect(quotaAtteint({ items: [], used: 2, limit: 2 })).toBe(true);
    expect(quotaAtteint({ items: [], used: 0, limit: 0 })).toBe(true);
    expect(quotaAtteint({ items: [], used: 1, limit: 3 })).toBe(false);
    expect(enCours({ items: [sauvegarde(true), sauvegarde(null)], used: 2, limit: 3 })).toBe(true);
    expect(enCours(null)).toBe(false);
  });

  it("propose un nom daté", () => {
    expect(nomParDefaut(new Date(2026, 9, 2, 14, 5))).toBe("mobile-2026-10-02-1405");
  });
});

describe("menu d'une sauvegarde", () => {
  it("n'offre rien tant que le daemon n'a pas rendu compte", () => {
    expect(actionsSauvegarde(sauvegarde(null))).toEqual([]);
  });

  it("ne restaure qu'une archive réussie, ne supprime qu'une archive déverrouillée", () => {
    expect(actionsSauvegarde(sauvegarde(true))).toEqual(["restaurer", "verrouiller", "supprimer"]);
    expect(actionsSauvegarde(sauvegarde(false))).toEqual(["verrouiller", "supprimer"]);
    expect(actionsSauvegarde({ ...sauvegarde(true), isLocked: true })).toEqual([
      "restaurer",
      "deverrouiller",
    ]);
  });
});

describe("invite de confirmation de présence", () => {
  it("nomme chaque geste protégé que l'application propose", () => {
    const concret = (path: string) => path.replace(/:\w+/g, "x1");
    const raisons = APP_PRESENCE_ROUTES.map((r) => raisonPresence(r.method, concret(r.path)));
    expect(raisons).toEqual([
      "restaurerSauvegarde",
      "supprimerSauvegarde",
      "supprimerFichiers",
      // Réinstaller et supprimer une base restent dans le navigateur.
      "geste",
      "restaurerInstantane",
      "geste",
    ]);
  });
});
