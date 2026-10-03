import { GameDashboardClient, openServerConsole } from "@gamedashboard/sdk";
import { describe, expect, it } from "vitest";
import { ADRESSE_DEMO, creerApiDemo } from "./api";

const MAINTENANT = Date.parse("2026-10-02T12:00:00Z");

function demo(langue: "fr" | "en" = "fr") {
  const api = creerApiDemo(langue, () => MAINTENANT);
  const appels: string[] = [];
  const client = new GameDashboardClient({
    baseUrl: ADRESSE_DEMO,
    token: "demo",
    fetch: (async (url: RequestInfo | URL, init?: RequestInit) => {
      appels.push(`${init?.method ?? "GET"} ${new URL(String(url)).pathname}`);
      return api.fetch(url, init);
    }) as typeof fetch,
  });
  return { api, client, appels };
}

describe("mode démo : les écrans du client", () => {
  it("répond à chaque lecture du client avec des données plausibles", async () => {
    const { client } = demo();
    const serveurs = await client.servers();
    expect(serveurs.length).toBeGreaterThan(0);
    const id = serveurs[0]?.id ?? "";
    expect((await client.server(id)).name).toBe(serveurs[0]?.name);
    expect((await client.players(id)).online).toBeGreaterThan(0);
    expect((await client.backups(id)).items.length).toBeGreaterThan(0);
    expect((await client.files(id, "/")).some((f) => f.directory)).toBe(true);
    expect(await client.fileContents(id, "/server.properties")).toContain("max-players");
    const cloche = await client.notifications();
    expect(cloche.unread).toBeGreaterThan(0);
    await client.markNotificationsRead();
    expect((await client.notifications()).unread).toBe(0);
  });

  it("fait vivre l'alimentation, les sauvegardes et les fichiers", async () => {
    const { client } = demo();
    const id = "demo-srv-2";
    await client.power(id, "start");
    expect((await client.server(id)).runtimeState).toBe("running");
    const neuve = await client.createBackup(id, "essai");
    await client.lockBackup(id, neuve.id, true);
    await expect(client.deleteBackup(id, neuve.id)).rejects.toThrow();
    await client.lockBackup(id, neuve.id, false);
    await client.restoreBackup(id, neuve.id);
    await client.deleteBackup(id, neuve.id);
    expect((await client.backups(id)).items.map((b) => b.id)).not.toContain(neuve.id);

    await client.createDirectory(id, "/", "mods");
    await client.writeFile(id, "/mods/readme.txt", "bonjour");
    expect(await client.fileContents(id, "/mods/readme.txt")).toBe("bonjour");
    await client.renameFile(id, "/mods", "readme.txt", "lisez-moi.txt");
    expect((await client.files(id, "/mods")).map((f) => f.name)).toEqual(["lisez-moi.txt"]);
    const archive = await client.compressFiles(id, "/", ["mods"]);
    await client.decompressFile(id, "/", archive.name);
    await client.deleteFiles(id, "/", ["mods"]);
    expect((await client.files(id, "/")).map((f) => f.name)).not.toContain("mods");
  });

  it("ouvre une console qui parle comme le daemon, et fait écho aux commandes", async () => {
    const { api, client } = demo();
    const evenements: string[] = [];
    const console = await openServerConsole(
      client,
      "demo-srv-1",
      (evenement) => evenements.push(`${evenement.kind}:${evenement.text}`),
      { WebSocketImpl: api.WebSocket, origin: ADRESSE_DEMO },
    );
    await new Promise((fin) => setTimeout(fin, 5));
    expect(evenements).toContain("status:running");
    expect(evenements.some((e) => e.startsWith("output:"))).toBe(true);
    expect(evenements.some((e) => e.startsWith("stats:"))).toBe(true);
    await console.send("say bonjour");
    expect(evenements).toContain("output:> say bonjour");
    console.close();
    expect(evenements.at(-1)).toBe("closed:");
  });
});

describe("mode démo : revendeur et administration", () => {
  it("montre un compte administrateur, l'espace revendeur et sa consommation", async () => {
    const { client } = demo();
    expect((await client.me()).user.role).toBe("admin");
    const parc = await client.resellerOverview();
    expect(parc.clients.length).toBeGreaterThan(0);
    const jours = await client.resellerConsumption({ from: "2026-10-01", to: "2026-10-02" });
    expect(jours).toHaveLength(2 * parc.servers.length);
  });

  it("une suspension se voit dans chaque espace", async () => {
    const { client } = demo();
    await client.setResellerServerSuspended("demo-srv-1", true);
    expect((await client.server("demo-srv-1")).state).toBe("suspended");
    expect((await client.adminServers()).find((s) => s.id === "demo-srv-1")?.state).toBe(
      "suspended",
    );
    await client.setAdminServerSuspended("demo-srv-1", false);
    expect(
      (await client.resellerOverview()).servers.find((s) => s.id === "demo-srv-1")?.state,
    ).toBeNull();
  });

  it("a de quoi remplir l'aperçu, et chaque geste de l'administration répond", async () => {
    const { client } = demo("en");
    const noeuds = await client.adminNodes();
    expect(noeuds.length).toBeGreaterThan(1);
    expect((await client.adminNodeAgent(noeuds[0]?.id ?? "")).status).toBe("online");
    expect((await client.adminServers()).some((s) => s.state === "install_failed")).toBe(true);
    const comptes = await client.adminUsers();
    const cible = comptes.find((c) => c.role === "user")?.id ?? "";
    await client.setAdminUserSuspended(cible, { suspended: true, reason: "test" });
    expect((await client.adminUsers()).find((c) => c.id === cible)?.suspendedAt).not.toBeNull();
    expect(await client.revokeAdminUserSessions(cible)).toEqual({ revoked: 2 });

    const [ouvert] = await client.adminIncidents();
    expect(ouvert?.title).toMatch(/Slowness/);
    const neuf = await client.openIncident({ title: "Test", impact: "major", body: "Test" });
    const clos = await client.postIncidentUpdate(neuf.id, { state: "resolved", body: "Done" });
    expect(clos.resolvedAt).not.toBeNull();
    await expect(
      client.postIncidentUpdate(neuf.id, { state: "monitoring", body: "x" }),
    ).rejects.toThrow();

    const avant = await client.panelUpdate();
    expect(avant.actif && avant.derniereRelease !== avant.enService).toBe(true);
    const apres = await client.checkPanelUpdate();
    expect(apres.actif && apres.enService).toBe(avant.actif ? avant.derniereRelease : null);

    const page1 = await client.adminActivity({ page: 1 });
    expect(page1.items).toHaveLength(10);
    expect(page1.hasMore).toBe(true);
    expect(
      (await client.adminActivity({ query: "backup" })).items.every((l) =>
        l.event.includes("backup"),
      ),
    ).toBe(true);
  });

  it("refuse ce que la démo ne sait pas faire, sans rien envoyer ailleurs", async () => {
    const { client, appels } = demo();
    await expect(client.fileDownloadUrl("demo-srv-1", "/server.properties")).rejects.toThrow(
      /démonstration/,
    );
    expect(appels.every((appel) => appel.split(" ")[1]?.startsWith("/api/"))).toBe(true);
  });
});
