import { describe, expect, it } from "vitest";
import {
  CONSUMPTION_COLUMNS,
  CONSUMPTION_MAX_SPAN_DAYS,
  ConsumptionDayString,
  ConsumptionExportQuery,
  ConsumptionPageQuery,
  consumptionPeriod,
  SERVER_CONSUMPTION_COLUMNS,
  shiftDay,
} from "./consumption";

const NOW = new Date("2026-09-28T09:00:00.000Z");

describe("consumptionPeriod", () => {
  it("prend par défaut le mois en cours jusqu'à aujourd'hui", () => {
    expect(consumptionPeriod({}, NOW)).toEqual({
      period: { from: "2026-09-01", to: "2026-09-28" },
    });
  });

  it("commence au 1er du mois de la fin quand seule la fin est donnée", () => {
    expect(consumptionPeriod({ to: "2026-08-31" }, NOW)).toEqual({
      period: { from: "2026-08-01", to: "2026-08-31" },
    });
  });

  it("refuse une période qui finit avant de commencer", () => {
    expect(consumptionPeriod({ from: "2026-09-10", to: "2026-09-01" }, NOW)).toHaveProperty(
      "error",
    );
  });

  it("accepte une année bissextile entière, refuse un jour de plus", () => {
    // Refusée plutôt que raccourcie : un script qui demande deux ans doit
    // l'apprendre, pas recevoir un an en croyant en lire deux.
    const from = "2028-01-01";
    expect(consumptionPeriod({ from, to: "2028-12-31" }, NOW)).toHaveProperty("period");
    expect(
      consumptionPeriod({ from, to: shiftDay(from, CONSUMPTION_MAX_SPAN_DAYS) }, NOW),
    ).toHaveProperty("error");
  });
});

describe("ConsumptionDayString", () => {
  it("refuse une date qui n'existe pas au lieu de la reporter", () => {
    expect(ConsumptionDayString.safeParse("2026-02-30").success).toBe(false);
    expect(ConsumptionDayString.safeParse("2026-02-28").success).toBe(true);
    expect(ConsumptionDayString.safeParse("28/02/2026").success).toBe(false);
  });
});

describe("paramètres de lecture", () => {
  it("lit un paramètre vide comme l'absence de filtre", () => {
    const parsed = ConsumptionExportQuery.parse({ from: "", serverId: "", format: "" });
    expect(parsed).toEqual({ from: undefined, serverId: undefined, format: "csv" });
  });

  it("refuse un format inconnu et une page nulle", () => {
    expect(ConsumptionExportQuery.safeParse({ format: "xlsx" }).success).toBe(false);
    expect(ConsumptionPageQuery.safeParse({ page: "0" }).success).toBe(false);
    expect(ConsumptionPageQuery.parse({}).page).toBe(1);
  });
});

describe("colonnes d'un export", () => {
  it("retire de la page d'un serveur toute colonne qui nomme un compte", () => {
    // Un sous-utilisateur, ou le titulaire d'après un transfert, n'a pas à
    // lire l'adresse de celui qui possédait le serveur avant lui.
    expect(SERVER_CONSUMPTION_COLUMNS).not.toContain("ownerEmail");
    expect(SERVER_CONSUMPTION_COLUMNS).not.toContain("ownerExternalId");
    expect(SERVER_CONSUMPTION_COLUMNS).not.toContain("ownerId");
    expect(SERVER_CONSUMPTION_COLUMNS).not.toContain("resellerId");
    expect(CONSUMPTION_COLUMNS.length - SERVER_CONSUMPTION_COLUMNS.length).toBe(4);
  });
});
