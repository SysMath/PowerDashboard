import {
  allocations,
  backups,
  type Database,
  databaseHosts,
  databases,
  schedules,
  serverSubusers,
  servers,
  webhooks,
} from "@gamedashboard/db";
import { NotFoundException } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { seedLocation, seedNode, seedServer, seedUser } from "../../test/fixtures";
import { sousDomainesInertes } from "../../test/sous-domaines";
import {
  createThrowawayDatabase,
  HAS_DATABASE,
  type ThrowawayDatabase,
} from "../../test/throwaway-database";
import type { NotificationsService } from "../notifications/notifications.service";
import type { S3Service } from "../storage/s3.service";
import type { WingsClientService } from "../wings/wings-client.service";
import type { WingsTokenService } from "../wings/wings-token.service";
import { AllocationsService } from "./allocations.service";
import { BackupHooks } from "./backup-hooks";
import { BackupsService } from "./backups.service";
import { DatabasesService } from "./databases.service";
import type { MysqlProvisionerService } from "./mysql-provisioner.service";
import { SchedulesService } from "./schedules.service";
import type { ServerInvitesService } from "./server-invites.service";
import { ServerWebhooksService } from "./server-webhooks.service";
import { SubusersService } from "./subusers.service";

/**
 * Un objet d'un serveur, visé depuis l'adresse d'un autre.
 *
 * Le contrôle d'accès garde la porte du **serveur** : qui a `backups.delete`
 * sur le sien passe. Chaque service doit ensuite garder l'**objet** — la
 * sauvegarde, la base, la tâche, le port, l'accès, le rappel — en mettant le
 * serveur dans la condition de sa requête (`mustFind`, `mustOwn`, `owned`).
 * Sans cela, changer un identifiant dans l'URL suffirait à supprimer la
 * sauvegarde d'un voisin. Aucun test ne le tenait : une condition retirée par
 * mégarde passait inaperçue. Contre une vraie base, puisque c'est un prédicat
 * SQL qui décide.
 */
describe.skipIf(!HAS_DATABASE)("objets d'un serveur étranger (IDOR)", () => {
  let throwaway: ThrowawayDatabase;
  let db: Database;

  const wings = {
    deleteBackup: vi.fn(async () => undefined),
    restoreBackup: vi.fn(async () => undefined),
    syncServer: vi.fn(async () => undefined),
    denyWebsocketTokens: vi.fn(async () => undefined),
  };
  const mysql = {
    rotatePassword: vi.fn(async () => undefined),
    dropDatabase: vi.fn(async () => undefined),
  };
  const tokens = {
    backupDownloadGrant: vi.fn(async () => "https://node.test/sauvegarde"),
    revocableFor: vi.fn(() => []),
  };
  const s3 = { discard: vi.fn(async () => undefined), keyFor: vi.fn(async () => "cle") };

  let services: {
    backups: BackupsService;
    databases: DatabasesService;
    schedules: SchedulesService;
    allocations: AllocationsService;
    subusers: SubusersService;
    webhooks: ServerWebhooksService;
  };

  /** Le serveur d'où l'on vise, dont on a tous les droits. */
  let mien: string;
  let proprietaire: string;
  /** Les objets du voisin. */
  let voisin: {
    serverId: string;
    backupId: string;
    databaseId: string;
    scheduleId: string;
    allocationId: string;
    subuserId: string;
    webhookId: string;
  };

  beforeAll(async () => {
    throwaway = await createThrowawayDatabase();
    db = throwaway.db;
    const w = wings as unknown as WingsClientService;
    const t = tokens as unknown as WingsTokenService;
    services = {
      backups: new BackupsService(db, w, t, s3 as unknown as S3Service, new BackupHooks()),
      databases: new DatabasesService(db, mysql as unknown as MysqlProvisionerService),
      schedules: new SchedulesService(db),
      allocations: new AllocationsService(db, w, sousDomainesInertes()),
      subusers: new SubusersService(
        db,
        w,
        t,
        {} as NotificationsService,
        {} as ServerInvitesService,
      ),
      webhooks: new ServerWebhooksService(db),
    };
  }, 60_000);

  afterAll(async () => {
    await throwaway?.drop();
  });

  beforeEach(async () => {
    await db.execute(
      sql.raw(
        `truncate table webhooks, server_subusers, schedules, databases, database_hosts, backups, servers, allocations, eggs, nests, nodes, locations, users cascade`,
      ),
    );
    vi.clearAllMocks();

    proprietaire = await seedUser(db);
    const autre = await seedUser(db);
    const invite = await seedUser(db);
    const nodeId = await seedNode(db, { locationId: await seedLocation(db) });
    mien = await seedServer(db, { nodeId, ownerId: proprietaire });
    const serverId = await seedServer(db, { nodeId, ownerId: autre });

    const [backup] = await db
      .insert(backups)
      .values({ serverId, name: "Nuit", disk: "local", isSuccessful: true })
      .returning({ id: backups.id });
    const [host] = await db
      .insert(databaseHosts)
      .values({ name: "MySQL", host: "mysql.test", username: "root", passwordEnc: "test" })
      .returning({ id: databaseHosts.id });
    const [base] = await db
      .insert(databases)
      .values({
        serverId,
        databaseHostId: host?.id ?? "",
        name: "s_voisin",
        username: "u_voisin",
        passwordEnc: "test",
      })
      .returning({ id: databases.id });
    const [tache] = await db
      .insert(schedules)
      .values({ serverId, name: "Redémarrage" })
      .returning({ id: schedules.id });
    const [port] = await db
      .insert(allocations)
      .values({ nodeId, ip: "127.0.0.1", port: 31_000, serverId })
      .returning({ id: allocations.id });
    const [acces] = await db
      .insert(serverSubusers)
      .values({ serverId, userId: invite, permissions: ["console.read"] })
      .returning({ id: serverSubusers.id });
    const [rappel] = await db
      .insert(webhooks)
      .values({ ownerId: autre, serverId, url: "https://voisin.test/hook", secretEnc: "test" })
      .returning({ id: webhooks.id });

    voisin = {
      serverId,
      backupId: backup?.id ?? "",
      databaseId: base?.id ?? "",
      scheduleId: tache?.id ?? "",
      allocationId: port?.id ?? "",
      subuserId: acces?.id ?? "",
      webhookId: rappel?.id ?? "",
    };
  });

  async function introuvable(appel: Promise<unknown>): Promise<void> {
    await expect(appel).rejects.toBeInstanceOf(NotFoundException);
  }

  it("sauvegardes : ni lien, ni verrou, ni restauration, ni suppression", async () => {
    const { backups: s } = services;
    await introuvable(s.downloadUrl(mien, voisin.backupId, proprietaire));
    await introuvable(s.setLocked(mien, voisin.backupId, true));
    await introuvable(s.restore(mien, voisin.backupId, true));
    await introuvable(s.remove(mien, voisin.backupId));

    expect(tokens.backupDownloadGrant).not.toHaveBeenCalled();
    expect(wings.restoreBackup).not.toHaveBeenCalled();
    expect(wings.deleteBackup).not.toHaveBeenCalled();
    const [row] = await db.select().from(backups).where(eq(backups.id, voisin.backupId));
    expect(row?.isLocked).toBe(false);
  });

  it("bases : ni mot de passe, ni rotation, ni suppression", async () => {
    const { databases: s } = services;
    await introuvable(s.password(mien, voisin.databaseId));
    await introuvable(s.rotatePassword(mien, voisin.databaseId));
    await introuvable(s.remove(mien, voisin.databaseId));

    expect(mysql.rotatePassword).not.toHaveBeenCalled();
    expect(mysql.dropDatabase).not.toHaveBeenCalled();
    expect(
      await db.select().from(databases).where(eq(databases.id, voisin.databaseId)),
    ).toHaveLength(1);
  });

  it("tâches planifiées : ni lecture des étapes, ni modification, ni lancement, ni suppression", async () => {
    const { schedules: s } = services;
    const cron = { minute: "0", hour: "4", dayOfMonth: "*", month: "*", dayOfWeek: "*" };
    await introuvable(s.tasksOf(mien, voisin.scheduleId));
    await introuvable(
      s.update(mien, voisin.scheduleId, "Pris", cron, { onlyWhenOnline: true, isActive: true }, []),
    );
    await introuvable(s.setActive(mien, voisin.scheduleId, false));
    await introuvable(s.runNow(mien, voisin.scheduleId));
    await introuvable(s.remove(mien, voisin.scheduleId));

    const [row] = await db.select().from(schedules).where(eq(schedules.id, voisin.scheduleId));
    expect(row).toMatchObject({ name: "Redémarrage", isActive: true, nextRunAt: null });
  });

  it("ports : ni principal, ni note, ni libération", async () => {
    const { allocations: s } = services;
    await introuvable(s.setPrimary(mien, voisin.allocationId));
    await introuvable(s.setNotes(mien, voisin.allocationId, "pris"));
    await introuvable(s.release(mien, voisin.allocationId));

    expect(wings.syncServer).not.toHaveBeenCalled();
    const [port] = await db
      .select()
      .from(allocations)
      .where(eq(allocations.id, voisin.allocationId));
    expect(port).toMatchObject({ serverId: voisin.serverId, notes: null });
    const [serveur] = await db
      .select({ allocationId: servers.allocationId })
      .from(servers)
      .where(eq(servers.id, mien));
    expect(serveur?.allocationId).not.toBe(voisin.allocationId);
  });

  it("accès : ni modification, ni retrait", async () => {
    const { subusers: s } = services;
    await introuvable(s.update(mien, proprietaire, voisin.subuserId, ["console.read"]));
    await introuvable(s.remove(mien, voisin.subuserId));

    expect(
      await db.select().from(serverSubusers).where(eq(serverSubusers.id, voisin.subuserId)),
    ).toHaveLength(1);
  });

  it("rappels : ni livraisons, ni secret, ni modification, ni suppression", async () => {
    const { webhooks: s } = services;
    await introuvable(s.deliveries(mien, voisin.webhookId));
    await introuvable(s.rotate(mien, voisin.webhookId));
    await introuvable(s.update(mien, voisin.webhookId, { isActive: false }));
    await introuvable(s.remove(mien, voisin.webhookId));

    const [row] = await db.select().from(webhooks).where(eq(webhooks.id, voisin.webhookId));
    expect(row).toMatchObject({ secretEnc: "test", isActive: true });
  });
});
