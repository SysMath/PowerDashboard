import { ConflictException, NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { PlatformSettingsService } from "../admin/platform-settings.service";
import type { NodeAgentRepository, NodeAgentRow } from "./node-agent.repository";
import { NodeCapabilitiesService } from "./node-capabilities.service";

const NODE = "44444444-4444-4444-4444-444444444444";

function service(agent: NodeAgentRow | null, interrupteur = true) {
  const agents = { find: vi.fn(async () => agent) } as unknown as NodeAgentRepository;
  const boolean = vi.fn(async () => interrupteur);
  const settings = { boolean } as unknown as PlatformSettingsService;
  return { svc: new NodeCapabilitiesService(agents, settings), boolean };
}

function agent(vuIlYa: number): NodeAgentRow {
  const vu = new Date(Date.now() - vuIlYa).toISOString();
  return {
    nodeId: NODE,
    version: "1.0.0",
    functions: ["instantanes"],
    functionsSeen: { instantanes: vu },
    lastSeenAt: vu,
    tokenIssuedAt: vu,
  };
}

describe("NodeCapabilitiesService.require", () => {
  it("lit l'interrupteur global de la fonction", async () => {
    const { svc, boolean } = service(agent(1000));
    await svc.require(NODE, "instantanes", "write");
    expect(boolean).toHaveBeenCalledWith("agent.instantanes");
  });

  it("répond 404 sur un node sans agent, comme une route absente", async () => {
    await expect(service(null).svc.require(NODE, "instantanes", "read")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("répond 404 quand la fonction est coupée pour la plateforme", async () => {
    await expect(
      service(agent(1000), false).svc.require(NODE, "instantanes", "read"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("laisse lire mais refuse d'écrire (409) quand l'agent s'est tu", async () => {
    const { svc } = service(agent(10 * 60_000));
    await expect(svc.require(NODE, "instantanes", "read")).resolves.toMatchObject({
      state: "silent",
    });
    await expect(svc.require(NODE, "instantanes", "write")).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
