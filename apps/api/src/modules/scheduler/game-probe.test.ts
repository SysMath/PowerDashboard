import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ping, probeHost } from "./game-probe.service";
import { encodeVarInt, STATUS_FRAME_MAX_BYTES } from "./minecraft-ping";

/**
 * La sonde est éprouvée contre un vrai serveur TCP, et non contre un faux
 * client.
 *
 * Tout ce que cette sonde peut rater se joue sur la socket : une trame envoyée
 * dans le désordre, une réponse arrivée en deux morceaux, un port qui refuse la
 * connexion. Simuler la socket vérifierait que le code s'appelle lui-même
 * correctement, pas qu'il parle le protocole.
 */

/** Réponse d'état, telle qu'un serveur la renvoie : longueur, 0x00, JSON. */
function statusFrame(body: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(body), "utf8");
  const payload = Buffer.concat([encodeVarInt(0x00), encodeVarInt(json.length), json]);
  return Buffer.concat([encodeVarInt(payload.length), payload]);
}

const servers: Server[] = [];

/** Serveur d'essai, qui répond ce qu'on lui dit et se ferme après le test. */
async function listen(onConnect: (write: (chunk: Buffer) => void) => void): Promise<number> {
  const server = createServer((socket) => {
    // On attend la demande du client avant de répondre : un serveur qui parle
    // le premier ne testerait pas l'ordre des trames.
    socket.once("data", () => onConnect((chunk) => socket.write(chunk)));
  });
  servers.push(server);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("port introuvable");
  return address.port;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((r) => server.close(r))));
});

describe("sonde de jeu", () => {
  it("lit l'état d'un serveur qui répond", async () => {
    const port = await listen((write) => {
      write(statusFrame({ players: { online: 3, max: 20 }, version: { name: "Paper 1.21.11" } }));
    });

    expect(await ping("127.0.0.1", port)).toEqual({
      playersOnline: 3,
      playersMax: 20,
      version: "Paper 1.21.11",
      sample: null,
    });
  });

  it("attend la suite quand la réponse arrive en plusieurs morceaux", async () => {
    /*
     * Le cas normal, et non le cas limite : la réponse d'un serveur peuplé
     * dépasse allègrement un paquet TCP. Conclure sur le premier morceau
     * donnerait « injoignable » pour un serveur qui répondait parfaitement.
     */
    const frame = statusFrame({ players: { online: 0, max: 100 }, version: { name: "1.20.4" } });
    const port = await listen((write) => {
      write(frame.subarray(0, 4));
      setTimeout(() => write(frame.subarray(4)), 20);
    });

    expect(await ping("127.0.0.1", port)).toEqual({
      playersOnline: 0,
      playersMax: 100,
      version: "1.20.4",
      sample: null,
    });
  });

  it("abandonne une réponse plus grosse que ce que le protocole permet", async () => {
    // Longueur annoncée démesurée, puis un flot d'octets : sans plafond, tout
    // s'accumulait en mémoire jusqu'au délai de la sonde.
    const port = await listen((write) => {
      write(encodeVarInt(0x7fff_ffff));
      write(Buffer.alloc(STATUS_FRAME_MAX_BYTES + 1024, 0x30));
    });

    const debut = Date.now();
    expect(await ping("127.0.0.1", port)).toBe(null);
    expect(Date.now() - debut).toBeLessThan(2_000);
  });

  it("abandonne à l'échéance un serveur qui répond au compte-gouttes", async () => {
    // Un octet toutes les 50 ms : l'inactivité ne dépasse jamais le délai, et
    // seule une échéance fixe met fin à la sonde.
    const server = createServer((socket) => {
      socket.on("error", () => undefined);
      socket.once("data", () => {
        socket.write(encodeVarInt(1_000));
        const goutte = setInterval(() => socket.write("0"), 50);
        socket.on("close", () => clearInterval(goutte));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("port introuvable");
    const port = address.port;

    const debut = Date.now();
    expect(await ping("127.0.0.1", port, 300)).toBe(null);
    expect(Date.now() - debut).toBeLessThan(1_000);
  });

  it("borne la version annoncée", async () => {
    const port = await listen((write) => {
      write(statusFrame({ players: { online: 1, max: 2 }, version: { name: "0".repeat(50_000) } }));
    });

    const etat = await ping("127.0.0.1", port);
    expect(etat?.version).toBe("0".repeat(128));
  });

  it("rend null sur un port fermé", async () => {
    // Un port sur lequel personne n'écoute : la connexion est refusée tout de
    // suite, et la sonde doit en sortir sans attendre son délai.
    expect(await ping("127.0.0.1", 1)).toBe(null);
  });

  it("rend null face à un service qui n'est pas un serveur Minecraft", async () => {
    // Un serveur HTTP sur le port du jeu, par exemple : il répond, donc le port
    // est ouvert — et pourtant aucun joueur n'entrera.
    const port = await listen((write) => write(Buffer.from("HTTP/1.1 200 OK\r\n\r\n", "utf8")));

    expect(await ping("127.0.0.1", port)).toBe(null);
  });

  it("rend null quand le serveur raccroche sans répondre", async () => {
    // Un serveur figé accepte la connexion puis ne dit rien. Sans la fermeture,
    // on attendrait le délai complet ; avec, on conclut tout de suite.
    const port = await listen(() => undefined);
    const closed = servers.at(-1);
    closed?.on("connection", (socket) => setTimeout(() => socket.destroy(), 10));

    expect(await ping("127.0.0.1", port)).toBe(null);
  });
});

describe("adresse sondée", () => {
  it("préfère l'alias, qui est l'adresse des joueurs", () => {
    expect(
      probeHost({ ip: "10.0.0.4", ipAlias: "play.exemple.fr", fqdn: "node1.exemple.fr" }),
    ).toBe("play.exemple.fr");
  });

  it("retombe sur le node quand l'allocation écoute sur toutes les interfaces", () => {
    /*
     * `0.0.0.0` dit au conteneur d'écouter partout ; ce n'est pas une adresse
     * à laquelle se connecter. S'y connecter viserait la machine du panel, qui
     * répondrait « refusé » et ferait déclarer en panne un serveur sain.
     */
    expect(probeHost({ ip: "0.0.0.0", ipAlias: null, fqdn: "node1.exemple.fr" })).toBe(
      "node1.exemple.fr",
    );
    expect(probeHost({ ip: "::", ipAlias: null, fqdn: "node1.exemple.fr" })).toBe(
      "node1.exemple.fr",
    );
  });

  it("emploie l'adresse de l'allocation quand elle en est une", () => {
    expect(probeHost({ ip: "203.0.113.7", ipAlias: null, fqdn: "node1.exemple.fr" })).toBe(
      "203.0.113.7",
    );
  });
});
