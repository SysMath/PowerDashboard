import "reflect-metadata";
import {
  CONSUMPTION_COLUMNS,
  type ConsumptionColumn,
  SERVER_CONSUMPTION_COLUMNS,
} from "@gamedashboard/contracts";
import { type ExecutionContext, ForbiddenException, NotFoundException } from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { describe, expect, it, vi } from "vitest";
import type { ActivityService, RecordInput } from "../activity/activity.service";
import { AdminGuard } from "../admin/admin.guard";
import { AdminConsumptionController } from "../admin/admin-consumption.controller";
import type { AdminRequest } from "../admin/admin-input";
import { AdminWriteGuard } from "../admin/admin-write.guard";
import { StaffTwoFactorGuard } from "../admin/staff-2fa.guard";
import type { AuthenticatedRequest } from "../auth/session.guard";
import { SessionGuard } from "../auth/session.guard";
import type { ServerAccessService } from "../client/server-access.service";
import { ServerConsumptionController } from "../client/server-consumption.controller";
import { ResellerGuard } from "../reseller/reseller.guard";
import { ResellerConsumptionController } from "../reseller/reseller-consumption.controller";
import type { ConsumptionService } from "./consumption.service";
import type { DownloadReply } from "./consumption-http";

/**
 * Les portes des téléchargements de consommation.
 *
 * Les gardes sont lus sur les contrôleurs eux-mêmes, et les gestes — trace,
 * contrôle d'accès, colonnes — éprouvés avec des doublures : un oubli ne se
 * verrait nulle part ailleurs, la route marcherait simplement pour une
 * personne de trop, ou sans laisser de trace.
 */

const ADMIN = { user: { id: "a", email: "admin@exemple.fr", role: "admin" }, scopes: null };
const NOW_QUERY = { from: "2026-09-01", to: "2026-09-10", format: "jsonl", ownerId: undefined };

function context(request: unknown): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}

function guards(controller: object): unknown[] {
  return Reflect.getMetadata(GUARDS_METADATA, controller) as unknown[];
}

/** Ce que le contrôleur a fait, dans l'ordre : trace, fichier, envoi. */
function doublures(options: { traceFails?: boolean } = {}) {
  const ordre: string[] = [];
  const traces: RecordInput[] = [];
  const activity = {
    recordRequired: vi.fn(async (input: RecordInput) => {
      ordre.push("trace");
      if (options.traceFails) throw new Error("base indisponible");
      traces.push(input);
    }),
  } as unknown as ActivityService;
  const colonnes: (readonly ConsumptionColumn[])[] = [];
  const scopes: unknown[] = [];
  const consumption = {
    exportFile: vi.fn(
      (filters: { scope?: unknown }, _format: string, columns: readonly ConsumptionColumn[]) => {
        ordre.push("fichier");
        colonnes.push(columns);
        scopes.push(filters.scope);
        return { filename: "f.csv", contentType: "text/csv", chunks: (async function* () {})() };
      },
    ),
  } as unknown as ConsumptionService;
  const reply: DownloadReply = {
    header: () => reply,
    send: () => {
      ordre.push("envoi");
    },
  };
  return { activity, consumption, reply, ordre, traces, colonnes, scopes };
}

describe("export de la plateforme", () => {
  it("exige l'administration, la seconde preuve et le rôle administrateur", () => {
    const posés = guards(AdminConsumptionController);
    expect(posés).toEqual([SessionGuard, AdminGuard, StaffTwoFactorGuard, AdminWriteGuard]);
    // Le support lit l'administration, mais n'emporte pas la liste des clients.
    const support = { user: { id: "s", role: "support" }, scopes: null };
    expect(() => new AdminWriteGuard().canActivate(context(support))).toThrow(ForbiddenException);
  });

  it("consigne l'export avant d'envoyer la première ligne", async () => {
    const d = doublures();
    const request = {
      ...ADMIN,
      ip: "192.0.2.4",
      headers: { "user-agent": "essai" },
    } as unknown as AdminRequest;

    await new AdminConsumptionController(d.consumption, d.activity).export(
      request,
      { ...NOW_QUERY, serverId: "5b0d3f5e-0000-4000-8000-000000000001" },
      d.reply,
    );

    expect(d.ordre).toEqual(["trace", "fichier", "envoi"]);
    expect(d.traces[0]).toEqual({
      event: "admin.consumption_exported",
      serverId: null,
      actorId: "a",
      actorType: "user",
      actorLabel: "admin@exemple.fr",
      ip: "192.0.2.4",
      userAgent: "essai",
      properties: {
        format: "jsonl",
        from: "2026-09-01",
        to: "2026-09-10",
        filters: { serverId: "5b0d3f5e-0000-4000-8000-000000000001" },
      },
    });
    expect(d.colonnes[0]).toEqual(CONSUMPTION_COLUMNS);
  });

  it("n'envoie rien si la trace ne s'écrit pas", async () => {
    const d = doublures({ traceFails: true });
    await expect(
      new AdminConsumptionController(d.consumption, d.activity).export(
        ADMIN as unknown as AdminRequest,
        NOW_QUERY,
        d.reply,
      ),
    ).rejects.toThrow("base indisponible");
    expect(d.ordre).toEqual(["trace"]);
  });
});

describe("export d'un revendeur", () => {
  const REVENDEUR = { user: { id: "r", email: "r@exemple.fr", role: "reseller" }, scopes: null };

  it("refuse tout autre rôle, et toute clé d'API", () => {
    expect(guards(ResellerConsumptionController)).toContain(ResellerGuard);
    const guard = new ResellerGuard();
    expect(() => guard.canActivate(context({ ...REVENDEUR, scopes: ["console.read"] }))).toThrow(
      NotFoundException,
    );
    expect(() => guard.canActivate(context({ user: { role: "client" }, scopes: null }))).toThrow(
      NotFoundException,
    );
  });

  it("borne au revendeur de la session et consigne avant l'envoi", async () => {
    const d = doublures();
    await new ResellerConsumptionController(d.consumption, d.activity).export(
      REVENDEUR as unknown as AuthenticatedRequest,
      NOW_QUERY,
      d.reply,
    );
    expect(d.ordre).toEqual(["trace", "fichier", "envoi"]);
    expect(d.traces[0]?.event).toBe("reseller.consumption_exported");
    expect(d.scopes[0]).toEqual({ resellerId: "r" });
  });

  it("n'envoie rien si la trace ne s'écrit pas", async () => {
    const d = doublures({ traceFails: true });
    await expect(
      new ResellerConsumptionController(d.consumption, d.activity).export(
        REVENDEUR as unknown as AuthenticatedRequest,
        NOW_QUERY,
        d.reply,
      ),
    ).rejects.toThrow();
    expect(d.ordre).toEqual(["trace"]);
  });
});

describe("export d'un serveur", () => {
  const CLIENT = { user: { id: "c" }, scopes: null } as unknown as AuthenticatedRequest;
  const ID = "5b0d3f5e-0000-4000-8000-000000000009";

  it("exige console.read, et n'envoie rien sans", async () => {
    const d = doublures();
    const access = {
      require: vi.fn(async () => {
        throw new ForbiddenException("Permission manquante : console.read.");
      }),
    } as unknown as ServerAccessService;

    await expect(
      new ServerConsumptionController(access, d.consumption).export(CLIENT, ID, {}, d.reply),
    ).rejects.toThrow(ForbiddenException);
    expect(access.require).toHaveBeenCalledWith(expect.anything(), ID, "console.read");
    expect(d.ordre).toEqual([]);
  });

  it("borne au serveur de l'adresse et retire les colonnes qui nomment des comptes", async () => {
    const d = doublures();
    const access = { require: vi.fn(async () => undefined) } as unknown as ServerAccessService;

    await new ServerConsumptionController(access, d.consumption).export(
      CLIENT,
      ID,
      // Un filtre glissé dans la requête ne change pas le périmètre.
      { serverId: "5b0d3f5e-0000-4000-8000-00000000000a" },
      d.reply,
    );

    expect(d.scopes[0]).toEqual({ serverId: ID });
    expect(d.colonnes[0]).toEqual(SERVER_CONSUMPTION_COLUMNS);
    expect(d.colonnes[0]).not.toContain("ownerEmail");
  });
});
