import { tokensMatch } from "@gamedashboard/auth";
import { parseWingsAuthorization } from "@gamedashboard/contracts";
import { type CanActivate, type ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { requestOrigin } from "../../common/request-origin";
import { decryptRowSecret } from "../../common/row-secrets";
import { DenialLogService } from "../activity/denial-log.service";
import { type NodeAgentIdentity, NodeAgentRepository } from "./node-agent.repository";

const MAX_TOKEN_ID = 64;

export interface NodeAgentRequest {
  headers: Record<string, string | string[] | undefined>;
  nodeAgent?: NodeAgentIdentity;
  ip?: string;
  method?: string;
  url?: string;
  routeOptions?: { url?: string };
}

/**
 * Authentification des routes `/api/node-agent/*` (ADR 0008 : « exactement
 * le schéma de Wings »).
 *
 * Le calque de `NodeTokenGuard`, sur une autre table et sous un autre
 * contexte de chiffrement : un jeton d'agent ne vaut rien sur `/api/remote`,
 * ni celui du daemon ici. L'agent n'a pas les pouvoirs du daemon, et le
 * daemon ne doit pas gagner ceux de l'agent.
 *
 * Mêmes règles : recherche par identifiant, comparaison à temps constant,
 * même coût qu'un identifiant existe ou non, refus consigné sans le secret.
 */
@Injectable()
export class NodeAgentTokenGuard implements CanActivate {
  constructor(
    @Inject(NodeAgentRepository) private readonly agents: NodeAgentRepository,
    @Inject(DenialLogService) private readonly denials: DenialLogService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<NodeAgentRequest>();
    const header = request.headers.authorization;
    const token = parseWingsAuthorization(typeof header === "string" ? header : undefined);
    if (!token) {
      if (header !== undefined) this.reject(request, null, null);
      return false;
    }

    const agent = await this.agents.findByTokenId(token.id);
    const expected = agent ? safeDecrypt(agent.nodeId, agent.tokenEnc) : "";
    const matches = tokensMatch(expected, token.secret);
    if (!agent || !matches) {
      this.reject(request, token.id, agent?.nodeId ?? null);
      return false;
    }

    request.nodeAgent = agent;
    return true;
  }

  private reject(request: NodeAgentRequest, tokenId: string | null, nodeId: string | null): void {
    void this.denials.record({
      event: "node.agent_token_rejected",
      actorId: null,
      actorType: "system",
      origin: requestOrigin(request),
      properties: { tokenId: tokenId?.slice(0, MAX_TOKEN_ID) ?? null, node: nodeId },
    });
  }
}

/** Une valeur illisible refuse l'appel au lieu de le faire tomber en 500. */
function safeDecrypt(nodeId: string, value: string): string {
  try {
    return decryptRowSecret("node_agents.token_enc", nodeId, value);
  } catch {
    return "";
  }
}
