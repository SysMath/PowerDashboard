import {
  NODE_AGENT_FUNCTION_NAMES,
  NODE_AGENT_FUNCTIONS,
  type NodeAgentFunction,
  type NodeCapabilities,
  type NodeCapability,
  nodeCapabilities,
} from "@gamedashboard/contracts";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { PlatformSettingsService } from "../admin/platform-settings.service";
import { NodeAgentRepository } from "./node-agent.repository";

/**
 * Ce que le panel offre sur un node : `nodeCapabilities()` nourrie de la base
 * et des interrupteurs globaux.
 *
 * Les routes d'une fonction de l'agent passent par `require()` : l'écran et
 * l'API lisent la même règle, et une route ne sert jamais ce que l'écran
 * cache.
 */
@Injectable()
export class NodeCapabilitiesService {
  constructor(
    @Inject(NodeAgentRepository) private readonly agents: NodeAgentRepository,
    @Inject(PlatformSettingsService) private readonly settings: PlatformSettingsService,
  ) {}

  async platformSwitches(): Promise<Record<NodeAgentFunction, boolean>> {
    const out = {} as Record<NodeAgentFunction, boolean>;
    for (const name of NODE_AGENT_FUNCTION_NAMES) {
      out[name] = await this.settings.boolean(NODE_AGENT_FUNCTIONS[name].setting);
    }
    return out;
  }

  async forNode(nodeId: string): Promise<NodeCapabilities> {
    const [agent, platform] = await Promise.all([
      this.agents.find(nodeId),
      this.platformSwitches(),
    ]);
    return nodeCapabilities(agent, platform);
  }

  /**
   * Refuse ce que la règle n'offre pas.
   *
   * - fonction absente (coupée, pas d'agent) : 404, comme une route qui
   *   n'existe pas sur ce node ;
   * - écriture sur une fonction muette : 409, « la machine ne répond pas ».
   */
  async require(
    nodeId: string,
    fn: NodeAgentFunction,
    mode: "read" | "write",
  ): Promise<NodeCapability> {
    const capability = (await this.forNode(nodeId))[fn];
    if (!capability.offered) {
      throw new NotFoundException(capability.reason ?? "Fonction indisponible sur ce node.");
    }
    if (mode === "write" && !capability.writable) {
      throw new ConflictException(
        "La machine ne répond pas : l'agent de node ne s'est pas manifesté depuis plus de deux minutes.",
      );
    }
    return capability;
  }
}
