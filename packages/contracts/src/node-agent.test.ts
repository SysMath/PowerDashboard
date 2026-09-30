import { describe, expect, it } from "vitest";
import {
  NODE_AGENT_FUNCTION_NAMES,
  NODE_AGENT_FUNCTIONS,
  NODE_AGENT_PREFIX,
  NODE_AGENT_SILENT_MS,
  NodeAgentHeartbeat,
  type NodeAgentSnapshot,
  nodeAgentConfigurationPath,
  nodeAgentStatus,
  nodeCapabilities,
  normalizeAgentJournalEntry,
} from "./node-agent";
import { SETTING_BY_KEY } from "./platform-settings";
import { WINGS_CONFIGURE_PREFIX } from "./wings-node-config";

const NOW = Date.parse("2026-09-30T14:00:00Z");
const recent = new Date(NOW - 30_000).toISOString();
const ancien = new Date(NOW - NODE_AGENT_SILENT_MS - 1000).toISOString();

function agent(over: Partial<NodeAgentSnapshot> = {}): NodeAgentSnapshot {
  return {
    version: "1.0.0",
    functions: ["instantanes"],
    functionsSeen: { instantanes: recent },
    lastSeenAt: recent,
    ...over,
  };
}

describe("routes de l'agent", () => {
  it("suit le préfixe et la clé de `wings configure`", () => {
    expect(NODE_AGENT_PREFIX).toBe("/api/node-agent");
    expect(nodeAgentConfigurationPath("abc")).toBe(
      `${WINGS_CONFIGURE_PREFIX}/nodes/abc/agent-configuration`,
    );
  });

  it("donne à chaque fonction un interrupteur booléen déclaré", () => {
    for (const name of NODE_AGENT_FUNCTION_NAMES) {
      expect(SETTING_BY_KEY.get(NODE_AGENT_FUNCTIONS[name].setting)?.kind, name).toBe("boolean");
    }
  });
});

describe("nodeCapabilities", () => {
  const on = { instantanes: true };

  it("offre une fonction annoncée par un agent qui parle", () => {
    const c = nodeCapabilities(agent(), on, NOW).instantanes;
    expect(c).toEqual({ state: "active", offered: true, writable: true, reason: null });
  });

  it("la retire partout quand l'interrupteur global est coupé, agent ou non", () => {
    expect(nodeCapabilities(agent(), { instantanes: false }, NOW).instantanes.state).toBe(
      "platform_disabled",
    );
    // Un interrupteur absent ferme la porte.
    expect(nodeCapabilities(agent(), {}, NOW).instantanes.offered).toBe(false);
  });

  it("la retire sur un node sans agent, avec la raison", () => {
    const c = nodeCapabilities(null, on, NOW).instantanes;
    expect(c.state).toBe("absent");
    expect(c.offered).toBe(false);
    expect(c.reason).toMatch(/Aucun agent/);
  });

  it("la retire quand l'agent ne l'a pas dans son config.yml", () => {
    const c = nodeCapabilities(agent({ functions: ["pare-feu"] }), on, NOW).instantanes;
    expect(c.state).toBe("node_disabled");
    expect(c.offered).toBe(false);
  });

  it("la laisse lisible mais refuse les écritures quand sa fonction s'est tue", () => {
    const c = nodeCapabilities(
      agent({ functionsSeen: { instantanes: ancien } }),
      on,
      NOW,
    ).instantanes;
    expect(c).toMatchObject({ state: "silent", offered: true, writable: false });
  });

  it("juge chaque fonction sur son propre service, pas sur l'agent entier", () => {
    // Le service du pare-feu parle, celui des instantanés s'est arrêté.
    const c = nodeCapabilities(
      agent({ functionsSeen: { "pare-feu": recent }, lastSeenAt: recent }),
      on,
      NOW,
    ).instantanes;
    expect(c.state).toBe("silent");
  });
});

describe("nodeAgentStatus", () => {
  it("distingue l'absence, la présence et le silence", () => {
    expect(nodeAgentStatus(null, NOW)).toBe("none");
    expect(nodeAgentStatus(agent(), NOW)).toBe("online");
    expect(nodeAgentStatus(agent({ lastSeenAt: ancien }), NOW)).toBe("silent");
    expect(nodeAgentStatus(agent({ lastSeenAt: null }), NOW)).toBe("silent");
  });
});

describe("NodeAgentHeartbeat", () => {
  const base = {
    version: "1.0.0",
    fonction: "instantanes",
    fonctions: [],
    journal: [],
    trou: false,
  };

  it("accepte le relevé tel que l'agent Go l'envoie", () => {
    const ok = NodeAgentHeartbeat.safeParse({
      ...base,
      fonctions: ["instantanes"],
      journal: [
        {
          id: 12,
          horodatage: "2026-09-30T13:59:00.123456789Z",
          niveau: "alerte",
          fonction: "instantanes",
          evenement: "prendre",
        },
      ],
    });
    expect(ok.success).toBe(true);
  });

  it("refuse une fonction mal nommée et un lot trop gros", () => {
    expect(NodeAgentHeartbeat.safeParse({ ...base, fonction: "../x" }).success).toBe(false);
    const lot = Array.from({ length: 501 }, (_, i) => ({ id: i + 1 }));
    expect(NodeAgentHeartbeat.safeParse({ ...base, journal: lot }).success).toBe(false);
  });

  it("n'exige que l'identifiant d'une entrée : une entrée refusée bloquerait les suivantes", () => {
    expect(
      NodeAgentHeartbeat.safeParse({ ...base, journal: [{ id: 3, niveau: 42, detail: [] }] })
        .success,
    ).toBe(true);
    expect(NodeAgentHeartbeat.safeParse({ ...base, journal: [{ niveau: "info" }] }).success).toBe(
      false,
    );
  });
});

describe("normalizeAgentJournalEntry", () => {
  it("garde l'heure de la machine quand elle est plausible", () => {
    const e = normalizeAgentJournalEntry(
      {
        id: 1,
        horodatage: "2026-09-30T12:00:00Z",
        niveau: "erreur",
        fonction: "instantanes",
        evenement: "restaurer",
        serveur: "AAAAAAAA-1111-2222-3333-444444444444",
        detail: "échec",
      },
      NOW,
    );
    expect(e).toEqual({
      id: 1,
      at: "2026-09-30T12:00:00.000Z",
      level: "erreur",
      function: "instantanes",
      event: "restaurer",
      server: "aaaaaaaa-1111-2222-3333-444444444444",
      detail: "échec",
    });
  });

  it("ramène le reste à une forme sûre", () => {
    const e = normalizeAgentJournalEntry(
      {
        id: 2,
        horodatage: "2999-01-01T00:00:00Z",
        niveau: "panique",
        fonction: "Rm -rf",
        evenement: 7,
        serveur: "../../etc",
        detail: `a\u0000b${"x".repeat(5000)}`,
      },
      NOW,
    );
    expect(e.at).toBe(new Date(NOW).toISOString());
    expect(e.level).toBe("info");
    expect(e.function).toBe("inconnue");
    expect(e.event).toBe("inconnu");
    expect(e.server).toBeNull();
    expect(e.detail?.startsWith("ab")).toBe(true);
    expect(e.detail).toHaveLength(2000);
  });
});
