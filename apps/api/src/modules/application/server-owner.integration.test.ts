import {
  activityLogs,
  applicationKeys,
  type Database,
  databaseHosts,
  databases,
  resellerCustomers,
  serverSubusers,
  servers,
  users,
} from "@gamedashboard/db";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, ne, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { seedLocation, seedNode, seedServer, seedUser } from "../../test/fixtures";
import {
  createThrowawayDatabase,
  HAS_DATABASE,
  type ThrowawayDatabase,
} from "../../test/throwaway-database";
import { ActivityService } from "../activity/activity.service";
import type { AdminActionsService } from "../admin/admin-actions.service";
import { AdminServerService } from "../admin/admin-server.service";
import type { BillingSsoService } from "../auth/billing-sso.service";
import type { DatabasesService } from "../client/databases.service";
import type { ServerResizeService } from "../client/server-resize.service";
import type { BrandingService } from "../reseller/branding.service";
import type { ResellerQuotaService } from "../reseller/reseller-quota.service";
import type { WingsClientService } from "../wings/wings-client.service";
import { WingsTokenService } from "../wings/wings-token.service";
import { ApplicationController } from "./application.controller";
import type { ApplicationRequest } from "./application.guard";
import { ApplicationService } from "./application.service";
import { IdempotencyService } from "./idempotency.service";
import { ResellerScopeService } from "./reseller-scope.service";

/**
 * Changer le titulaire d'un serveur par l'API applicative.
 *
 * Le défaut : la route n'existait pas. Le module ClientXCMS créait le compte
 * du nouveau client, puis rendait un échec et renvoyait au geste manuel —
 * pendant quoi l'ancien titulaire gardait la console d'un serveur qu'il ne
 * payait plus.
 *
 * La route traverse le vrai périmètre et le vrai changement de titulaire de
 * l'administration, contre une vraie base : seuls le daemon et le journal
 * d'audit sont des doublures.
 */
describe.skipIf(!HAS_DATABASE)("POST /application/servers/:id/owner (intégration)", () => {
  let throwaway: ThrowawayDatabase;
  let db: Database;

  const wings = {
    denyWebsocketTokens: vi.fn(async () => undefined),
    deauthorizeUser: vi.fn(async () => undefined),
  };
  const rotation = vi.fn(async () => "nouveau");
  const activity = { record: vi.fn(async (_input: unknown): Promise<void> => undefined) };
  let controleur: ApplicationController;

  let revendeur: string;
  let autreRevendeur: string;
  let ancien: string;
  let serveur: string;
  let nodeId: string;

  function requete(resellerId: string | null): ApplicationRequest {
    return {
      ip: "203.0.113.7",
      application: { keyId: "cle-1", name: "Boutique", resellerId, scopes: ["servers.owner"] },
    } as unknown as ApplicationRequest;
  }

  async function titulaire(serverId: string): Promise<string | undefined> {
    const [row] = await db
      .select({ ownerId: servers.ownerId })
      .from(servers)
      .where(eq(servers.id, serverId));
    return row?.ownerId;
  }

  /** Un serveur de plus pour ce compte, hébergé par ce revendeur (ou la plateforme). */
  async function serveurDe(ownerId: string, resellerId: string | null): Promise<string> {
    const id = await seedServer(db, { nodeId, ownerId });
    await db.update(servers).set({ resellerId }).where(eq(servers.id, id));
    return id;
  }

  async function role(userId: string, valeur: "admin" | "reseller" | "user"): Promise<void> {
    await db.update(users).set({ role: valeur }).where(eq(users.id, userId));
  }

  /** Un compte créé par la boutique de ce revendeur (`POST /users`). */
  async function creePar(resellerId: string): Promise<string> {
    const id = await seedUser(db);
    await db.insert(resellerCustomers).values({ userId: id, resellerId, origin: "api" });
    return id;
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
        `truncate table activity_logs, servers, allocations, eggs, nests, nodes, locations, users cascade`,
      ),
    );
    vi.clearAllMocks();
    activity.record.mockReset();
    activity.record.mockResolvedValue(undefined);

    const tokens = new WingsTokenService(db);
    controleur = new ApplicationController(
      {} as ApplicationService,
      {} as AdminActionsService,
      {} as ResellerQuotaService,
      {} as IdempotencyService,
      activity as unknown as ActivityService,
      {} as BillingSsoService,
      new ResellerScopeService(db),
      {} as BrandingService,
      {} as ServerResizeService,
      new AdminServerService(db, wings as unknown as WingsClientService, tokens, {
        rotatePassword: rotation,
      } as unknown as DatabasesService),
    );

    revendeur = await seedUser(db);
    await role(revendeur, "reseller");
    autreRevendeur = await seedUser(db);
    await role(autreRevendeur, "reseller");
    ancien = await seedUser(db);
    nodeId = await seedNode(db, { locationId: await seedLocation(db) });
    serveur = await serveurDe(ancien, revendeur);
  });

  it("clé de plateforme : le serveur change de mains, et l'acte est consigné", async () => {
    const nouveau = await seedUser(db);

    const reponse = await controleur.setServerOwner(requete(null), serveur, { ownerId: nouveau });

    expect(reponse).toEqual({
      data: {
        serverId: serveur,
        ownerId: nouveau,
        cleanup: {
          changed: true,
          subusersRemoved: 0,
          invitesRemoved: 0,
          webhooksRemoved: 0,
          databasesRotated: 0,
          databasesNotRotated: [],
          sessionsNotClosed: 0,
        },
      },
    });
    expect(await titulaire(serveur)).toBe(nouveau);
    // La ligne du changement, écrite avec lui : sans identifiant de tiers,
    // c'est la première que lit le nouveau titulaire.
    const lignes = await db
      .select({
        event: activityLogs.event,
        actorType: activityLogs.actorType,
        actorLabel: activityLogs.actorLabel,
        properties: activityLogs.properties,
      })
      .from(activityLogs)
      .where(
        and(
          eq(activityLogs.serverId, serveur),
          ne(activityLogs.event, "server.owner_change_cleanup"),
        ),
      );
    expect(lignes).toEqual([
      {
        event: "application.server_owner_changed",
        actorType: "api_key",
        actorLabel: "application:Boutique",
        properties: { ownerId: nouveau, cleanupFollows: true },
      },
    ]);
    // Le bilan, à part, pour l'administration.
    const [bilan] = await db
      .select({
        actorType: activityLogs.actorType,
        actorLabel: activityLogs.actorLabel,
        properties: activityLogs.properties,
      })
      .from(activityLogs)
      .where(
        and(
          eq(activityLogs.serverId, serveur),
          eq(activityLogs.event, "server.owner_change_cleanup"),
        ),
      );
    expect(bilan).toMatchObject({
      actorType: "api_key",
      actorLabel: "application:Boutique",
      properties: { ownerId: nouveau, previousOwnerId: ancien },
    });
  });

  it("le nouveau titulaire ne lit plus le journal de l'ancien, par ce chemin aussi", async () => {
    const nouveau = await seedUser(db);
    await db.insert(activityLogs).values({
      event: "server.command",
      serverId: serveur,
      actorId: ancien,
      actorType: "user",
      actorLabel: "ancien@exemple.fr",
      ip: "192.0.2.55",
      properties: {},
      at: new Date(Date.now() - 60_000).toISOString(),
    });

    await controleur.setServerOwner(requete(null), serveur, { ownerId: nouveau });

    const vu = await new ActivityService(db).forServer(serveur, { revealIp: true });
    expect(vu.items.map((item) => item.event)).toEqual(["application.server_owner_changed"]);
  });

  it("un rejeu rend le bilan du changement déjà fait, pour la facturation qui a abandonné l'appel", async () => {
    const nouveau = await seedUser(db);
    const [hote] = await db
      .insert(databaseHosts)
      .values({ name: "hôte", host: "127.0.0.1", username: "racine", passwordEnc: "x" })
      .returning({ id: databaseHosts.id });
    await db.insert(databases).values({
      serverId: serveur,
      databaseHostId: hote?.id ?? "",
      name: "s1_creatif",
      username: "u_creatif",
      passwordEnc: "x",
    });
    rotation.mockRejectedValueOnce(new Error("hôte injoignable"));

    await controleur.setServerOwner(requete(null), serveur, { ownerId: nouveau });
    const rejeu = await controleur.setServerOwner(requete(null), serveur, { ownerId: nouveau });

    expect(rejeu.data.cleanup).toMatchObject({
      changed: false,
      databasesNotRotated: ["s1_creatif"],
      sessionsNotClosed: 0,
    });
    expect(rotation).toHaveBeenCalledTimes(1);
  });

  it("la réponse dit à la facturation ce qui n'a pas pu être nettoyé", async () => {
    const nouveau = await seedUser(db);
    const [hote] = await db
      .insert(databaseHosts)
      .values({ name: "hôte", host: "127.0.0.1", username: "racine", passwordEnc: "x" })
      .returning({ id: databaseHosts.id });
    await db.insert(databases).values({
      serverId: serveur,
      databaseHostId: hote?.id ?? "",
      name: "s1_boutique",
      username: "u_boutique",
      passwordEnc: "x",
    });
    rotation.mockRejectedValueOnce(new Error("hôte injoignable"));
    wings.deauthorizeUser.mockRejectedValueOnce(new Error("node injoignable"));

    const reponse = await controleur.setServerOwner(requete(null), serveur, { ownerId: nouveau });

    // Le transfert a eu lieu ; le bilan nomme la base, et ne fait que
    // compter les comptes : un invité n'est pas forcément un client de la clé.
    expect(await titulaire(serveur)).toBe(nouveau);
    expect(reponse.data.cleanup).toMatchObject({
      databasesRotated: 0,
      databasesNotRotated: ["s1_boutique"],
      sessionsNotClosed: 1,
    });
  });

  it("le revendeur hébergeur reste : il dit qui héberge, pas qui possède", async () => {
    const nouveau = await seedUser(db);
    await controleur.setServerOwner(requete(null), serveur, { ownerId: nouveau });

    const [row] = await db
      .select({ resellerId: servers.resellerId })
      .from(servers)
      .where(eq(servers.id, serveur));
    expect(row?.resellerId).toBe(revendeur);
  });

  it("les garde-fous de l'administration s'appliquent : un revendeur qui refuse le provisionnement ne reçoit rien", async () => {
    await expect(
      controleur.setServerOwner(requete(null), serveur, { ownerId: autreRevendeur }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(await titulaire(serveur)).toBe(ancien);
  });

  it("clé de revendeur : un client tout juste créé par sa boutique, sans serveur, peut recevoir", async () => {
    const nouveau = await creePar(revendeur);

    await controleur.setServerOwner(requete(revendeur), serveur, { ownerId: nouveau });

    expect(await titulaire(serveur)).toBe(nouveau);
  });

  it("clé de revendeur : un client déjà entièrement chez lui peut recevoir", async () => {
    const client = await seedUser(db);
    await serveurDe(client, revendeur);

    await controleur.setServerOwner(requete(revendeur), serveur, { ownerId: client });

    expect(await titulaire(serveur)).toBe(client);
  });

  it("clé de revendeur : un compte sans serveur qu'il n'a pas créé ne reçoit pas", async () => {
    // Inscrit de lui-même, ouvert par l'administration, ou créé par un
    // confrère : il n'est pas à ce revendeur, et lui donner un serveur était
    // la première marche vers sa session.
    const inscrit = await seedUser(db);
    const duConfrere = await creePar(autreRevendeur);

    for (const cible of [inscrit, duConfrere]) {
      await expect(
        controleur.setServerOwner(requete(revendeur), serveur, { ownerId: cible }),
      ).rejects.toBeInstanceOf(NotFoundException);
    }
    expect(await titulaire(serveur)).toBe(ancien);
  });

  it("clé de revendeur : le client partagé avec un confrère ne reçoit pas", async () => {
    const client = await seedUser(db);
    await serveurDe(client, revendeur);
    await serveurDe(client, autreRevendeur);

    await expect(
      controleur.setServerOwner(requete(revendeur), serveur, { ownerId: client }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(await titulaire(serveur)).toBe(ancien);
  });

  it("clé de revendeur : un compte suspendu ne reçoit pas, même créé par lui", async () => {
    const suspendu = await creePar(revendeur);
    const inconnuSuspendu = await seedUser(db);
    await db
      .update(users)
      .set({ suspendedAt: new Date().toISOString() })
      .where(eq(users.id, suspendu));
    await db
      .update(users)
      .set({ suspendedAt: new Date().toISOString() })
      .where(eq(users.id, inconnuSuspendu));

    // Le sien : le refus dit pourquoi. Celui d'un autre : introuvable.
    await expect(
      controleur.setServerOwner(requete(revendeur), serveur, { ownerId: suspendu }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      controleur.setServerOwner(requete(revendeur), serveur, { ownerId: inconnuSuspendu }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("clé de revendeur : un compte invité sur le serveur d'un autre ne reçoit pas", async () => {
    const invite = await creePar(revendeur);
    const chezLAutre = await serveurDe(await seedUser(db), autreRevendeur);
    await db.insert(serverSubusers).values({ serverId: chezLAutre, userId: invite });

    await expect(
      controleur.setServerOwner(requete(revendeur), serveur, { ownerId: invite }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("clé de revendeur : un compte sans serveur, invité sur un serveur de la plateforme, ne reçoit pas", async () => {
    // `reseller_id` nul : `<>` ne l'aurait pas compté comme « ailleurs ».
    // Créé par sa boutique : seule l'invitation le fait refuser.
    const invite = await creePar(revendeur);
    const aLaPlateforme = await serveurDe(await seedUser(db), null);
    await db.insert(serverSubusers).values({ serverId: aLaPlateforme, userId: invite });

    await expect(
      controleur.setServerOwner(requete(revendeur), serveur, { ownerId: invite }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("clé de revendeur : son propre client, invité chez un confrère ou à la plateforme, reçoit", async () => {
    // La clé lit déjà sa fiche et lui ouvre déjà sa session : le refuser
    // n'empêchait qu'un transfert entre ses propres clients.
    for (const hote of [autreRevendeur, null]) {
      const client = await seedUser(db);
      await serveurDe(client, revendeur);
      const ailleurs = await serveurDe(await seedUser(db), hote);
      await db.insert(serverSubusers).values({ serverId: ailleurs, userId: client });

      await controleur.setServerOwner(requete(revendeur), serveur, { ownerId: client });

      expect(await titulaire(serveur)).toBe(client);
    }
  });

  it("clé de revendeur : son propre client suspendu est refusé, et le refus le dit", async () => {
    const client = await seedUser(db);
    await serveurDe(client, revendeur);
    await db
      .update(users)
      .set({ suspendedAt: new Date().toISOString() })
      .where(eq(users.id, client));

    const refus = controleur.setServerOwner(requete(revendeur), serveur, { ownerId: client });
    await expect(refus).rejects.toBeInstanceOf(ForbiddenException);
    await expect(refus).rejects.toThrow("suspendu");
    expect(await titulaire(serveur)).toBe(ancien);
  });

  it("clé de revendeur : un compte qu'il a créé, invité seulement chez lui, peut recevoir", async () => {
    const invite = await creePar(revendeur);
    await db.insert(serverSubusers).values({ serverId: serveur, userId: invite });

    await controleur.setServerOwner(requete(revendeur), serveur, { ownerId: invite });

    expect(await titulaire(serveur)).toBe(invite);
  });

  it("clé de revendeur : être invité chez lui ne suffit pas à être à lui", async () => {
    // Le titulaire invite qui il veut, y compris un compte qui n'est à
    // personne : l'invitation ne rattache pas au revendeur.
    const invite = await seedUser(db);
    await db.insert(serverSubusers).values({ serverId: serveur, userId: invite });

    await expect(
      controleur.setServerOwner(requete(revendeur), serveur, { ownerId: invite }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("clé de revendeur : le client d'un confrère est introuvable, comme partout", async () => {
    const client = await seedUser(db);
    await serveurDe(client, autreRevendeur);

    await expect(
      controleur.setServerOwner(requete(revendeur), serveur, { ownerId: client }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(await titulaire(serveur)).toBe(ancien);
  });

  it("clé de revendeur : le client de la plateforme est introuvable aussi", async () => {
    const client = await seedUser(db);
    await serveurDe(client, null);

    await expect(
      controleur.setServerOwner(requete(revendeur), serveur, { ownerId: client }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("clé de revendeur : ni le personnel ni un revendeur ne reçoivent, même sans serveur", async () => {
    const administrateur = await seedUser(db);
    await role(administrateur, "admin");

    for (const cible of [administrateur, autreRevendeur]) {
      await expect(
        controleur.setServerOwner(requete(revendeur), serveur, { ownerId: cible }),
      ).rejects.toBeInstanceOf(NotFoundException);
    }
    expect(await titulaire(serveur)).toBe(ancien);
  });

  it("clé de revendeur : le serveur d'un confrère est introuvable", async () => {
    const ailleurs = await serveurDe(ancien, autreRevendeur);
    const nouveau = await seedUser(db);

    await expect(
      controleur.setServerOwner(requete(revendeur), ailleurs, { ownerId: nouveau }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(await titulaire(ailleurs)).toBe(ancien);
  });

  it("ferme les consoles de l'ancien titulaire", async () => {
    const nouveau = await seedUser(db);
    await controleur.setServerOwner(requete(null), serveur, { ownerId: nouveau });

    // Aucun jeton inscrit : la révocation part quand même, vide, vers le daemon.
    expect(wings.denyWebsocketTokens).toHaveBeenCalledWith(serveur, []);
  });

  it("un identifiant illisible est un refus, jamais une erreur 500 de la base", async () => {
    const nouveau = await seedUser(db);

    // Corps : `ownerId` doit être un UUID.
    await expect(
      controleur.setServerOwner(requete(null), serveur, { ownerId: "nimporte-quoi" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(controleur.setServerOwner(requete(null), serveur, {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
    // Sans corps du tout : un message en français, pas celui de zod.
    await expect(controleur.setServerOwner(requete(null), serveur, undefined)).rejects.toThrow(
      "Corps de requête manquant",
    );

    // Serveur illisible : 404, pour la plateforme comme pour un revendeur.
    for (const cle of [null, revendeur]) {
      await expect(
        controleur.setServerOwner(requete(cle), "nimporte-quoi", { ownerId: nouveau }),
      ).rejects.toBeInstanceOf(NotFoundException);
    }
  });
});

/**
 * Créer un serveur fait entrer son destinataire dans le périmètre de la clé.
 *
 * Le défaut, antérieur au changement de titulaire : `POST /servers` ne
 * vérifiait pas à qui une clé de revendeur donnait le serveur. Elle annexait
 * ainsi le client d'un confrère ou un administrateur, puis lisait sa fiche,
 * renommait l'administrateur et réécrivait l'identifiant externe du client —
 * ce qui coupait la facturation du confrère.
 */
describe.skipIf(!HAS_DATABASE)("périmètre des comptes d'une clé de revendeur (intégration)", () => {
  let throwaway: ThrowawayDatabase;
  let db: Database;
  let scope: ResellerScopeService;
  let createServer: ReturnType<typeof vi.fn>;
  let updateUser: ReturnType<typeof vi.fn>;
  let controleur: ApplicationController;

  let revendeur: string;
  let confrere: string;
  let nodeId: string;

  const requete = (resellerId: string | null) =>
    ({
      ip: "203.0.113.7",
      application: { keyId: "cle-1", name: "Boutique", resellerId, scopes: [] },
    }) as unknown as ApplicationRequest;

  const corps = (ownerId: string) => ({
    ownerId,
    eggId: "5f7c2d1e-8a0b-4c3d-9e2f-1a2b3c4d5e6f",
    name: "Survie",
  });

  async function serveurDe(ownerId: string, resellerId: string | null): Promise<string> {
    const id = await seedServer(db, { nodeId, ownerId });
    await db.update(servers).set({ resellerId }).where(eq(servers.id, id));
    return id;
  }

  async function creePar(resellerId: string): Promise<string> {
    const id = await seedUser(db);
    await db.insert(resellerCustomers).values({ userId: id, resellerId, origin: "api" });
    return id;
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
      sql.raw(`truncate table servers, allocations, eggs, nests, nodes, locations, users cascade`),
    );
    scope = new ResellerScopeService(db);
    createServer = vi.fn(async () => ({ id: "serveur-cree" }));
    updateUser = vi.fn(async (id: string) => ({ id }));
    controleur = new ApplicationController(
      {
        createServer,
        updateUser,
        ownedServers: vi.fn(async () => 1),
      } as unknown as ApplicationService,
      {} as AdminActionsService,
      {} as ResellerQuotaService,
      {
        run: (_k: string, _r: string, _c: string | undefined, _i: unknown, faire: () => unknown) =>
          faire(),
      } as unknown as IdempotencyService,
      { record: vi.fn(async () => undefined) } as unknown as ActivityService,
      {} as BillingSsoService,
      scope,
      {} as BrandingService,
      {} as ServerResizeService,
      {} as AdminServerService,
    );

    revendeur = await seedUser(db);
    confrere = await seedUser(db);
    await db.update(users).set({ role: "reseller" }).where(eq(users.id, revendeur));
    await db.update(users).set({ role: "reseller" }).where(eq(users.id, confrere));
    nodeId = await seedNode(db, { locationId: await seedLocation(db) });
  });

  it("création : ni le client d'un confrère, ni la plateforme, ni le personnel ne reçoivent", async () => {
    const clientDuConfrere = await seedUser(db);
    await serveurDe(clientDuConfrere, confrere);
    const clientPlateforme = await seedUser(db);
    await serveurDe(clientPlateforme, null);
    const administrateur = await seedUser(db);
    await db.update(users).set({ role: "admin" }).where(eq(users.id, administrateur));

    for (const cible of [clientDuConfrere, clientPlateforme, administrateur, confrere]) {
      await expect(
        controleur.createServer(requete(revendeur), corps(cible)),
      ).rejects.toBeInstanceOf(NotFoundException);
    }
    expect(createServer).not.toHaveBeenCalled();
  });

  it("création : le compte que sa boutique a créé ou un client à lui reçoit ; une clé de plateforme n'est pas bornée", async () => {
    const neuf = await creePar(revendeur);
    const client = await seedUser(db);
    await serveurDe(client, revendeur);
    const clientDuConfrere = await seedUser(db);
    await serveurDe(clientDuConfrere, confrere);

    await controleur.createServer(requete(revendeur), corps(neuf));
    await controleur.createServer(requete(revendeur), corps(client));
    await controleur.createServer(requete(null), corps(clientDuConfrere));

    expect(createServer).toHaveBeenCalledTimes(3);
  });

  it("création : son propre client, invité ailleurs, reçoit", async () => {
    const client = await seedUser(db);
    await serveurDe(client, revendeur);
    const ailleurs = await serveurDe(await seedUser(db), confrere);
    await db.insert(serverSubusers).values({ serverId: ailleurs, userId: client });

    await controleur.createServer(requete(revendeur), corps(client));

    expect(createServer).toHaveBeenCalledTimes(1);
  });

  it("écriture par les routes : PATCH et DELETE refusent le client partagé, sans rien toucher", async () => {
    const partage = await seedUser(db);
    await serveurDe(partage, revendeur);
    await serveurDe(partage, confrere);

    await expect(
      controleur.updateUser(requete(revendeur), partage, { externalId: "vol" }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(controleur.deleteUser(requete(revendeur), partage)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(updateUser).not.toHaveBeenCalled();

    // Son propre client passe le périmètre (puis la route suit son cours).
    const aLui = await seedUser(db);
    await serveurDe(aLui, revendeur);
    await controleur.updateUser(requete(revendeur), aLui, { nameFirst: "Camille" });
    expect(updateUser).toHaveBeenCalledWith(aLui, { nameFirst: "Camille" });
    await expect(controleur.deleteUser(requete(revendeur), aLui)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("création : un compte sans serveur qui n'est pas à lui ne reçoit pas, ce qui ferme le chemin vers sa session", async () => {
    const inscrit = await seedUser(db);
    const duConfrere = await creePar(confrere);

    for (const cible of [inscrit, duConfrere]) {
      await expect(
        controleur.createServer(requete(revendeur), corps(cible)),
      ).rejects.toBeInstanceOf(NotFoundException);
      // Et il reste hors de portée ensuite : ni lu, ni modifié.
      await expect(scope.requireUser(revendeur, cible)).rejects.toBeInstanceOf(NotFoundException);
      await expect(scope.requireOwnedUser(revendeur, cible)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    }
    expect(createServer).not.toHaveBeenCalled();
    // Le confrère, lui, atteint le compte que sa boutique a créé.
    await expect(scope.requireOwnedUser(confrere, duConfrere)).resolves.toBeUndefined();
    await expect(scope.requireRecipient(confrere, duConfrere)).resolves.toBeUndefined();
  });

  it("lecture et écriture : le compte que sa boutique a créé, avant tout serveur", async () => {
    // La boutique retrouve le compte qu'elle vient d'ouvrir (reprise d'une
    // commande interrompue) et peut corriger son identifiant externe.
    const neuf = await creePar(revendeur);

    await expect(scope.requireUser(revendeur, neuf)).resolves.toBeUndefined();
    await expect(scope.requireOwnedUser(revendeur, neuf)).resolves.toBeUndefined();
  });

  it("écriture : le compte qu'il a créé, invité depuis chez un confrère, se lit mais ne se modifie ni ne se supprime", async () => {
    // Le supprimer retirait l'accès de l'équipe du confrère avec lui.
    const cree = await creePar(revendeur);
    const chezConfrere = await serveurDe(await seedUser(db), confrere);
    await db.insert(serverSubusers).values({ serverId: chezConfrere, userId: cree });

    await expect(scope.requireUser(revendeur, cree)).resolves.toBeUndefined();
    await expect(scope.requireOwnedUser(revendeur, cree)).rejects.toBeInstanceOf(NotFoundException);
    await expect(controleur.deleteUser(requete(revendeur), cree)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(
      await db.select().from(serverSubusers).where(eq(serverSubusers.userId, cree)),
    ).toHaveLength(1);
  });

  it("lecture : le personnel n'est pas un client, même avec un serveur chez le revendeur", async () => {
    const administrateur = await seedUser(db);
    await db.update(users).set({ role: "admin" }).where(eq(users.id, administrateur));
    await serveurDe(administrateur, revendeur);

    await expect(scope.requireUser(revendeur, administrateur)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("écriture : le client partagé se lit, mais ne se modifie pas", async () => {
    const partage = await seedUser(db);
    await serveurDe(partage, revendeur);
    await serveurDe(partage, confrere);
    const aLui = await seedUser(db);
    await serveurDe(aLui, revendeur);

    await expect(scope.requireUser(revendeur, partage)).resolves.toBeUndefined();
    await expect(scope.requireOwnedUser(revendeur, partage)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(scope.requireOwnedUser(revendeur, aLui)).resolves.toBeUndefined();
    await expect(scope.requireOwnedUser(null, partage)).resolves.toBeUndefined();
  });
});

/**
 * Un rejeu idempotent rend le serveur déjà créé, même si le compte a changé.
 *
 * Le contrôle du destinataire passait avant le filet d'idempotence : une
 * boutique qui avait perdu la réponse et rejouait recevait 404 pour un
 * serveur bel et bien créé, dès que le compte avait été invité ailleurs
 * entre-temps.
 */
describe.skipIf(!HAS_DATABASE)("rejeu idempotent de POST /servers (intégration)", () => {
  let throwaway: ThrowawayDatabase;
  let db: Database;
  let nodeId: string;

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
        `truncate table application_keys, servers, allocations, eggs, nests, nodes, locations, users cascade`,
      ),
    );
    nodeId = await seedNode(db, { locationId: await seedLocation(db) });
  });

  it("rend la première réponse, sans refaire le contrôle ni créer de nouveau", async () => {
    const revendeur = await seedUser(db);
    await db.update(users).set({ role: "reseller" }).where(eq(users.id, revendeur));
    const [cle] = await db
      .insert(applicationKeys)
      .values({ name: "Boutique", prefix: "gd_app_rejeu", keyHash: "x", resellerId: revendeur })
      .returning({ id: applicationKeys.id });
    // Un compte que sa boutique a créé : il peut recevoir.
    const client = await seedUser(db);
    await db
      .insert(resellerCustomers)
      .values({ userId: client, resellerId: revendeur, origin: "api" });

    const createServer = vi.fn(async () => ({ id: "serveur-cree" }));
    const controleur = new ApplicationController(
      { createServer } as unknown as ApplicationService,
      {} as AdminActionsService,
      {} as ResellerQuotaService,
      new IdempotencyService(db),
      { record: vi.fn(async () => undefined) } as unknown as ActivityService,
      {} as BillingSsoService,
      new ResellerScopeService(db),
      {} as BrandingService,
      {} as ServerResizeService,
      {} as AdminServerService,
    );
    const requete = {
      ip: "203.0.113.7",
      application: { keyId: cle?.id, name: "Boutique", resellerId: revendeur, scopes: [] },
    } as unknown as ApplicationRequest;
    const corps = {
      ownerId: client,
      eggId: "5f7c2d1e-8a0b-4c3d-9e2f-1a2b3c4d5e6f",
      name: "Survie",
    };

    const premiere = await controleur.createServer(requete, corps, "commande-4271-serveur");
    // Entre-temps, le compte reçoit un serveur de la plateforme : il possède
    // ailleurs, ce qui fait refuser toute nouvelle demande de ce revendeur.
    // (Une invitation ailleurs ne suffirait plus : le compte servi est à lui.)
    await seedServer(db, { nodeId, ownerId: client });

    const rejeu = await controleur.createServer(requete, corps, "commande-4271-serveur");

    expect(rejeu).toEqual(premiere);
    expect(createServer).toHaveBeenCalledTimes(1);
    // Sans la clé d'idempotence, c'est une nouvelle demande : refusée.
    await expect(controleur.createServer(requete, corps)).rejects.toBeInstanceOf(NotFoundException);
  });
});

/**
 * Des identifiants illisibles et un identifiant externe déjà pris : des
 * refus qui disent quoi corriger, plus d'erreur 500 de la base.
 */
describe.skipIf(!HAS_DATABASE)("erreurs 500 de l'API applicative (intégration)", () => {
  let throwaway: ThrowawayDatabase;
  let db: Database;
  let service: ApplicationService;

  beforeAll(async () => {
    throwaway = await createThrowawayDatabase();
    db = throwaway.db;
  }, 60_000);

  afterAll(async () => {
    await throwaway?.drop();
  });

  beforeEach(async () => {
    await db.execute(sql.raw(`truncate table servers, users cascade`));
    service = new ApplicationService(
      db,
      {} as never,
      {} as never,
      { emit: vi.fn(async () => undefined) } as never,
    );
  });

  it("un identifiant illisible ne désigne personne", async () => {
    expect(await service.findUser({ id: "nimporte-quoi" })).toBeNull();
    expect(await service.servers({ ownerId: "nimporte-quoi" })).toEqual([]);
    await expect(service.server("nimporte-quoi")).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.createServer({ ownerId: "nimporte-quoi", eggId: "x", name: "Survie" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("PATCH avec l'identifiant externe d'un autre compte : 409, et rien ne change", async () => {
    const premier = await seedUser(db);
    const second = await seedUser(db);
    await db.update(users).set({ externalId: "whmcs-7" }).where(eq(users.id, premier));

    await expect(service.updateUser(second, { externalId: "whmcs-7" })).rejects.toBeInstanceOf(
      ConflictException,
    );
    // Reposer le sien n'est pas une collision.
    await expect(service.updateUser(premier, { externalId: "whmcs-7" })).resolves.toMatchObject({
      id: premier,
    });
  });
});

/**
 * `POST /users` d'une clé de revendeur rattache le compte à ce revendeur.
 *
 * C'est ce rattachement, et lui seul, qui permet à sa boutique de livrer
 * ensuite un serveur à un compte qui n'en a encore aucun.
 */
describe.skipIf(!HAS_DATABASE)("création d'un compte par une clé (intégration)", () => {
  let throwaway: ThrowawayDatabase;
  let db: Database;
  let service: ApplicationService;

  beforeAll(async () => {
    throwaway = await createThrowawayDatabase();
    db = throwaway.db;
  }, 60_000);

  afterAll(async () => {
    await throwaway?.drop();
  });

  beforeEach(async () => {
    await db.execute(sql.raw(`truncate table servers, users cascade`));
    service = new ApplicationService(
      db,
      {} as never,
      {} as never,
      { emit: vi.fn(async () => undefined) } as never,
    );
  });

  it("une clé de revendeur rattache le compte qu'elle crée ; une clé de plateforme, non", async () => {
    const revendeur = await seedUser(db);
    await db.update(users).set({ role: "reseller" }).where(eq(users.id, revendeur));

    const sien = await service.createUser(
      { email: "sien@exemple.fr", nameFirst: "Camille", nameLast: "Martin" },
      revendeur,
    );
    const plateforme = await service.createUser({
      email: "plateforme@exemple.fr",
      nameFirst: "Alex",
      nameLast: "Durand",
    });

    const lignes = await db
      .select({ userId: resellerCustomers.userId, resellerId: resellerCustomers.resellerId })
      .from(resellerCustomers);
    expect(lignes).toEqual([{ userId: sien.id, resellerId: revendeur }]);
    const scope = new ResellerScopeService(db);
    await expect(scope.requireRecipient(revendeur, sien.id)).resolves.toBeUndefined();
    await expect(scope.requireRecipient(revendeur, plateforme.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
