import {
  APPLICATION_ROUTES,
  type ApiRoute,
  CLIENT_ROUTES,
  SESSION_ROUTES,
} from "@gamedashboard/contracts";
import { describe, expect, it, vi } from "vitest";
import { ApiProblem, GameDashboardClient } from "./client";

/**
 * Ce que le client promet, et qu'un `fetch` nu ne donne pas.
 *
 * Trois choses, et ce sont les trois qui coûtent cher quand elles manquent :
 * un refus lisible, une adresse correctement composée, et un en-tête de type
 * posé **seulement** quand il y a un corps.
 */
function fausseReponse(corps: unknown, status = 200): Response {
  return new Response(corps === undefined ? "" : JSON.stringify(corps), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Un faux `fetch` **typé comme `fetch`**.
 *
 * `vi.fn(async () => …)` infère une fonction sans paramètre : ses `calls` sont
 * alors des tuples vides, et lire `calls[0][1]` ne compile pas. Déclarer la
 * signature rend les appels inspectables — c'est précisément ce qu'on veut
 * vérifier ici.
 */
function espion(reponse: (url: string, init?: RequestInit) => Response) {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => reponse(String(url), init));
}

/** L'initialisation du n-ième appel, telle que le client l'a composée. */
function initDe(appel: ReturnType<typeof espion>, n: number): RequestInit {
  const init = appel.mock.calls[n]?.[1];
  if (!init) throw new Error(`Aucun appel numéro .`);
  return init;
}

function entetes(appel: ReturnType<typeof espion>, n: number): Record<string, string> {
  return (initDe(appel, n).headers ?? {}) as Record<string, string>;
}

function client(fetchImpl: typeof globalThis.fetch, baseUrl = "https://panel.example") {
  return new GameDashboardClient({ baseUrl, token: "gd_live_essai", fetch: fetchImpl });
}

describe("GameDashboardClient", () => {
  it("déballe l'enveloppe `data` de l'API", async () => {
    // L'enveloppe est une convention de transport : l'appelant demande un
    // serveur, il doit recevoir un serveur, pas un objet qui en contient un.
    const appel = espion(() => fausseReponse({ data: { id: "31201e0c" } }));
    await expect(client(appel).server("31201e0c")).resolves.toEqual({ id: "31201e0c" });
  });

  it("compose l'adresse sans double barre", async () => {
    /*
     * Une base finissant par `/` donnait `//api/v1/...`. Certains serveurs
     * réécrivent, d'autres répondent 404 : un défaut qui ne se manifeste que
     * chez la moitié des intégrateurs est un défaut qu'on ne reproduit jamais.
     */
    const appel = espion(() => fausseReponse({ data: [] }));
    await client(appel, "https://panel.example///").servers();
    expect(String(appel.mock.calls[0]?.[0])).toBe("https://panel.example/api/v1/client/servers");
  });

  it("n'annonce un type de contenu que lorsqu'il y a un corps", async () => {
    /*
     * **Le piège qui coûte le plus de temps.** Fastify refuse par un 400
     * « Body cannot be empty » une requête qui s'annonce en JSON et n'envoie
     * rien. Le refus ressemble à une demande invalide, et l'on cherche du côté
     * des paramètres pendant que le problème est un en-tête de trop.
     */
    const appel = espion(() => fausseReponse({ data: {} }));
    const c = client(appel);

    await c.terminateServer("31201e0c");
    expect(entetes(appel, 0)["Content-Type"]).toBeUndefined();

    await c.command("31201e0c", "say bonjour");
    expect(entetes(appel, 1)["Content-Type"]).toBe("application/json");
  });

  it("traduit un refus en ApiProblem lisible", async () => {
    const appel = espion(() =>
      fausseReponse(
        { title: "Portée insuffisante", status: 403, detail: "La clé ne porte pas « power.* »." },
        403,
      ),
    );

    const echec = await client(appel)
      .power("31201e0c", "restart")
      .catch((error: unknown) => error);

    expect(echec).toBeInstanceOf(ApiProblem);
    const probleme = echec as ApiProblem;
    expect(probleme.status).toBe(403);
    expect(probleme.title).toBe("Portée insuffisante");
    // Le message joint les deux : le code dit s'il faut réessayer, le détail
    // dit quoi changer. Perdre l'un des deux oblige à deviner.
    expect(probleme.message).toContain("power.*");
  });

  it("ne s'étrangle pas sur un corps qui n'est pas de l'API", async () => {
    /*
     * Une page d'erreur de serveur web, un portail captif, un proxy mal réglé :
     * le corps n'est alors pas du JSON. Échouer sur « JSON invalide »
     * accuserait l'API de ce qu'un intermédiaire a fait.
     */
    const appel = espion(() => new Response("<html>502 Bad Gateway</html>", { status: 502 }));

    const echec = await client(appel)
      .servers()
      .catch((error: unknown) => error);

    expect(echec).toBeInstanceOf(ApiProblem);
    expect((echec as ApiProblem).status).toBe(502);
  });

  it("présente la clé en porteur sur chaque appel", async () => {
    // L'oubli de cet en-tête est la cause du 401 qu'on cherche longtemps :
    // posé une fois à la construction, il ne peut plus manquer.
    const appel = espion(() => fausseReponse({ data: [] }));
    await client(appel).servers();
    expect(entetes(appel, 0).Authorization).toBe("Bearer gd_live_essai");
  });

  /*
   * Non-régression : `suspendServer` et `unsuspendServer` appelaient
   * `…/suspend` et `…/unsuspend`, deux routes que l'API applicative n'a jamais
   * servies — la seule est `…/suspension`. Chaque appel rendait 404, et le
   * défaut ne se voyait que chez l'intégrateur. Chaque méthode du SDK doit
   * donc viser une route du catalogue, celui-là même que publie openapi.json.
   */
  it("n'appelle que des routes du catalogue", async () => {
    const catalogue: [string, ApiRoute[]][] = [
      ["/api/v1/client", CLIENT_ROUTES],
      ["/api/v1", SESSION_ROUTES],
      ["/api/v1/application", APPLICATION_ROUTES],
    ];
    const connues = new Set(
      catalogue.flatMap(([prefixe, routes]) =>
        routes.map((r) => `${r.method} ${forme(`${prefixe}${r.path.split("?")[0]}`)}`),
      ),
    );
    // Servie hors catalogue, par le générateur lui-même.
    connues.add("GET /api/v1/openapi.json");

    const appel = espion(() => fausseReponse({ data: {} }));
    const c = client(appel);
    const id = "31201e0c";
    await c.servers();
    await c.server(id);
    await c.resources(id);
    await c.power(id, "start");
    await c.websocketGrant(id);
    await c.command(id, "say bonjour");
    await c.players(id);
    await c.playerAction(id, { action: "kick", player: "Steve" });
    await c.createServer({});
    await c.suspendServer(id, "impayé");
    await c.unsuspendServer(id);
    await c.resizeServer(id, { memoryMb: 4096 });
    await c.setServerOwner(id, "0b0c1a4e-3c57-4c2e-9d36-3f1f5e9f0a11");
    await c.terminateServer(id);
    await c.ssoLink({ externalId: "client-42" });
    await c.openapi();

    const visees = appel.mock.calls.map(
      ([url, init]) =>
        `${init?.method ?? "GET"} ${forme(new URL(String(url)).pathname.replace(id, "{x}"))}`,
    );
    expect(visees.filter((route) => !connues.has(route))).toEqual([]);
  });

  it("suspend et rétablit par la même route, avec un booléen", async () => {
    const appel = espion(() => fausseReponse({ data: {} }));
    const c = client(appel);

    await c.suspendServer("31201e0c", "impayé");
    await c.unsuspendServer("31201e0c");

    expect(JSON.parse(String(initDe(appel, 0).body))).toEqual({
      suspended: true,
      reason: "impayé",
    });
    expect(JSON.parse(String(initDe(appel, 1).body))).toEqual({ suspended: false });
  });
});

/** `{server}` et un identifiant réel reviennent au même segment. */
function forme(chemin: string): string {
  return chemin.replace(/\{[a-zA-Z]+\}/g, "{x}");
}
