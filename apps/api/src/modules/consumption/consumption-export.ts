import {
  type ConsumptionColumn,
  type ConsumptionDay,
  type ConsumptionExportFormat,
  type ConsumptionPeriod,
  pickConsumptionColumns,
} from "@gamedashboard/contracts";
import { csvLine } from "../activity/audit-export";

export interface ConsumptionExportFile {
  filename: string;
  contentType: string;
  /** Le contenu, morceau par morceau : jamais le fichier entier en mémoire. */
  chunks: AsyncIterable<string>;
}

/**
 * Le fichier d'un export de consommation.
 *
 * Mêmes règles que l'export du journal, dont il reprend la mise en forme des
 * cellules : tout entre guillemets, formules désamorcées (un nom de serveur
 * est écrit par le client), marque d'ordre des octets en tête du CSV pour
 * qu'Excel lise les accents, une ligne JSON par journée.
 *
 * Le nom porte la période et non l'instant : c'est ce qu'on cherche dans un
 * dossier de téléchargements au moment de facturer.
 */
export function consumptionExportFile(
  format: ConsumptionExportFormat,
  columns: readonly ConsumptionColumn[],
  rows: AsyncIterable<ConsumptionDay>,
  period: ConsumptionPeriod,
): ConsumptionExportFile {
  const base = `consommation-${period.from}-${period.to}`;

  if (format === "jsonl") {
    return {
      filename: `${base}.jsonl`,
      contentType: "application/x-ndjson; charset=utf-8",
      chunks: (async function* () {
        for await (const row of rows) {
          yield `${JSON.stringify(pickConsumptionColumns(row, columns))}\n`;
        }
      })(),
    };
  }

  return {
    filename: `${base}.csv`,
    contentType: "text/csv; charset=utf-8",
    chunks: (async function* () {
      yield `﻿${csvLine(columns)}`;
      for await (const row of rows) yield csvLine(columns.map((column) => row[column]));
    })(),
  };
}
