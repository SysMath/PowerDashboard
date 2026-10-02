import {
  type AdminNodeAgentView,
  nodeAgentConfigurationPath,
  nodeAgentStatus,
  nodeCapabilities,
} from "@gamedashboard/contracts";
import {
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ActivityService } from "../activity/activity.service";
import { AdminGuard } from "../admin/admin.guard";
import type { AdminRequest } from "../admin/admin-input";
import { AdminWriteGuard } from "../admin/admin-write.guard";
import { StaffTwoFactorGuard } from "../admin/staff-2fa.guard";
import { SessionGuard } from "../auth/session.guard";
import { NodeAgentRepository } from "./node-agent.repository";
import { NodeCapabilitiesService } from "./node-capabilities.service";

const NODE_ID = new ParseUUIDPipe({
  exceptionFactory: () => new NotFoundException("Node introuvable."),
});

/**
 * L'agent d'un node, vu de l'administration : son état, ce qu'il offre, et
 * son retrait.
 *
 * La mise en service passe par la clé d'amorçage du node (la même que pour
 * `wings configure`) et `gamedashboard-agent configure` : il n'y a pas de
 * route pour créer un agent ici, ni pour lire son jeton.
 */
@Controller("api/v1/admin/nodes")
@UseGuards(SessionGuard, AdminGuard, StaffTwoFactorGuard)
export class AdminNodeAgentController {
  constructor(
    @Inject(NodeAgentRepository) private readonly agents: NodeAgentRepository,
    @Inject(NodeCapabilitiesService) private readonly capabilities: NodeCapabilitiesService,
    @Inject(ActivityService) private readonly activity: ActivityService,
  ) {}

  @Get(":nodeId/agent")
  async show(@Param("nodeId", NODE_ID) nodeId: string): Promise<{ data: AdminNodeAgentView }> {
    const [agent, platform] = await Promise.all([
      this.agents.find(nodeId),
      this.capabilities.platformSwitches(),
    ]);
    return {
      data: {
        status: nodeAgentStatus(agent),
        version: agent?.version ?? null,
        functions: [...(agent?.functions ?? [])],
        lastSeenAt: agent?.lastSeenAt ?? null,
        tokenIssuedAt: agent?.tokenIssuedAt ?? null,
        capabilities: nodeCapabilities(agent, platform),
        configurationPath: nodeAgentConfigurationPath(nodeId),
      },
    };
  }

  /**
   * Retire l'agent : son jeton cesse aussitôt de valoir, et les fonctions
   * qu'il servait disparaissent de ce node. Rien n'est touché sur la machine ;
   * l'agent y reçoit des refus jusqu'à ce qu'on l'arrête ou le reconfigure.
   */
  @Delete(":nodeId/agent")
  @UseGuards(AdminWriteGuard)
  async remove(@Req() request: AdminRequest, @Param("nodeId", NODE_ID) nodeId: string) {
    if (!(await this.agents.remove(nodeId))) {
      throw new NotFoundException("Aucun agent n'est enregistré pour ce node.");
    }
    await this.activity.record({
      event: "node.agent_revoked",
      serverId: null,
      actorId: request.user.id,
      actorType: "user",
      actorLabel: request.user.email,
      ip: request.ip ?? null,
      properties: { nodeId },
    });
    return { data: { nodeId } };
  }
}
