import { backups, type Database } from "@gamedashboard/db";
import { NotFoundException } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { seedLocation, seedNode, seedServer, seedUser } from "../../test/fixtures";
import {
  createThrowawayDatabase,
  HAS_DATABASE,
  type ThrowawayDatabase,
} from "../../test/throwaway-database";
import type { ActivityService } from "../activity/activity.service";
import type { NotificationsService } from "../notifications/notifications.service";
import type { S3Service } from "../storage/s3.service";
import { RemoteBackupService } from "./remote-backup.service";

/**
 * Comptes rendus de sauvegarde, contre une vraie base.
 *
 * Premier défaut corrigé : `backups.bytes` était un `integer`, plafonné à
 * 2 Gio. Le compte rendu d'une archive plus grosse échouait à l'écriture,
 * Wings n'obtenait pas d'accusé de réception et effaçait l'archive. Seule une
 * vraie base PostgreSQL refuse la valeur : une doublure l'aurait acceptée.
 *
 * Second défaut (NC-09) : une sauvegarde **close** acceptait encore un compte
 * rendu et une demande d'adresses d'envoi. Un node compromis réécrivait ainsi
 * l'archive distante d'une sauvegarde terminée — restaurée plus tard sur un
 * node sain — ou basculait une sauvegarde locale sur le compartiment.
 */
describe.skipIf(!HAS_DATABASE)("RemoteBackupService (intégration)", () => {
  let throwaway: ThrowawayDatabase;
  let db: Database;
  let service: RemoteBackupService;
  let nodeId: string;
  let backupId: string;
  let serverId: string;
  let notifiees: string[];

  /** Le compartiment, simulé : ce qu'on vérifie ici vit dans les prédicats SQL. */
  const s3 = {
    keyFor: vi.fn(async (server: string, backup: string) => `${server}/${backup}.tar.gz`),
    abortUpload: vi.fn(async () => {}),
    openUpload: vi.fn(async () => ({
      uploadId: "depot-1",
      parts: ["https://s3.test/partie-1"],
      partSize: 64 * 1024 * 1024,
    })),
    completeUpload: vi.fn(async () => true),
  };

  /** Une sauvegarde de ce serveur, dans l'état voulu. */
  async function sauvegarde(values: Partial<typeof backups.$inferInsert> = {}): Promise<string> {
    const [row] = await db
      .insert(backups)
      .values({ serverId, name: "Monde entier", ...values })
      .returning({ id: backups.id });
    if (!row) throw new Error("sauvegarde non créée");
    return row.id;
  }

  beforeAll(async () => {
    throwaway = await createThrowawayDatabase();
    db = throwaway.db;
    const notifications = {
      notifyServerOwner: async (_id: string, input: { type: string }) => {
        notifiees.push(input.type);
      },
    } as unknown as NotificationsService;
    service = new RemoteBackupService(
      db,
      notifications,
      s3 as unknown as S3Service,
      {
        record: async () => undefined,
      } as unknown as ActivityService,
    );
  }, 60_000);

  afterAll(async () => {
    await throwaway?.drop();
  });

  beforeEach(async () => {
    await db.execute(
      sql.raw(
        `truncate table backups, servers, allocations, eggs, nests, nodes, locations, users cascade`,
      ),
    );
    notifiees = [];
    vi.clearAllMocks();

    const locationId = await seedLocation(db);
    nodeId = await seedNode(db, { locationId });
    serverId = await seedServer(db, { nodeId, ownerId: await seedUser(db) });
    backupId = await sauvegarde();
  });

  it("enregistre une archive de plus de 2 Gio", async () => {
    const taille = 5 * 1024 ** 3;
    await service.complete(nodeId, backupId, {
      successful: true,
      size: taille,
      checksum: "0123456789abcdef",
      checksum_type: "sha1",
    });

    const [row] = await db.select().from(backups).where(eq(backups.id, backupId));
    expect(row?.isSuccessful).toBe(true);
    expect(row?.bytes).toBe(taille);
    expect(notifiees).toEqual([]);
  });

  it("suit le chemin nominal d'une sauvegarde distante : adresses, puis compte rendu", async () => {
    // Ce que fait Wings avec l'adaptateur `s3` : il pèse l'archive, demande
    // les adresses, envoie, puis rend compte. La correction ne doit rien en
    // retirer.
    const id = await sauvegarde({ disk: "s3" });

    expect(await service.openUpload(nodeId, id, 1024)).toEqual({
      parts: ["https://s3.test/partie-1"],
      part_size: 64 * 1024 * 1024,
    });

    await service.complete(nodeId, id, {
      successful: true,
      size: 1024,
      checksum: "abc",
      parts: [{ etag: "e1", part_number: 1 }],
    });

    expect(s3.completeUpload).toHaveBeenCalledWith(expect.any(String), "depot-1", [
      { etag: "e1", partNumber: 1 },
    ]);
    const [row] = await db.select().from(backups).where(eq(backups.id, id));
    expect(row).toMatchObject({ disk: "s3", isSuccessful: true, bytes: 1024, uploadId: null });
  });

  it("ne rouvre pas le dépôt d'une sauvegarde close", async () => {
    // Rouvrir le dépôt, c'est rendre au node de quoi écraser l'archive d'une
    // sauvegarde terminée, que le client restaurera plus tard en confiance.
    const id = await sauvegarde({
      disk: "s3",
      isSuccessful: true,
      completedAt: new Date().toISOString(),
    });

    await expect(service.openUpload(nodeId, id, 1024)).rejects.toBeInstanceOf(NotFoundException);
    expect(s3.openUpload).not.toHaveBeenCalled();
    expect(s3.abortUpload).not.toHaveBeenCalled();
  });

  it("ne bascule pas une sauvegarde locale sur le compartiment", async () => {
    // Le lieu de l'archive est décidé à la création (`BackupsService.create`),
    // une fois pour toutes. Wings ne demande d'adresses que pour l'adaptateur
    // `s3` : une demande sur une sauvegarde locale ne vient pas de lui.
    await expect(service.openUpload(nodeId, backupId, 1024)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(s3.openUpload).not.toHaveBeenCalled();
    const [row] = await db.select().from(backups).where(eq(backups.id, backupId));
    expect(row?.disk).toBe("local");
    expect(row?.uploadId).toBeNull();
  });

  it("n'applique pas un second compte rendu à une sauvegarde close", async () => {
    await service.complete(nodeId, backupId, { successful: true, size: 42, checksum: "abc" });

    // Un node qui voudrait faire passer pour ratée — ou pour réussie — une
    // sauvegarde déjà close, ou en changer l'empreinte.
    await service.complete(nodeId, backupId, { successful: false });
    await service.complete(nodeId, backupId, { successful: true, size: 1, checksum: "autre" });

    const [row] = await db.select().from(backups).where(eq(backups.id, backupId));
    expect(row).toMatchObject({ isSuccessful: true, bytes: 42, checksum: "abc" });
    expect(notifiees).toEqual([]);
  });

  it("accuse réception d'un compte rendu répété, sans erreur", async () => {
    /*
     * Un 4xx ici ferait effacer l'archive par Wings : c'est ce qu'il fait
     * quand le panel refuse un compte rendu (`server/backup.go`). Or un compte
     * rendu répété est d'abord le cas d'un accusé de réception perdu, que le
     * daemon rejoue — la sauvegarde est close, et bien close.
     */
    await service.complete(nodeId, backupId, { successful: true, size: 42 });
    await expect(
      service.complete(nodeId, backupId, { successful: true, size: 42 }),
    ).resolves.toBeUndefined();
  });

  it("refuse toujours une sauvegarde inconnue de ce node", async () => {
    const ailleurs = await seedNode(db, { locationId: await seedLocation(db) });
    await expect(service.complete(ailleurs, backupId, { successful: true })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
