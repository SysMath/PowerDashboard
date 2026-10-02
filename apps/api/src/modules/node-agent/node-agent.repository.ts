import { randomBytes } from "node:crypto";
import type { NodeAgentSnapshot, NormalizedAgentJournalEntry } from "@gamedashboard/contracts";
import { activityLogs, type Database, nodeAgents, nodes } from "@gamedashboard/db";
import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DATABASE } from "../../common/database.provider";
import { encryptRowSecret } from "../../common/row-secrets";

export interface NodeAgentIdentity {
  nodeId: string;
  nodeName: string;
  tokenId: string;
  /** Chiffré, lié à la ligne (`node_agents.token_enc:<node>`). */
  tokenEnc: string;
}

export interface NodeAgentRow extends NodeAgentSnapshot {
  nodeId: string;
  tokenIssuedAt: string;
}

export interface HeartbeatInput {
  version: string;
  fonction: string;
  fonctions: string[];
  journal: NormalizedAgentJournalEntry[];
  gap: boolean;
}

@Injectable()
export class NodeAgentRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Même recherche que pour le daemon : une lecture indexée par identifiant. */
  async findByTokenId(tokenId: string): Promise<NodeAgentIdentity | null> {
    const [row] = await this.db
      .select({
        nodeId: nodeAgents.nodeId,
        nodeName: nodes.name,
        tokenId: nodeAgents.tokenId,
        tokenEnc: nodeAgents.tokenEnc,
      })
      .from(nodeAgents)
      .innerJoin(nodes, eq(nodes.id, nodeAgents.nodeId))
      .where(eq(nodeAgents.tokenId, tokenId))
      .limit(1);
    return row ?? null;
  }

  async find(nodeId: string): Promise<NodeAgentRow | null> {
    const [row] = await this.db
      .select({
        nodeId: nodeAgents.nodeId,
        version: nodeAgents.version,
        functions: nodeAgents.functions,
        functionsSeen: nodeAgents.functionsSeen,
        lastSeenAt: nodeAgents.lastSeenAt,
        tokenIssuedAt: nodeAgents.tokenIssuedAt,
      })
      .from(nodeAgents)
      .where(eq(nodeAgents.nodeId, nodeId))
      .limit(1);
    return row ?? null;
  }

  /**
   * Tire un jeton neuf pour l'agent du node, en créant la ligne au besoin.
   *
   * Chaque `configure` en tire un : relancer la commande **est** la rotation,
   * et l'ancien jeton cesse de valoir à l'instant même. Le panel n'appelle
   * jamais l'agent, il n'y a donc rien à lui pousser ni à confirmer, à
   * l'inverse du jeton de Wings.
   *
   * Le suivi du journal repart de zéro : une configuration neuve va souvent
   * avec une base locale neuve, qui recommence sa numérotation, et ses
   * premières entrées seraient sinon prises pour des doublons.
   */
  async issueToken(nodeId: string): Promise<{ tokenId: string; token: string }> {
    const tokenId = randomBytes(8).toString("hex");
    const token = randomBytes(32).toString("base64url");
    const now = new Date().toISOString();
    const tokenEnc = encryptRowSecret("node_agents.token_enc", nodeId, token);
    await this.db
      .insert(nodeAgents)
      .values({ nodeId, tokenId, tokenEnc, tokenIssuedAt: now })
      .onConflictDoUpdate({
        target: nodeAgents.nodeId,
        set: { tokenId, tokenEnc, tokenIssuedAt: now, journalAckedId: 0, updatedAt: now },
      });
    return { tokenId, token };
  }

  /** Retire l'agent : son jeton cesse de valoir, ses fonctions disparaissent. */
  async remove(nodeId: string): Promise<boolean> {
    const removed = await this.db
      .delete(nodeAgents)
      .where(eq(nodeAgents.nodeId, nodeId))
      .returning({ nodeId: nodeAgents.nodeId });
    return removed.length > 0;
  }

  /**
   * Enregistre un relevé : version, fonctions, signe de vie de la fonction
   * qui parle, et les entrées de journal pas encore rangées.
   *
   * Une seule transaction, ligne verrouillée : chaque fonction a son service,
   * et deux services qui envoient le même lot en même temps ne doivent pas
   * le consigner deux fois. Rend le dernier identifiant rangé, que l'agent
   * reçoit comme accusé.
   */
  async recordHeartbeat(
    agent: NodeAgentIdentity,
    input: HeartbeatInput,
    actorLabel: string,
  ): Promise<number> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ acked: nodeAgents.journalAckedId, seen: nodeAgents.functionsSeen })
        .from(nodeAgents)
        .where(eq(nodeAgents.nodeId, agent.nodeId))
        .for("update");
      if (!row) return 0;

      const fresh = input.journal.filter((entry) => entry.id > row.acked);
      const now = new Date().toISOString();
      const logs: (typeof activityLogs.$inferInsert)[] = fresh.map((entry) => ({
        actorId: null,
        actorType: "system",
        actorLabel,
        serverId: null,
        event: "node.agent_journal",
        properties: {
          nodeId: agent.nodeId,
          entry: entry.id,
          level: entry.level,
          function: entry.function,
          event: entry.event,
          ...(entry.server ? { server: entry.server } : {}),
          ...(entry.detail ? { detail: entry.detail } : {}),
        },
        at: entry.at,
      }));
      if (input.gap) {
        logs.push({
          actorId: null,
          actorType: "system",
          actorLabel,
          serverId: null,
          event: "node.agent_journal_gap",
          properties: { nodeId: agent.nodeId },
          at: now,
        });
      }
      if (logs.length > 0) await tx.insert(activityLogs).values(logs);

      const acked = fresh.reduce((max, entry) => Math.max(max, entry.id), row.acked);
      await tx
        .update(nodeAgents)
        .set({
          version: input.version || null,
          functions: input.fonctions,
          functionsSeen: { ...row.seen, [input.fonction]: now },
          lastSeenAt: now,
          journalAckedId: acked,
          updatedAt: now,
        })
        .where(eq(nodeAgents.nodeId, agent.nodeId));
      return acked;
    });
  }
}
