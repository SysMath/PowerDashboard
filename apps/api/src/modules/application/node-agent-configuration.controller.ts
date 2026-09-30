import { type NodeAgentConfiguration, WINGS_CONFIGURE_PREFIX } from "@gamedashboard/contracts";
import { type Database, nodes } from "@gamedashboard/db";
import {
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Req,
  UseGuards,
} from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DATABASE } from "../../common/database.provider";
import { ActivityService } from "../activity/activity.service";
import { NodeAgentRepository } from "../node-agent/node-agent.repository";
import {
  ApplicationGuard,
  type ApplicationRequest,
  PlatformOnly,
  RequireScopes,
} from "./application.guard";
import { ApplicationKeyRepository } from "./application-key.repository";

/**
 * Mise en service de l'agent de node : `gamedashboard-agent configure`.
 *
 * Le pendant de `NodeConfigurationController` (`wings configure`), avec la
 * même clé d'amorçage, la même portée `nodes.configure`, le même refus des
 * clés de revendeur et la même réponse sans enveloppe. La différence : le
 * jeton de l'agent est **tiré ici**, neuf à chaque appel. Relancer la
 * commande est donc la rotation, et l'ancien jeton meurt au même instant.
 */
@Controller(WINGS_CONFIGURE_PREFIX.replace(/^\//, ""))
@UseGuards(ApplicationGuard)
export class NodeAgentConfigurationController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ApplicationKeyRepository) private readonly keys: ApplicationKeyRepository,
    @Inject(NodeAgentRepository) private readonly agents: NodeAgentRepository,
    @Inject(ActivityService) private readonly activity: ActivityService,
  ) {}

  @Get("nodes/:nodeId/agent-configuration")
  @RequireScopes("nodes.configure")
  @PlatformOnly("la configuration d'un agent de node")
  async configuration(
    @Param("nodeId") nodeId: string,
    @Req() request: ApplicationRequest,
  ): Promise<NodeAgentConfiguration> {
    const bound = request.application.nodeId;
    if (bound !== null && bound !== nodeId) {
      throw new ForbiddenException("Cette clé ne vaut que pour le node auquel elle a été émise.");
    }
    if (!/^[0-9a-f-]{36}$/i.test(nodeId)) throw new NotFoundException("Node inconnu.");

    const [node] = await this.db
      .select({ id: nodes.id })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .limit(1);
    if (!node) throw new NotFoundException("Node inconnu.");

    /*
     * La clé meurt **avant** que le jeton soit tiré, à l'inverse de la route
     * de Wings : ici, rejouer la clé tirerait un second jeton et couperait le
     * premier agent configuré. Une clé brûlée par un échec se réémet depuis
     * l'administration ; un jeton qui en remplace un autre en silence, non.
     */
    if (request.application.singleUse) {
      await this.keys.consume(request.application.keyId);
    }
    const { tokenId, token } = await this.agents.issueToken(node.id);

    await this.activity.record({
      event: "node.agent_configured",
      serverId: null,
      actorId: null,
      actorType: "api_key",
      actorLabel: `application:${request.application.name}`,
      ip: request.ip ?? null,
      properties: { nodeId: node.id, tokenId },
    });

    return {
      uuid: node.id,
      token_id: tokenId,
      token,
      // Même origine que celle donnée à Wings : l'agent refuse de se
      // configurer si elle diffère de celle de son config.yml.
      remote: process.env.PANEL_ORIGIN ?? "http://localhost:3000",
    };
  }
}
