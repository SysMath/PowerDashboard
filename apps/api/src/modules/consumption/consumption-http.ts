import { Readable } from "node:stream";
import {
  type ConsumptionExportFormat,
  ConsumptionExportQuery,
  ConsumptionPageQuery,
  type ConsumptionPeriod,
  consumptionPeriod,
} from "@gamedashboard/contracts";
import { BadRequestException } from "@nestjs/common";
import type { z } from "zod";
import type { RecordInput } from "../activity/activity.service";
import type { ConsumptionExportFile } from "./consumption-export";

/**
 * Lecture des paramètres d'une demande de consommation, commune à toutes les
 * routes : l'administration, l'espace revendeur, la page d'un serveur et l'API
 * applicative refusent la même période avec le même message.
 */
function periodOf(query: { from?: string; to?: string }, now: Date): ConsumptionPeriod {
  const period = consumptionPeriod(query, now);
  if ("error" in period) throw new BadRequestException(period.error);
  return period.period;
}

function refused(error: z.ZodError): BadRequestException {
  return new BadRequestException(error.issues[0]?.message ?? "Paramètres invalides.");
}

export function consumptionExportRequest(
  query: Record<string, unknown>,
  now: Date = new Date(),
): {
  period: ConsumptionPeriod;
  format: ConsumptionExportFormat;
  serverId?: string;
  ownerId?: string;
} {
  const parsed = ConsumptionExportQuery.safeParse(query);
  if (!parsed.success) throw refused(parsed.error);
  const { serverId, ownerId, format } = parsed.data;
  return { period: periodOf(parsed.data, now), format, serverId, ownerId };
}

export function consumptionPageRequest(
  query: Record<string, unknown>,
  now: Date = new Date(),
): { period: ConsumptionPeriod; page: number; serverId?: string; ownerId?: string } {
  const parsed = ConsumptionPageQuery.safeParse(query);
  if (!parsed.success) throw refused(parsed.error);
  const { serverId, ownerId, page } = parsed.data;
  return { period: periodOf(parsed.data, now), page, serverId, ownerId };
}

/** Premier en-tête, quand Fastify en rend plusieurs. */
function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/**
 * La trace d'un export de consommation (ASVS 8.3.5).
 *
 * Le fichier nomme des clients par leur adresse et leur identifiant chez le
 * facturier : qui l'a emporté, depuis quel poste, pour quelle période et
 * avec quels filtres doit rester lisible au journal. Seuls les filtres posés
 * y figurent, comme pour l'export du journal.
 */
export function consumptionExportTrace(
  event: "admin.consumption_exported" | "reseller.consumption_exported",
  request: {
    user: { id: string; email: string };
    ip?: string;
    headers?: Record<string, string | string[] | undefined>;
  },
  demand: {
    period: ConsumptionPeriod;
    format: ConsumptionExportFormat;
    serverId?: string;
    ownerId?: string;
  },
): RecordInput {
  const filters = Object.fromEntries(
    Object.entries({ serverId: demand.serverId, ownerId: demand.ownerId }).filter(
      ([, value]) => value !== undefined,
    ),
  );
  return {
    event,
    serverId: null,
    actorId: request.user.id,
    actorType: "user",
    actorLabel: request.user.email,
    ip: request.ip ?? null,
    userAgent: headerValue(request.headers?.["user-agent"]),
    properties: { format: demand.format, from: demand.period.from, to: demand.period.to, filters },
  };
}

/** Ce dont un téléchargement a besoin de la réponse Fastify. */
export interface DownloadReply {
  header(name: string, value: string): DownloadReply;
  send(body: unknown): void;
}

/**
 * Envoie le fichier en flux.
 *
 * `no-store` : un export dit l'état d'une consommation à un instant, la
 * journée en cours comprise ; aucun intermédiaire n'a à le resservir.
 */
export function sendConsumptionFile(reply: DownloadReply, file: ConsumptionExportFile): void {
  reply
    .header("content-type", file.contentType)
    .header("content-disposition", `attachment; filename="${file.filename}"`)
    .header("cache-control", "no-store")
    .send(Readable.from(file.chunks));
}
