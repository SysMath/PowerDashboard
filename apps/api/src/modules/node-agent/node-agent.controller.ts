import {
  NODE_AGENT_PREFIX,
  NodeAgentHeartbeat,
  type NodeAgentHeartbeatReply,
  normalizeAgentJournalEntry,
} from "@gamedashboard/contracts";
import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { NodeAgentIdentity } from "./node-agent.repository";
import { NodeAgentRepository } from "./node-agent.repository";
import { NodeAgentTokenGuard } from "./node-agent-token.guard";

interface AuthenticatedAgentRequest {
  nodeAgent: NodeAgentIdentity;
}

/**
 * Routes appelées par l'agent de node (ADR 0008, ADR 0009).
 *
 * Comme pour le daemon, aucune route ne lit un identifiant de node dans son
 * corps ou son URL : le node vient du jeton vérifié. Un agent compromis ne
 * parle donc que pour sa propre machine.
 *
 * Les réponses n'ont pas d'enveloppe : l'agent les lit telles quelles.
 */
@Controller(NODE_AGENT_PREFIX.replace(/^\//, ""))
@UseGuards(NodeAgentTokenGuard)
export class NodeAgentController {
  constructor(@Inject(NodeAgentRepository) private readonly agents: NodeAgentRepository) {}

  /**
   * Signe de vie d'une fonction de l'agent, et un lot de son journal.
   *
   * L'accusé rendu est le dernier identifiant rangé : l'agent n'efface que
   * jusque-là, et jamais au-delà de ce qu'il a envoyé.
   */
  @Post("heartbeat")
  @HttpCode(200)
  async heartbeat(
    @Req() request: AuthenticatedAgentRequest,
    @Body() body: unknown,
  ): Promise<NodeAgentHeartbeatReply> {
    const parsed = NodeAgentHeartbeat.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Relevé de l'agent invalide.");
    const input = parsed.data;
    const now = Date.now();
    const agent = request.nodeAgent;
    const acked = await this.agents.recordHeartbeat(
      agent,
      {
        version: input.version,
        fonction: input.fonction,
        fonctions: [...new Set(input.fonctions)],
        journal: input.journal.map((entry) => normalizeAgentJournalEntry(entry, now)),
        gap: input.trou,
      },
      `Agent — ${agent.nodeName}`,
    );
    return { journal_accuse: acked };
  }
}
