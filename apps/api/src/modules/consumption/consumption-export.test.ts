import { type ConsumptionDay, SERVER_CONSUMPTION_COLUMNS } from "@gamedashboard/contracts";
import { BadRequestException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { consumptionExportFile } from "./consumption-export";
import { consumptionExportRequest, consumptionPageRequest } from "./consumption-http";

const JOUR: ConsumptionDay = {
  day: "2026-09-01",
  serverId: "5b0d3f5e-0000-4000-8000-000000000001",
  serverName: '=HYPERLINK("http://exemple";"cliquez")',
  ownerId: "5b0d3f5e-0000-4000-8000-000000000002",
  ownerEmail: "client@exemple.test",
  ownerExternalId: "client-42",
  resellerId: null,
  memoryLimitMb: 2048,
  diskLimitMb: 10240,
  cpuLimitPct: 100,
  samples: 1440,
  onlineSamples: 720,
  cpuAvgPct: 12.5,
  cpuMaxPct: 90,
  memoryAvgBytes: 1_000_000,
  memoryMaxBytes: 2_000_000,
  diskMaxBytes: 5_000_000_000,
  networkRxBytes: 123,
  networkTxBytes: 456,
  playersMax: null,
  complete: true,
};

async function* une(): AsyncGenerator<ConsumptionDay> {
  yield JOUR;
}

async function contenu(chunks: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const chunk of chunks) out += chunk;
  return out;
}

const PERIODE = { from: "2026-09-01", to: "2026-09-30" };

describe("consumptionExportFile", () => {
  it("écrit un CSV lisible par Excel, formules désamorcées", async () => {
    // Le nom du serveur est écrit par le client : dans le tableur de
    // l'administrateur, il ne doit pas devenir un lien piégé.
    const file = consumptionExportFile("csv", SERVER_CONSUMPTION_COLUMNS, une(), PERIODE);
    const texte = await contenu(file.chunks);

    expect(file.filename).toBe("consommation-2026-09-01-2026-09-30.csv");
    expect(texte.startsWith('﻿"day","serverId","serverName"')).toBe(true);
    expect(texte).toContain(`"'=HYPERLINK(""http://exemple"";""cliquez"")"`);
    expect(texte).not.toContain("client@exemple.test");
    expect(texte.split("\r\n")).toHaveLength(3);
  });

  it("écrit une journée par ligne JSON, réduite aux colonnes demandées", async () => {
    const file = consumptionExportFile("jsonl", SERVER_CONSUMPTION_COLUMNS, une(), PERIODE);
    const [ligne] = (await contenu(file.chunks)).trim().split("\n");
    const objet = JSON.parse(ligne ?? "{}");

    expect(file.contentType).toContain("application/x-ndjson");
    // Aucune neutralisation en JSON : un script relit la valeur exacte.
    expect(objet.serverName).toBe(JOUR.serverName);
    expect(objet).not.toHaveProperty("ownerEmail");
    expect(objet.diskMaxBytes).toBe(5_000_000_000);
  });
});

describe("lecture des paramètres", () => {
  const NOW = new Date("2026-09-28T09:00:00.000Z");

  it("rend la période par défaut et le CSV", () => {
    expect(consumptionExportRequest({}, NOW)).toMatchObject({
      period: { from: "2026-09-01", to: "2026-09-28" },
      format: "csv",
    });
  });

  it("refuse en 400 une période trop longue ou mal écrite", () => {
    expect(() => consumptionExportRequest({ from: "2024-01-01", to: "2026-01-01" }, NOW)).toThrow(
      BadRequestException,
    );
    expect(() => consumptionPageRequest({ from: "hier" }, NOW)).toThrow(BadRequestException);
    expect(() => consumptionPageRequest({ serverId: "abc" }, NOW)).toThrow(BadRequestException);
  });
});
