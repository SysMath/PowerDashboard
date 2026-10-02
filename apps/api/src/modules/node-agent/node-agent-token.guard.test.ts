import { generateToken } from "@gamedashboard/auth";
import type { ExecutionContext } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { encryptRowSecret } from "../../common/row-secrets";
import type { Denial, DenialLogService } from "../activity/denial-log.service";
import type { NodeAgentIdentity, NodeAgentRepository } from "./node-agent.repository";
import { type NodeAgentRequest, NodeAgentTokenGuard } from "./node-agent-token.guard";

process.env.APP_SECRET_KEY = "clé de test des gardes, factice et assez longue";

const SECRET = generateToken();
const NODE_ID = "22222222-2222-2222-2222-222222222222";
const AGENT: NodeAgentIdentity = {
  nodeId: NODE_ID,
  nodeName: "RYZEN-09",
  tokenId: "0123456789abcdef",
  tokenEnc: encryptRowSecret("node_agents.token_enc", NODE_ID, SECRET),
};

function repository(agent: NodeAgentIdentity = AGENT): NodeAgentRepository {
  return {
    findByTokenId: vi.fn(async (id: string) => (id === agent.tokenId ? agent : null)),
  } as unknown as NodeAgentRepository;
}

function journal() {
  const refus: Denial[] = [];
  const denials = {
    record: vi.fn(async (d: Denial) => {
      refus.push(d);
    }),
  } as unknown as DenialLogService;
  return { denials, refus };
}

function contextWith(authorization?: string) {
  const request: NodeAgentRequest = {
    headers: authorization === undefined ? {} : { authorization },
    ip: "203.0.113.9",
    method: "POST",
    url: "/api/node-agent/heartbeat",
    routeOptions: { url: "/api/node-agent/heartbeat" },
  };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

describe("NodeAgentTokenGuard", () => {
  it("accepte le jeton de l'agent et attache l'agent à la requête", async () => {
    const { context, request } = contextWith(`Bearer ${AGENT.tokenId}.${SECRET}`);
    const { denials } = journal();
    expect(await new NodeAgentTokenGuard(repository(), denials).canActivate(context)).toBe(true);
    expect(request.nodeAgent).toEqual(AGENT);
  });

  it("refuse un secret faux, et le consigne sans le secret", async () => {
    const faux = generateToken();
    const { context, request } = contextWith(`Bearer ${AGENT.tokenId}.${faux}`);
    const { denials, refus } = journal();
    expect(await new NodeAgentTokenGuard(repository(), denials).canActivate(context)).toBe(false);
    expect(request.nodeAgent).toBeUndefined();
    expect(refus).toHaveLength(1);
    expect(refus[0]?.event).toBe("node.agent_token_rejected");
    expect(refus[0]?.properties).toEqual({ tokenId: AGENT.tokenId, node: NODE_ID });
    expect(JSON.stringify(refus)).not.toContain(faux);
  });

  it("n'accepte pas le jeton du daemon recopié dans la table des agents", async () => {
    // Même valeur, autre contexte de chiffrement : le jeton de Wings ne vaut
    // rien ici, et une ligne recopiée d'une colonne à l'autre non plus.
    const recopie = {
      ...AGENT,
      tokenEnc: encryptRowSecret("nodes.daemon_token_enc", NODE_ID, SECRET),
    };
    const { context } = contextWith(`Bearer ${AGENT.tokenId}.${SECRET}`);
    const { denials } = journal();
    expect(await new NodeAgentTokenGuard(repository(recopie), denials).canActivate(context)).toBe(
      false,
    );
  });

  it("refuse un identifiant inconnu après l'avoir cherché", async () => {
    const repo = repository();
    const { context } = contextWith(`Bearer inconnu.${SECRET}`);
    const { denials, refus } = journal();
    expect(await new NodeAgentTokenGuard(repo, denials).canActivate(context)).toBe(false);
    expect(repo.findByTokenId).toHaveBeenCalledWith("inconnu");
    expect(refus[0]?.properties).toEqual({ tokenId: "inconnu", node: null });
  });

  it("refuse sans bruit un appel sans en-tête, et consigne un en-tête illisible", async () => {
    const vide = journal();
    expect(
      await new NodeAgentTokenGuard(repository(), vide.denials).canActivate(
        contextWith(undefined).context,
      ),
    ).toBe(false);
    expect(vide.refus).toHaveLength(0);

    const illisible = journal();
    expect(
      await new NodeAgentTokenGuard(repository(), illisible.denials).canActivate(
        contextWith("Basic abc").context,
      ),
    ).toBe(false);
    expect(illisible.refus).toHaveLength(1);
  });
});
