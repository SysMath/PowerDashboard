import {
  activityLogs,
  type Database,
  databaseHosts,
  databases,
  serverInvites,
  serverSubusers,
  servers,
  webhookDeliveries,
  webhooks,
} from "@gamedashboard/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { seedLocation, seedNode, seedServer, seedUser } from "../../test/fixtures";
import {
  createThrowawayDatabase,
  HAS_DATABASE,
  type ThrowawayDatabase,
} from "../../test/throwaway-database";
import { ActivityService } from "../activity/activity.service";
import type { DatabasesService } from "../client/databases.service";
import { ClientWebhookEmitterService } from "../webhooks/client-webhook-emitter.service";
import type { WingsClientService } from "../wings/wings-client.service";
import { WingsTokenService } from "../wings/wings-token.service";
import { AdminController } from "./admin.controller";
import { AdminServerService } from "./admin-server.service";

/**
 * Changer le propriétaire d'un serveur ferme les consoles de l'ancien.
 *
 * Un jeton de console vit dix minutes et Wings ne revérifie pas qui le porte.
 * La suspension et le retrait d'un sous-utilisateur révoquaient déjà ; le
 * changement de propriétaire, non : l'ancien propriétaire gardait la console
 * d'un serveur qui n'était plus le sien. Le registre des jetons est le vrai ;
 * seul le daemon est une doublure.
 */
describe.skipIf(!HAS_DATABASE)("AdminServerService.setOwner (intégration)", () => {
  let throwaway: ThrowawayDatabase;
  let db: Database;
  let serverId: string;
  let ancien: string;
  let invite: string;
  let nouveau: string;

  const wings = {
    denyWebsocketTokens: vi.fn(async () => undefined),
    deauthorizeUser: vi.fn(async (_serverId: string, _userId: string): Promise<void> => undefined),
  };
  const bases = {
    rotatePassword: vi.fn(async (_serverId: string, _databaseId: string) => "nouveau"),
  };
  let tokens: WingsTokenService;
  let activite: ActivityService;
  let service: AdminServerService;

  /** L'administration, par l'écran. */
  const par = {
    event: "admin.server_owner_changed",
    actorId: null,
    actorType: "user",
    actorLabel: "admin@gamedashboard.test",
    ip: "203.0.113.9",
  } as const;

  /** Inscrit un jeton vivant, comme `websocketGrant` l'aurait fait. */
  function jeton(jti: string, userId: string): void {
    (
      tokens as unknown as {
        issued: { jti: string; serverId: string; userId: string; expiresAt: number }[];
      }
    ).issued.push({ jti, serverId, userId, expiresAt: Math.floor(Date.now() / 1000) + 600 });
  }

  beforeAll(async () => {
    throwaway = await createThrowawayDatabase();
    db = throwaway.db;
  }, 60_000);

  afterAll(async () => {
    await throwaway?.drop();
  });

  beforeEach(async () => {
    await db.execute(
      sql.raw(
        `truncate table activity_logs, webhooks, databases, database_hosts, servers, allocations, eggs, nests, nodes, locations, users cascade`,
      ),
    );
    vi.clearAllMocks();
    bases.rotatePassword.mockReset();
    bases.rotatePassword.mockResolvedValue("nouveau");
    wings.deauthorizeUser.mockReset();
    wings.deauthorizeUser.mockResolvedValue(undefined);

    wings.denyWebsocketTokens.mockReset();
    wings.denyWebsocketTokens.mockResolvedValue(undefined);

    tokens = new WingsTokenService(db);
    activite = new ActivityService(db);
    service = new AdminServerService(
      db,
      wings as unknown as WingsClientService,
      tokens,
      bases as unknown as DatabasesService,
      activite,
    );

    ancien = await seedUser(db);
    invite = await seedUser(db);
    nouveau = await seedUser(db);
    const nodeId = await seedNode(db, { locationId: await seedLocation(db) });
    serverId = await seedServer(db, { nodeId, ownerId: ancien });
  });

  it("révoque les jetons de console de l'ancien propriétaire", async () => {
    jeton("console-ancien", ancien);
    await service.setOwner(serverId, nouveau, par);

    expect(wings.denyWebsocketTokens).toHaveBeenCalledWith(serverId, ["console-ancien"]);
    const [row] = await db
      .select({ ownerId: servers.ownerId })
      .from(servers)
      .where(eq(servers.id, serverId));
    expect(row?.ownerId).toBe(nouveau);
  });

  /** Une base MySQL du serveur, sur un hôte déclaré. */
  async function base(nom: string): Promise<string> {
    const [hote] = await db
      .insert(databaseHosts)
      .values({ name: `hôte ${nom}`, host: "127.0.0.1", username: "racine", passwordEnc: "x" })
      .returning({ id: databaseHosts.id });
    const [row] = await db
      .insert(databases)
      .values({
        serverId,
        databaseHostId: hote?.id ?? "",
        name: nom,
        username: `u_${nom}`,
        passwordEnc: "x",
      })
      .returning({ id: databases.id });
    return row?.id ?? "";
  }

  it("retire les sous-utilisateurs et ferme leurs consoles : l'ancien titulaire ne garde pas la main par un invité", async () => {
    await db.insert(serverSubusers).values({ serverId, userId: invite });
    jeton("console-ancien", ancien);
    jeton("console-invite", invite);

    const bilan = await service.setOwner(serverId, nouveau, par);

    expect(bilan.subusersRemoved).toBe(1);
    expect(
      await db.select().from(serverSubusers).where(eq(serverSubusers.serverId, serverId)),
    ).toEqual([]);
    expect(wings.denyWebsocketTokens).toHaveBeenCalledWith(serverId, [
      "console-ancien",
      "console-invite",
    ]);
  });

  it("coupe chez Wings les sessions SFTP et consoles de l'ancien titulaire et de ses invités, pas celles du nouveau", async () => {
    await db.insert(serverSubusers).values({ serverId, userId: invite });

    const bilan = await service.setOwner(serverId, nouveau, par);

    expect(wings.deauthorizeUser.mock.calls).toEqual([
      [serverId, ancien],
      [serverId, invite],
    ]);
    expect(bilan.sessionsNotClosed).toEqual([]);
  });

  it("un node qui ne confirme pas la déconnexion n'annule pas le transfert, et le bilan le dit", async () => {
    await db.insert(serverSubusers).values({ serverId, userId: invite });
    wings.deauthorizeUser.mockImplementation(async (_s: string, userId: string) => {
      if (userId === invite) throw new Error("node injoignable");
    });

    const bilan = await service.setOwner(serverId, nouveau, par);

    expect(bilan).toMatchObject({ changed: true, sessionsNotClosed: [invite] });
    const [row] = await db
      .select({ ownerId: servers.ownerId })
      .from(servers)
      .where(eq(servers.id, serverId));
    expect(row?.ownerId).toBe(nouveau);
  });

  it("retire les invitations en attente", async () => {
    await db.insert(serverInvites).values({
      serverId,
      email: "ami@exemple.fr",
      tokenHash: "empreinte",
      invitedBy: ancien,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });

    const bilan = await service.setOwner(serverId, nouveau, par);

    expect(bilan.invitesRemoved).toBe(1);
    expect(
      await db.select().from(serverInvites).where(eq(serverInvites.serverId, serverId)),
    ).toEqual([]);
  });

  it("supprime les rappels sortants du serveur, et eux seuls", async () => {
    await db.insert(webhooks).values([
      { ownerId: ancien, serverId, url: "https://ancien.exemple.fr/rappel", secretEnc: "x" },
      { ownerId: ancien, serverId: null, url: "https://ancien.exemple.fr/compte", secretEnc: "x" },
    ]);

    const bilan = await service.setOwner(serverId, nouveau, par);

    expect(bilan.webhooksRemoved).toBe(1);
    const restants = await db.select({ serverId: webhooks.serverId }).from(webhooks);
    expect(restants).toEqual([{ serverId: null }]);
  });

  it("les rappels de l'ancien titulaire, du serveur comme de son compte, ne reçoivent plus rien du serveur", async () => {
    const emetteur = new ClientWebhookEmitterService(db);
    const abonnement = { events: ["server.installed"], secretEnc: "x" };
    await db.insert(webhooks).values([
      { ownerId: ancien, serverId, url: "https://ancien.exemple.fr/rappel", ...abonnement },
      { ownerId: ancien, serverId: null, url: "https://ancien.exemple.fr/compte", ...abonnement },
    ]);

    // Témoin : avant le transfert, le rappel du serveur est bien servi.
    await emetteur.emit(serverId, "server.installed");
    expect(await db.select().from(webhookDeliveries)).toHaveLength(1);
    await db.delete(webhookDeliveries);

    await service.setOwner(serverId, nouveau, par);
    await emetteur.emit(serverId, "server.installed");

    expect(await db.select().from(webhookDeliveries)).toEqual([]);
  });

  it("renouvelle le mot de passe de chaque base, et dit laquelle a résisté", async () => {
    const survie = await base("survie");
    const creatif = await base("creatif");
    bases.rotatePassword.mockImplementation(async (_s: string, id: string) => {
      if (id === creatif) throw new Error("hôte injoignable");
      return "nouveau";
    });

    const bilan = await service.setOwner(serverId, nouveau, par);

    expect(bases.rotatePassword).toHaveBeenCalledWith(serverId, survie);
    expect(bases.rotatePassword).toHaveBeenCalledWith(serverId, creatif);
    expect(bilan.databasesRotated).toBe(1);
    expect(bilan.databasesNotRotated).toEqual(["creatif"]);
    // Un hôte qui refuse n'annule pas le transfert.
    const [row] = await db
      .select({ ownerId: servers.ownerId })
      .from(servers)
      .where(eq(servers.id, serverId));
    expect(row?.ownerId).toBe(nouveau);
  });

  it("ne touche à rien quand le serveur appartient déjà à ce compte", async () => {
    await db.insert(serverSubusers).values({ serverId, userId: invite });
    await base("survie");

    const bilan = await service.setOwner(serverId, ancien, par);

    expect(bilan.changed).toBe(false);
    expect(
      await db.select().from(serverSubusers).where(eq(serverSubusers.serverId, serverId)),
    ).toHaveLength(1);
    expect(bases.rotatePassword).not.toHaveBeenCalled();
    expect(wings.denyWebsocketTokens).not.toHaveBeenCalled();
    expect(wings.deauthorizeUser).not.toHaveBeenCalled();
  });

  it("l'espace client ne montre du journal que ce qui suit le changement", async () => {
    const ligne = (event: string, at: string) => ({
      event,
      serverId,
      actorId: null,
      actorType: "user" as const,
      actorLabel: "quelqu'un",
      ip: "198.51.100.7",
      properties: {},
      at,
    });
    await db
      .insert(activityLogs)
      .values([
        ligne("server.power.start", "2026-09-01T10:00:00.000Z"),
        ligne("application.server_owner_changed", "2026-09-02T10:00:00.000Z"),
        ligne("server.power.stop", "2026-09-03T10:00:00.000Z"),
      ]);

    const vu = await activite.forServer(serverId);

    expect(vu.items.map((item) => item.event)).toEqual([
      "server.power.stop",
      "application.server_owner_changed",
    ]);
    // L'administration garde tout.
    const plateforme = await activite.forPlatform({ serverId });
    expect(plateforme.items).toHaveLength(3);
  });

  it("un serveur jamais transféré garde tout son journal", async () => {
    await db.insert(activityLogs).values({
      event: "server.power.start",
      serverId,
      actorId: null,
      actorType: "user",
      actorLabel: "quelqu'un",
      ip: null,
      properties: {},
      at: "2020-01-01T00:00:00.000Z",
    });

    expect((await activite.forServer(serverId)).items).toHaveLength(1);
  });

  it("n'échoue pas quand le node ne répond pas : la base fait foi", async () => {
    jeton("console-ancien", ancien);
    wings.denyWebsocketTokens.mockRejectedValueOnce(new Error("node injoignable"));

    await expect(service.setOwner(serverId, nouveau, par)).resolves.toMatchObject({
      changed: true,
    });
  });

  it("refuse un identifiant illisible sans le confier à la base, qui rendait une erreur 500", async () => {
    await expect(service.setOwner(serverId, "nimporte-quoi", par)).rejects.toThrow(
      "Compte destinataire inconnu.",
    );
    await expect(service.setOwner("nimporte-quoi", nouveau, par)).rejects.toThrow(
      "Serveur introuvable.",
    );
  });

  /** Une ligne de l'ancien titulaire, avec son adresse, avant le changement. */
  async function gesteDeLAncien(): Promise<void> {
    await db.insert(activityLogs).values({
      event: "server.command",
      serverId,
      actorId: ancien,
      actorType: "user",
      actorLabel: "ancien@exemple.fr",
      ip: "192.0.2.55",
      properties: {},
      at: new Date(Date.now() - 60_000).toISOString(),
    });
  }

  describe("coupure du journal", () => {
    it("est écrite avec le changement : un journal en panne ensuite ne rend pas l'historique", async () => {
      await gesteDeLAncien();
      // Toute écriture par `record` échoue désormais, et `record` l'avale.
      vi.spyOn(activite as unknown as { insert(): Promise<void> }, "insert").mockRejectedValue(
        new Error("journal saturé"),
      );
      activite.logger.error = vi.fn();

      await service.setOwner(serverId, nouveau, par);

      const vu = await activite.forServer(serverId, { revealIp: true });
      expect(vu.items.map((item) => item.event)).toEqual(["admin.server_owner_changed"]);
      expect(JSON.stringify(vu.items)).not.toContain("192.0.2.55");
    });

    it("est déjà là pendant le nettoyage chez Wings", async () => {
      await gesteDeLAncien();
      let liberer: () => void = () => undefined;
      const barriere = new Promise<void>((resolve) => {
        liberer = resolve;
      });
      wings.deauthorizeUser.mockImplementation(() => barriere);

      const transfert = service.setOwner(serverId, nouveau, par);
      await vi.waitFor(() => expect(wings.deauthorizeUser).toHaveBeenCalled());

      const pendant = await activite.forServer(serverId, { revealIp: true });
      expect(pendant.items.map((item) => item.event)).toEqual(["admin.server_owner_changed"]);
      liberer();
      await transfert;
    });

    it("pas de ligne, pas de changement : le transfert échoue plutôt que de livrer l'historique", async () => {
      await db.insert(serverSubusers).values({ serverId, userId: invite });

      await expect(
        service.setOwner(serverId, nouveau, { ...par, actorType: "inconnu" as never }),
      ).rejects.toThrow();

      const [row] = await db
        .select({ ownerId: servers.ownerId })
        .from(servers)
        .where(eq(servers.id, serverId));
      expect(row?.ownerId).toBe(ancien);
      expect(
        await db.select().from(serverSubusers).where(eq(serverSubusers.serverId, serverId)),
      ).toHaveLength(1);
      expect(wings.deauthorizeUser).not.toHaveBeenCalled();
    });

    it("par chacun des deux chemins", async () => {
      for (const event of [
        "admin.server_owner_changed",
        "application.server_owner_changed",
      ] as const) {
        await gesteDeLAncien();
        const cible = event === "admin.server_owner_changed" ? nouveau : ancien;
        await service.setOwner(serverId, cible, { ...par, event });

        const vu = await activite.forServer(serverId);
        expect(vu.items.map((item) => item.event)).toEqual([event]);
      }
    });

    it("un rejeu ne coupe pas une seconde fois le journal du nouveau titulaire", async () => {
      await service.setOwner(serverId, nouveau, par);
      await db.insert(activityLogs).values({
        event: "server.power",
        serverId,
        actorId: nouveau,
        actorType: "user",
        actorLabel: "nouveau@exemple.fr",
        ip: null,
        properties: {},
        at: new Date(Date.now() + 1_000).toISOString(),
      });

      await service.setOwner(serverId, nouveau, par);

      const vu = await activite.forServer(serverId);
      expect(vu.items.map((item) => item.event)).toEqual([
        "server.power",
        "admin.server_owner_changed",
      ]);
    });
  });

  it("le bilan, qui nomme l'ancien titulaire et ses invités, est réservé à l'administration", async () => {
    await db.insert(serverSubusers).values({ serverId, userId: invite });
    wings.deauthorizeUser.mockImplementation(async (_s: string, userId: string) => {
      if (userId === invite) throw new Error("node injoignable");
    });

    await service.setOwner(serverId, nouveau, par);

    const client = await activite.forServer(serverId, { revealIp: true });
    expect(client.items).toHaveLength(1);
    expect(client.items[0]?.properties).toEqual({ ownerId: nouveau });
    expect(JSON.stringify(client.items)).not.toContain(invite);
    expect(JSON.stringify(client.items)).not.toContain(ancien);

    const administration = await activite.forPlatform({ serverId });
    const bilan = administration.items.find((item) => item.event === "server.owner_change_cleanup");
    expect(bilan?.properties).toMatchObject({
      ownerId: nouveau,
      previousOwnerId: ancien,
      changed: true,
      subusersRemoved: 1,
      sessionsNotClosed: [invite],
    });
  });

  it("rejouer rend le bilan du changement déjà fait, sans rien refaire", async () => {
    const creatif = await base("creatif");
    bases.rotatePassword.mockImplementation(async (_s: string, id: string) => {
      if (id === creatif) throw new Error("hôte injoignable");
      return "nouveau";
    });
    await service.setOwner(serverId, nouveau, par);
    vi.clearAllMocks();

    const rejeu = await service.setOwner(serverId, nouveau, par);

    expect(rejeu).toMatchObject({ changed: false, databasesNotRotated: ["creatif"] });
    expect(bases.rotatePassword).not.toHaveBeenCalled();
    expect(wings.deauthorizeUser).not.toHaveBeenCalled();
  });

  it("nettoie chez Wings et chez les hôtes MySQL en même temps : un seul délai au pire, pas un par appel", async () => {
    await db.insert(serverSubusers).values({ serverId, userId: invite });
    await base("survie");
    let lances = 0;
    let liberer: () => void = () => undefined;
    const barriere = new Promise<void>((resolve) => {
      liberer = resolve;
    });
    const attendre = async () => {
      lances++;
      await barriere;
    };
    wings.deauthorizeUser.mockImplementation(attendre);
    bases.rotatePassword.mockImplementation(async () => {
      await attendre();
      return "nouveau";
    });

    const transfert = service.setOwner(serverId, nouveau, par);
    // Deux déconnexions et une base : les trois partent avant qu'aucune n'ait répondu.
    await vi.waitFor(() => expect(lances).toBe(3));
    liberer();
    await expect(transfert).resolves.toMatchObject({ changed: true, databasesRotated: 1 });
  });

  it("ne déconnecte pas le nouveau titulaire s'il était invité du serveur", async () => {
    await db.insert(serverSubusers).values({ serverId, userId: nouveau });

    await service.setOwner(serverId, nouveau, par);

    expect(wings.deauthorizeUser.mock.calls).toEqual([[serverId, ancien]]);
  });

  it("deux changements simultanés ne se croisent pas : le second part du titulaire laissé par le premier", async () => {
    const intermediaire = await seedUser(db);
    let liberer: () => void = () => undefined;
    const retenue = new Promise<void>((resolve) => {
      liberer = resolve;
    });
    let signaler: () => void = () => undefined;
    const verrouille = new Promise<void>((resolve) => {
      signaler = resolve;
    });
    // Un premier changement, tenu ouvert après avoir pris la ligne.
    const premier = db.transaction(async (tx) => {
      await tx.select().from(servers).where(eq(servers.id, serverId)).for("update");
      await tx.update(servers).set({ ownerId: intermediaire }).where(eq(servers.id, serverId));
      signaler();
      await retenue;
    });
    await verrouille;

    const second = service.setOwner(serverId, nouveau, par);
    await vi.waitFor(async () => {
      const resultat = (await db.execute(
        sql`select count(*)::int as n from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'`,
      )) as unknown as { n: number }[] | { rows: { n: number }[] };
      const lignes = Array.isArray(resultat) ? resultat : resultat.rows;
      expect(lignes[0]?.n).toBeGreaterThan(0);
    });
    liberer();
    await premier;
    await second;

    // Sans le verrou, le second lisait encore l'ancien titulaire, et
    // l'intermédiaire gardait ses accès.
    expect(wings.deauthorizeUser.mock.calls).toEqual([[serverId, intermediaire]]);
  });

  describe("fiche d'administration", () => {
    it("signale ce que le dernier changement n'a pas nettoyé, jusqu'à ce que ce soit fait", async () => {
      const creatif = await base("creatif");
      bases.rotatePassword.mockRejectedValue(new Error("hôte injoignable"));
      wings.deauthorizeUser.mockRejectedValue(new Error("node injoignable"));

      await service.setOwner(serverId, nouveau, par);

      const apres = await service.detail(serverId);
      expect(apres.ownerChange).toMatchObject({
        databasesNotRotated: ["creatif"],
        sessionsNotClosed: 1,
      });

      // La base a changé de mot de passe depuis : elle n'est plus signalée.
      await db
        .update(databases)
        .set({ updatedAt: new Date(Date.now() + 1_000).toISOString() })
        .where(eq(databases.id, creatif));
      expect((await service.detail(serverId)).ownerChange).toMatchObject({
        databasesNotRotated: [],
        sessionsNotClosed: 1,
      });

      // Un changement suivant, entièrement nettoyé : plus rien à signaler.
      bases.rotatePassword.mockResolvedValue("nouveau");
      wings.deauthorizeUser.mockResolvedValue(undefined);
      await service.setOwner(serverId, ancien, par);
      expect((await service.detail(serverId)).ownerChange).toBeNull();
    });

    it("rien pour un serveur jamais transféré", async () => {
      expect((await service.detail(serverId)).ownerChange).toBeNull();
    });
  });

  describe("route de l'administration", () => {
    function controleur(): AdminController {
      const instance = Object.create(AdminController.prototype) as AdminController;
      Object.assign(instance as unknown as Record<string, unknown>, { adminServers: service });
      return instance;
    }

    it("coupe le journal et rend à l'écran ce qui n'a pas été nettoyé", async () => {
      const admin = await seedUser(db);
      await gesteDeLAncien();
      await base("creatif");
      bases.rotatePassword.mockRejectedValue(new Error("hôte injoignable"));
      wings.deauthorizeUser.mockRejectedValue(new Error("node injoignable"));

      const reponse = await controleur().setServerOwner(
        { user: { id: admin, email: "admin@gamedashboard.test" }, ip: "203.0.113.9" } as never,
        serverId,
        { ownerId: nouveau },
      );

      expect(reponse).toEqual({
        data: { updated: serverId, databasesNotRotated: ["creatif"], sessionsNotClosed: 1 },
      });
      const vu = await activite.forServer(serverId);
      expect(vu.items.map((item) => item.event)).toEqual(["admin.server_owner_changed"]);
      const [bilan] = await db
        .select({ actorId: activityLogs.actorId, properties: activityLogs.properties })
        .from(activityLogs)
        .where(
          and(
            eq(activityLogs.serverId, serverId),
            eq(activityLogs.event, "server.owner_change_cleanup"),
          ),
        );
      expect(bilan).toMatchObject({
        actorId: admin,
        properties: { databasesNotRotated: ["creatif"], sessionsNotClosed: [ancien] },
      });
    });
  });
});
