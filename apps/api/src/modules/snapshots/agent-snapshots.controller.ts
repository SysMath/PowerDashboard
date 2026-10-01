import {
  AgentSnapshotReport,
  type AgentSnapshotState,
  NODE_AGENT_PREFIX,
} from "@gamedashboard/contracts";
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { NodeAgentIdentity } from "../node-agent/node-agent.repository";
import { NodeAgentTokenGuard } from "../node-agent/node-agent-token.guard";
import { SnapshotsService } from "./snapshots.service";

interface AgentRequest {
  nodeAgent: NodeAgentIdentity;
}

/**
 * Routes des instantanés tirées par l'agent (ADR 0009, « Liaison avec le
 * panel »). Le node vient du jeton, jamais de l'URL ni du corps.
 */
@Controller(NODE_AGENT_PREFIX.replace(/^\//, ""))
@UseGuards(NodeAgentTokenGuard)
export class AgentSnapshotsController {
  constructor(@Inject(SnapshotsService) private readonly snapshots: SnapshotsService) {}

  @Get("snapshots")
  state(@Req() request: AgentRequest): Promise<AgentSnapshotState> {
    return this.snapshots.agentState(request.nodeAgent.nodeId);
  }

  @Post("snapshots/report")
  @HttpCode(204)
  async report(@Req() request: AgentRequest, @Body() body: unknown): Promise<void> {
    const parsed = AgentSnapshotReport.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Rapport d'instantanés invalide.");
    await this.snapshots.applyReport(request.nodeAgent.nodeId, parsed.data);
  }
}
