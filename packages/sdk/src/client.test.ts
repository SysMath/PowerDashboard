import {
  APP_PRESENCE_HEADER,
  APP_PRESENCE_ROUTES,
  APPLICATION_ROUTES,
  type ApiRoute,
  BACKUP_RESTORE_TIMEOUT_MS,
  BACKUP_SAFETY_WAIT_MS,
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

  it("retire les barres finales en temps linéaire", () => {
    // `replace(/\/+$/, "")` repartait de chaque barre : quadratique (CodeQL).
    const debut = performance.now();
    client(
      espion(() => fausseReponse({ data: [] })),
      `https://p${"/".repeat(100_000)}x`,
    );
    expect(performance.now() - debut).toBeLessThan(200);
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

  it("demande le jeton du moment à chaque appel quand on lui donne une fonction", async () => {
    // Le jeton d'un appareil mobile change toutes les quinze minutes : le
    // client ne doit jamais garder celui de sa construction.
    const jetons = ["gd_mob_un", "gd_mob_deux"];
    const appel = espion(() => fausseReponse({ data: [] }));
    const c = new GameDashboardClient({
      baseUrl: "https://panel.example",
      token: async () => jetons.shift() ?? "",
      fetch: appel,
    });
    await c.servers();
    await c.servers();
    expect(entetes(appel, 0).Authorization).toBe("Bearer gd_mob_un");
    expect(entetes(appel, 1).Authorization).toBe("Bearer gd_mob_deux");
  });

  it("rejoue un 401 une seule fois, après un renouvellement réussi", async () => {
    let jeton = "gd_mob_perime";
    const appel = espion((_url, init) =>
      (init?.headers as Record<string, string> | undefined)?.Authorization === "Bearer gd_mob_frais"
        ? fausseReponse({ data: [] })
        : fausseReponse({ title: "Session expirée" }, 401),
    );
    const renouveler = vi.fn(async () => {
      jeton = "gd_mob_frais";
      return true;
    });
    const c = new GameDashboardClient({
      baseUrl: "https://panel.example",
      token: async () => jeton,
      onUnauthorized: renouveler,
      fetch: appel,
    });

    await expect(c.servers()).resolves.toEqual([]);
    expect(renouveler).toHaveBeenCalledTimes(1);
    expect(appel).toHaveBeenCalledTimes(2);
  });

  it("laisse remonter le 401 quand le renouvellement échoue, sans boucler", async () => {
    const appel = espion(() => fausseReponse({ title: "Session expirée" }, 401));
    const renouveler = vi.fn(async () => false);
    const c = new GameDashboardClient({
      baseUrl: "https://panel.example",
      token: async () => "gd_mob_perime",
      onUnauthorized: renouveler,
      fetch: appel,
    });

    const echec = await c.servers().catch((error: unknown) => error);
    expect((echec as ApiProblem).status).toBe(401);
    expect(renouveler).toHaveBeenCalledTimes(1);
    expect(appel).toHaveBeenCalledTimes(1);
  });

  it("lit la cloche avec son nombre de non lues", async () => {
    const appel = espion(() =>
      fausseReponse({ data: [{ id: "n1", title: "Survie : hors ligne" }], meta: { unread: 3 } }),
    );
    await expect(client(appel).notifications()).resolves.toEqual({
      items: [{ id: "n1", title: "Survie : hors ligne" }],
      unread: 3,
    });
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
    await c.notifications();
    await c.markNotificationsRead();
    await c.playerAction(id, { action: "kick", player: "Steve" });
    const nom = "gd-20260930T120000.000Z";
    await c.snapshots(id);
    await c.takeSnapshot(id);
    await c.pinSnapshot(id, nom, "avant la mise à jour");
    await c.unpinSnapshot(id, nom);
    await c.restoreSnapshot(id, nom);
    const sauvegarde = "7f3a9c2e";
    await c.backups(id);
    await c.createBackup(id, "avant-mise-a-jour");
    await c.lockBackup(id, sauvegarde, true);
    await c.restoreBackup(id, sauvegarde, true);
    await c.deleteBackup(id, sauvegarde);
    await c.files(id, "/plugins");
    await c.fileContents(id, "/server.properties");
    await c.writeFile(id, "/server.properties", "motd=Bonjour");
    await c.createDirectory(id, "/", "mondes");
    await c.renameFile(id, "/", "a.txt", "b.txt");
    await c.deleteFiles(id, "/", ["b.txt"]);
    await c.compressFiles(id, "/", ["world"]);
    await c.decompressFile(id, "/", "world.tar.gz");
    await c.fileDownloadUrl(id, "/latest.log");
    await c.uploadGrant(id);
    await c.createServer({});
    await c.suspendServer(id, "impayé");
    await c.unsuspendServer(id);
    await c.resizeServer(id, { memoryMb: 4096 });
    await c.setServerOwner(id, "0b0c1a4e-3c57-4c2e-9d36-3f1f5e9f0a11");
    await c.terminateServer(id);
    await c.ssoLink({ externalId: "client-42" });
    await c.consumption({ from: "2026-09-01", to: "2026-09-30" });
    await c.me();
    await c.resellerOverview();
    await c.setResellerServerSuspended(id, true, "impayé");
    await c.resellerConsumption({ from: "2026-09-01" });
    await c.openapi();

    const visees = appel.mock.calls.map(
      ([url, init]) =>
        `${init?.method ?? "GET"} ${forme(new URL(String(url)).pathname.replace(id, "{x}").replace(nom, "{x}").replace("7f3a9c2e", "{x}"))}`,
    );
    expect(visees.filter((route) => !connues.has(route))).toEqual([]);
  });

  /*
   * Un appareil mobile ne restaure ni ne supprime sans confirmer sa présence
   * (ADR 0010) : le SDK demande l'en-tête pour exactement les routes que le
   * panel protège, avec le chemin sans la requête, et pour aucune autre.
   */
  it("joint la confirmation de présence aux seuls gestes que le panel protège", async () => {
    const appel = espion(() => fausseReponse({ data: { content: "", url: "u" } }));
    const presence = vi.fn(async (method: string, path: string) => ({
      [APP_PRESENCE_HEADER]: `defi.${method} ${path}`,
    }));
    const c = new GameDashboardClient({
      baseUrl: "https://panel.example",
      token: "gd_mob_essai",
      fetch: appel,
      presence,
    });
    const [id, sauvegarde, nom] = ["31201e0c", "7f3a9c2e", "gd-20260930T120000.000Z"];
    await c.backups(id);
    await c.restoreBackup(id, sauvegarde, true);
    await c.deleteBackup(id, sauvegarde);
    await c.lockBackup(id, sauvegarde, false);
    await c.files(id, "/");
    await c.deleteFiles(id, "/", ["a"]);
    await c.renameFile(id, "/", "a", "b");
    await c.restoreSnapshot(id, nom);

    const protegees = new Set(
      APP_PRESENCE_ROUTES.map((r) => `${r.method} ${r.path.replace(/:\w+/g, ":x")}`),
    );
    appel.mock.calls.forEach(([url, init], n) => {
      const chemin = new URL(String(url)).pathname;
      const gabarit = `${init?.method ?? "GET"} ${chemin.replace(id, ":x").replace(sauvegarde, ":x").replace(nom, ":x")}`;
      const entete = entetes(appel, n)[APP_PRESENCE_HEADER];
      if (protegees.has(gabarit)) expect(entete, gabarit).toBe(`defi.${init?.method} ${chemin}`);
      else expect(entete, gabarit).toBeUndefined();
    });
    expect(presence).toHaveBeenCalledTimes(4);
  });

  it("suspend un serveur du revendeur en présence, et lit son parc sans", async () => {
    const appel = espion(() => fausseReponse({ data: {} }));
    const presence = vi.fn(async (method: string, path: string) => ({
      [APP_PRESENCE_HEADER]: `defi.${method} ${path}`,
    }));
    const c = new GameDashboardClient({
      baseUrl: "https://panel.example",
      token: "gd_mob_essai",
      fetch: appel,
      presence,
    });
    await c.resellerOverview();
    await c.setResellerServerSuspended("31201e0c", false);
    expect(entetes(appel, 0)[APP_PRESENCE_HEADER]).toBeUndefined();
    expect(entetes(appel, 1)[APP_PRESENCE_HEADER]).toBe(
      "defi.POST /api/v1/reseller/servers/31201e0c/suspension",
    );
    expect(JSON.parse(String(initDe(appel, 1).body))).toEqual({ suspended: false });
  });

  it("lit la consommation du revendeur ligne à ligne, sans échouer sur une ligne", async () => {
    const jsonl = `${JSON.stringify({ day: "2026-09-01", serverId: "s1" })}\nnon json\n${JSON.stringify({ day: "2026-09-02", serverId: "s1" })}\n`;
    const appel = espion(
      () => new Response(jsonl, { headers: { "content-type": "application/x-ndjson" } }),
    );
    const jours = await client(appel).resellerConsumption({ from: "2026-09-01", to: "2026-09-30" });
    expect(jours).toEqual([
      { day: "2026-09-01", serverId: "s1" },
      { day: "2026-09-02", serverId: "s1" },
    ]);
    const url = new URL(String(appel.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/api/v1/reseller/consumption/export");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      format: "jsonl",
      from: "2026-09-01",
      to: "2026-09-30",
    });
  });

  /*
   * Le panel résout le jeton avant de consommer le défi : la reprise après
   * un 401 renvoie le même en-tête, sans redemander la biométrie.
   */
  it("garde la même confirmation de présence pour la reprise après un 401", async () => {
    let jeton = "gd_mob_perime";
    const appel = espion((_url, init) =>
      (init?.headers as Record<string, string> | undefined)?.Authorization === "Bearer gd_mob_frais"
        ? fausseReponse({ data: {} })
        : fausseReponse({ title: "Session expirée" }, 401),
    );
    const presence = vi.fn(async () => ({ [APP_PRESENCE_HEADER]: "defi.signature" }));
    const c = new GameDashboardClient({
      baseUrl: "https://panel.example",
      token: async () => jeton,
      onUnauthorized: async () => {
        jeton = "gd_mob_frais";
        return true;
      },
      fetch: appel,
      presence,
    });

    await c.deleteBackup("31201e0c", "7f3a9c2e");
    expect(appel).toHaveBeenCalledTimes(2);
    expect(presence).toHaveBeenCalledTimes(1);
    expect(entetes(appel, 1)[APP_PRESENCE_HEADER]).toBe("defi.signature");
  });

  /*
   * Le panel attend l'instantané de sûreté de l'agent avant de restaurer.
   * Avec le délai ordinaire, le client abandonnait et disait « délai
   * dépassé » à une restauration qui partait pourtant.
   */
  it("attend une restauration au-delà du délai ordinaire, et elle seule", async () => {
    vi.useFakeTimers();
    try {
      const lente = (_url: string, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const fin = setTimeout(() => resolve(fausseReponse({ data: {} })), BACKUP_SAFETY_WAIT_MS);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(fin);
            reject(new DOMException("interrompu", "AbortError"));
          });
        });
      const c = new GameDashboardClient({
        baseUrl: "https://panel.example",
        token: "gd_mob_essai",
        fetch: vi.fn(lente) as unknown as typeof fetch,
      });

      const restauration = c.restoreBackup("31201e0c", "7f3a9c2e");
      const suppression = c.deleteBackup("31201e0c", "7f3a9c2e");
      const issues = Promise.allSettled([restauration, suppression]);
      await vi.advanceTimersByTimeAsync(BACKUP_SAFETY_WAIT_MS);
      const [restauree, supprimee] = await issues;

      expect(restauree.status).toBe("fulfilled");
      expect(supprimee.status).toBe("rejected");
      expect(BACKUP_RESTORE_TIMEOUT_MS).toBeGreaterThan(BACKUP_SAFETY_WAIT_MS);
    } finally {
      vi.useRealTimers();
    }
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

  it("enchaîne les pages de consommation tant que l'API en annonce d'autres", async () => {
    // `meta.hasMore` décide, pas la longueur de la page : une page pleine peut
    // être la dernière, et une page courte ne doit jamais arrêter la lecture
    // si l'API dit qu'il en reste. Sans enchaînement, un facturier ne lirait
    // que les mille premières journées d'un parc.
    const appel = espion((url) => {
      const page = new URL(url).searchParams.get("page");
      return fausseReponse({
        data: page === "1" ? [{ i: 1 }, { i: 2 }] : [{ i: 3 }],
        meta: { page: Number(page), hasMore: page === "1" },
      });
    });

    const lues: unknown[] = [];
    for await (const jour of client(appel).consumptionDays({ from: "2026-09-01" })) {
      lues.push(jour);
    }

    expect(lues).toEqual([{ i: 1 }, { i: 2 }, { i: 3 }]);
    expect(appel.mock.calls.map(([url]) => new URL(String(url)).search)).toEqual([
      "?from=2026-09-01&page=1",
      "?from=2026-09-01&page=2",
    ]);
  });
});

/** `{server}` et un identifiant réel reviennent au même segment. */
function forme(chemin: string): string {
  return chemin.replace(/\{[a-zA-Z]+\}/g, "{x}");
}
