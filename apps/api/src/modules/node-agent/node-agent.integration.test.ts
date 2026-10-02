import type { NodeAgentHeartbeat } from "@gamedashboard/contracts";
import { activityLogs, type Database, nodeAgents, nodes } from "@gamedashboard/db";
import { type ExecutionContext, ForbiddenException } from "@nestjs/common";
import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { seedLocation, seedNode } from "../../test/fixtures";
import {
  createThrowawayDatabase,
  HAS_DATABASE,
  type ThrowawayDatabase,
} from "../../test/throwaway-database";
import type { ActivityService } from "../activity/activity.service";
import type { DenialLogService } from "../activity/denial-log.service";
import type { ApplicationRequest } from "../application/application.guard";
import type { ApplicationKeyRepository } from "../application/application-key.repository";
import { NodeAgentConfigurationController } from "../application/node-agent-configuration.controller";
import { NodeAgentController } from "./node-agent.controller";
import { NodeAgentRepository } from "./node-agent.repository";
import { type NodeAgentRequest, NodeAgentTokenGuard } from "./node-agent-token.guard";

process.env.APP_SECRET_KEY ??= "clé de test de l'agent de node, factice et assez longue";

/**
 * Socle de l'agent de node contre une vraie base (ADR 0008, 0009) :
 * `configure` tire le jeton, la garde le reconnaît, le relevé range le
 * journal une seule fois, même rejoué ou envoyé par deux services à la fois.
 */
describe.skipIf(!HAS_DATABASE)("agent de node (intégration)", () => {
  let throwaway: ThrowawayDatabase;
  let db: Database;
  let agents: NodeAgentRepository;
  let heartbeat: NodeAgentController;
  let nodeId: string;
  const consume = vi.fn(async () => {});
  const record = vi.fn(async () => {});

  beforeAll(async () => {
    throwaway = await createThrowawayDatabase();
    db = throwaway.db;
    agents = new NodeAgentRepository(db);
    heartbeat = new NodeAgentController(agents);
  }, 60_000);

  afterAll(async () => {
    await throwaway?.drop();
  });

  beforeEach(async () => {
    await db.execute(
      sql.raw("truncate table activity_logs, node_agents, nodes, locations cascade"),
    );
    nodeId = await seedNode(db, { locationId: await seedLocation(db), name: "RYZEN-09" });
    consume.mockClear();
    record.mockClear();
  });

  function configuration(key: Partial<ApplicationRequest["application"]> = {}) {
    const controller = new NodeAgentConfigurationController(
      db,
      { consume } as unknown as ApplicationKeyRepository,
      agents,
      { record } as unknown as ActivityService,
    );
    const request: ApplicationRequest = {
      application: {
        keyId: "cle",
        name: "Mise en service — RYZEN-09",
        scopes: ["nodes.configure"],
        nodeId,
        resellerId: null,
        singleUse: true,
        ...key,
      } as ApplicationRequest["application"],
      ip: "203.0.113.9",
    };
    return controller.configuration(nodeId, request);
  }

  async function authentifier(tokenId: string, token: string) {
    const request: NodeAgentRequest = {
      headers: { authorization: `Bearer ${tokenId}.${token}` },
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    const denials = { record: vi.fn(async () => {}) } as unknown as DenialLogService;
    const ok = await new NodeAgentTokenGuard(agents, denials).canActivate(context);
    return ok ? request.nodeAgent : undefined;
  }

  function releve(over: Partial<NodeAgentHeartbeat> = {}): NodeAgentHeartbeat {
    return {
      version: "1.0.0",
      fonction: "instantanes",
      fonctions: ["instantanes"],
      journal: [],
      trou: false,
      ...over,
    };
  }

  const entrees = (...ids: number[]) =>
    ids.map((id) => ({
      id,
      horodatage: "2026-09-30T12:00:00Z",
      niveau: "info",
      fonction: "instantanes",
      evenement: `evenement-${id}`,
    }));

  async function journal() {
    return db
      .select({ event: activityLogs.event, properties: activityLogs.properties })
      .from(activityLogs)
      .where(sql`${activityLogs.event} like 'node.agent_journal%'`)
      .orderBy(asc(activityLogs.at));
  }

  it("configure tire un jeton que la garde reconnaît, et brûle la clé", async () => {
    const conf = await configuration();
    expect(conf.uuid).toBe(nodeId);
    expect(conf.token_id).toMatch(/^[0-9a-f]{16}$/);
    expect(conf.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(consume).toHaveBeenCalledWith("cle");
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ event: "node.agent_configured" }),
    );
    expect(JSON.stringify(record.mock.calls)).not.toContain(conf.token);

    const [row] = await db.select().from(nodeAgents).where(eq(nodeAgents.nodeId, nodeId));
    // Chiffré en base, jamais en clair.
    expect(row?.tokenEnc).not.toContain(conf.token);
    expect((await authentifier(conf.token_id, conf.token))?.nodeId).toBe(nodeId);
  });

  it("relancer configure est la rotation : l'ancien jeton cesse de valoir", async () => {
    const premier = await configuration();
    await heartbeat.heartbeat(
      { nodeAgent: (await authentifier(premier.token_id, premier.token)) as never },
      releve({ journal: entrees(1, 2, 3) }),
    );
    const second = await configuration();
    expect(await authentifier(premier.token_id, premier.token)).toBeUndefined();
    const agent = await authentifier(second.token_id, second.token);
    expect(agent?.nodeId).toBe(nodeId);

    // Base locale neuve : sa numérotation recommence, rien n'est pris pour un doublon.
    const reponse = await heartbeat.heartbeat(
      { nodeAgent: agent as never },
      releve({ journal: entrees(1) }),
    );
    expect(reponse).toEqual({ journal_accuse: 1 });
    expect(await journal()).toHaveLength(4);
  });

  it("refuse une clé bornée à un autre node", async () => {
    await expect(
      configuration({ nodeId: "33333333-3333-3333-3333-333333333333" }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(consume).not.toHaveBeenCalled();
  });

  it("range le journal une seule fois, rejoué ou envoyé par deux services à la fois", async () => {
    const conf = await configuration();
    const agent = (await authentifier(conf.token_id, conf.token)) as never;

    const [a, b] = await Promise.all([
      heartbeat.heartbeat({ nodeAgent: agent }, releve({ journal: entrees(1, 2, 3) })),
      heartbeat.heartbeat({ nodeAgent: agent }, releve({ journal: entrees(1, 2, 3) })),
    ]);
    expect(a.journal_accuse).toBe(3);
    expect(b.journal_accuse).toBe(3);

    // Accusé perdu : l'agent renvoie 2 et 3 avec la suivante.
    const c = await heartbeat.heartbeat(
      { nodeAgent: agent },
      releve({ journal: entrees(2, 3, 4) }),
    );
    expect(c.journal_accuse).toBe(4);

    const lignes = await journal();
    expect(lignes.map((l) => (l.properties as { event: string }).event)).toEqual([
      "evenement-1",
      "evenement-2",
      "evenement-3",
      "evenement-4",
    ]);
    expect(lignes[0]?.properties).toMatchObject({ nodeId, entry: 1, function: "instantanes" });
  });

  it("note la version, les fonctions, le signe de vie de chaque service, et le trou", async () => {
    const conf = await configuration();
    const agent = (await authentifier(conf.token_id, conf.token)) as never;
    await heartbeat.heartbeat(
      { nodeAgent: agent },
      releve({
        version: "1.2.0",
        fonctions: ["instantanes", "pare-feu", "instantanes"],
        trou: true,
      }),
    );
    await heartbeat.heartbeat({ nodeAgent: agent }, releve({ fonction: "pare-feu" }));

    const vu = await agents.find(nodeId);
    expect(vu?.version).toBe("1.0.0");
    expect(vu?.functions).toEqual(["instantanes"]);
    expect(Object.keys(vu?.functionsSeen ?? {}).sort()).toEqual(["instantanes", "pare-feu"]);
    expect(vu?.lastSeenAt).not.toBeNull();
    expect((await journal()).map((l) => l.event)).toEqual(["node.agent_journal_gap"]);
  });

  it("refuse un relevé mal formé sans rien écrire", async () => {
    const conf = await configuration();
    const agent = (await authentifier(conf.token_id, conf.token)) as never;
    await expect(
      heartbeat.heartbeat({ nodeAgent: agent }, { ...releve(), fonction: "../x" }),
    ).rejects.toThrow(/invalide/);
    expect((await agents.find(nodeId))?.lastSeenAt).toBeNull();
  });

  it("disparaît avec son node, et se retire sans toucher au node", async () => {
    const conf = await configuration();
    expect(await agents.remove(nodeId)).toBe(true);
    expect(await authentifier(conf.token_id, conf.token)).toBeUndefined();
    expect(await agents.remove(nodeId)).toBe(false);

    await configuration();
    await db.delete(nodes).where(eq(nodes.id, nodeId));
    expect(await db.select().from(nodeAgents)).toHaveLength(0);
  });
});
