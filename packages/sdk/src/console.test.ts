import { describe, expect, it } from "vitest";
import { GameDashboardClient } from "./client";
import { type ConsoleEvent, openServerConsole } from "./console";

/**
 * Une socket factice : elle note comment on l'a construite et ce qu'on lui
 * envoie, et laisse le test jouer le rôle du daemon.
 */
class FausseSocket {
  static derniere: FausseSocket | null = null;
  readonly envoyes: string[] = [];
  private readonly ecouteurs = new Map<string, ((event: { data?: unknown }) => void)[]>();

  constructor(
    readonly url: string,
    readonly protocoles?: unknown,
    readonly options?: { headers?: Record<string, string> },
  ) {
    FausseSocket.derniere = this;
  }

  addEventListener(type: string, ecouteur: (event: { data?: unknown }) => void) {
    this.ecouteurs.set(type, [...(this.ecouteurs.get(type) ?? []), ecouteur]);
  }

  send(data: string) {
    this.envoyes.push(data);
  }

  close() {
    this.emettre("close");
  }

  emettre(type: string, data?: unknown) {
    for (const ecouteur of this.ecouteurs.get(type) ?? []) ecouteur({ data });
  }
}

function client() {
  return new GameDashboardClient({
    baseUrl: "https://panel.example",
    token: "gd_mob_essai",
    fetch: async () =>
      new Response(
        JSON.stringify({ data: { token: "jwt", socket: "wss://node.example:8080/ws" } }),
        { status: 200 },
      ),
  });
}

describe("openServerConsole", () => {
  it("présente l'origine du panel au daemon quand on la lui donne", async () => {
    // Wings refuse une console dont l'en-tête Origin n'est pas l'adresse du
    // panel ; l'application mobile n'a pas de navigateur pour la poser.
    await openServerConsole(client(), "s1", () => {}, {
      WebSocketImpl: FausseSocket as unknown as typeof WebSocket,
      origin: "https://panel.example",
    });
    expect(FausseSocket.derniere?.url).toBe("wss://node.example:8080/ws");
    expect(FausseSocket.derniere?.options?.headers).toEqual({ Origin: "https://panel.example" });
  });

  it("n'ajoute aucun argument au constructeur sans origine (navigateur)", async () => {
    await openServerConsole(client(), "s1", () => {}, {
      WebSocketImpl: FausseSocket as unknown as typeof WebSocket,
    });
    expect(FausseSocket.derniere?.options).toBeUndefined();
  });

  it("s'authentifie, réclame l'historique et signale la fermeture", async () => {
    const recus: ConsoleEvent[] = [];
    const console = await openServerConsole(client(), "s1", (event) => recus.push(event), {
      WebSocketImpl: FausseSocket as unknown as typeof WebSocket,
    });
    const socket = FausseSocket.derniere as FausseSocket;

    socket.emettre("open");
    socket.emettre("message", JSON.stringify({ event: "auth success" }));
    socket.emettre("message", JSON.stringify({ event: "console output", args: ["Bonjour"] }));
    console.close();

    expect(socket.envoyes.map((envoi) => JSON.parse(envoi).event)).toEqual(["auth", "send logs"]);
    expect(recus).toEqual([
      { kind: "output", text: "Bonjour" },
      { kind: "closed", text: "" },
    ]);
  });
});
