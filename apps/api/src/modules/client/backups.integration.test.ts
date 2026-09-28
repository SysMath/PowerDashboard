import { activityLogs, backups, type Database, servers } from "@gamedashboard/db";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { seedLocation, seedNode, seedServer, seedUser } from "../../test/fixtures";
import {
  createThrowawayDatabase,
  HAS_DATABASE,
  type ThrowawayDatabase,
} from "../../test/throwaway-database";
import { ActivityService } from "../activity/activity.service";
import type { NotificationsService } from "../notifications/notifications.service";
import { RESTORE_STALE_MS, RemoteBackupService } from "../remote/remote-backup.service";
import type { S3Service } from "../storage/s3.service";
import { type WingsClientService, WingsUnavailableError } from "../wings/wings-client.service";
import type { WingsTokenService } from "../wings/wings-token.service";
import { BackupsService } from "./backups.service";

/**
 * Où vit l'archive, contre une vraie base.
 *
 * Le défaut corrigé : le panel demandait toujours l'adaptateur local à Wings,
 * même avec un compartiment réglé, et ne savait ni restaurer ni supprimer une
 * archive distante. Les sauvegardes mouraient avec la machine qu'elles
 * protégeaient. Tout se décide sur la colonne `disk` : c'est elle qu'on lit.
 *
 * Le daemon et le compartiment sont des doublures : seul le panel est sous test.
 */
describe.skipIf(!HAS_DATABASE)("BackupsService (intégration)", () => {
  let throwaway: ThrowawayDatabase;
  let db: Database;
  let serverId: string;
  let nodeId: string;
  let compartimentRegle: boolean;
  let lienSigne: string | null;

  const wings = {
    createBackup: vi.fn(async () => undefined),
    deleteBackup: vi.fn(async () => undefined),
    restoreBackup: vi.fn(async () => undefined),
  };
  const s3 = {
    isConfigured: vi.fn(async () => compartimentRegle),
    keyFor: vi.fn(async (serveur: string, sauvegarde: string) => `${serveur}/${sauvegarde}.tar.gz`),
    presignDownload: vi.fn(async () => lienSigne),
    discard: vi.fn(async () => undefined),
  };
  let service: BackupsService;

  beforeAll(async () => {
    throwaway = await createThrowawayDatabase();
    db = throwaway.db;
    service = new BackupsService(
      db,
      wings as unknown as WingsClientService,
      {
        backupDownloadGrant: async () => "https://node.test/grant",
      } as unknown as WingsTokenService,
      s3 as unknown as S3Service,
    );
  }, 60_000);

  afterAll(async () => {
    await throwaway?.drop();
  });

  beforeEach(async () => {
    await db.execute(
      sql.raw(
        `truncate table activity_logs, backups, servers, allocations, eggs, nests, nodes, locations, users cascade`,
      ),
    );
    vi.clearAllMocks();
    // Rétablie à chaque test : l'essai de concurrence la remplace.
    s3.isConfigured.mockImplementation(async () => compartimentRegle);
    compartimentRegle = true;
    lienSigne = "https://s3.exemple.test/signe";

    const locationId = await seedLocation(db);
    nodeId = await seedNode(db, { locationId });
    serverId = await seedServer(db, { nodeId, ownerId: await seedUser(db) });
    await db.update(servers).set({ backupLimit: 5 }).where(eq(servers.id, serverId));
  });

  /** Une sauvegarde terminée, posée directement en base. */
  async function terminee(disk: "local" | "s3", uploadId: string | null = null): Promise<string> {
    const [row] = await db
      .insert(backups)
      .values({ serverId, name: "Nuit", disk, isSuccessful: true, uploadId })
      .returning({ id: backups.id });
    if (!row) throw new Error("sauvegarde non créée");
    return row.id;
  }

  async function ligne(id: string) {
    const [row] = await db.select().from(backups).where(eq(backups.id, id));
    return row;
  }

  it("avec un compartiment réglé, demande l'adaptateur s3 et retient le lieu", async () => {
    const creee = await service.create(serverId, "Avant mise à jour", ["logs"]);

    expect(wings.createBackup).toHaveBeenCalledWith(serverId, creee.id, ["logs"], "s3");
    expect((await ligne(creee.id))?.disk).toBe("s3");
  });

  it("sans compartiment, garde l'archive sur le disque du node", async () => {
    compartimentRegle = false;
    const creee = await service.create(serverId, "Avant mise à jour", []);

    expect(wings.createBackup).toHaveBeenCalledWith(serverId, creee.id, [], "wings");
    expect((await ligne(creee.id))?.disk).toBe("local");
  });

  it("restaure une archive distante par le lien signé", async () => {
    const id = await terminee("s3");
    await service.restore(serverId, id, true);

    expect(wings.restoreBackup).toHaveBeenCalledWith(
      serverId,
      id,
      true,
      "https://s3.exemple.test/signe",
    );
  });

  it("restaure une archive locale sans lien", async () => {
    const id = await terminee("local");
    await service.restore(serverId, id, false);

    expect(wings.restoreBackup).toHaveBeenCalledWith(serverId, id, false, undefined);
    expect(s3.presignDownload).not.toHaveBeenCalled();
  });

  it("refuse de restaurer une archive distante quand le compartiment n'est plus réglé", async () => {
    const id = await terminee("s3");
    lienSigne = null;

    await expect(service.restore(serverId, id, false)).rejects.toBeInstanceOf(ConflictException);
    expect(wings.restoreBackup).not.toHaveBeenCalled();
  });

  /**
   * État `restoring` (NC-44) : il n'était jamais posé, faute de rien pour le
   * relâcher. Le compte rendu de Wings, qui arrive en fin de restauration
   * réussie ou non, le relâche désormais.
   */
  describe("état de restauration", () => {
    const etat = async () =>
      (await db.select({ state: servers.state }).from(servers).where(eq(servers.id, serverId)))[0]
        ?.state;
    const rapport = () =>
      new RemoteBackupService(
        db,
        {} as unknown as NotificationsService,
        {} as unknown as S3Service,
        new ActivityService(db),
      );
    const issues = async () =>
      (
        await db
          .select({ event: activityLogs.event })
          .from(activityLogs)
          .where(eq(activityLogs.serverId, serverId))
      ).map((row) => row.event);

    it("pose l'état pendant la restauration, le compte rendu du daemon le relâche", async () => {
      const id = await terminee("local");
      await service.restore(serverId, id, false);
      expect(await etat()).toBe("restoring");

      await rapport().restored(nodeId, id, true);
      expect(await etat()).toBeNull();
      // L'issue au journal du serveur, une seule fois même si Wings rejoue.
      await rapport().restored(nodeId, id, true);
      expect(await issues()).toEqual(["backup.restore_completed"]);
    });

    it("relâche aussi après une restauration échouée, et le consigne", async () => {
      const id = await terminee("local");
      await service.restore(serverId, id, false);

      await rapport().restored(nodeId, id, false);
      expect(await etat()).toBeNull();
      expect(await issues()).toEqual(["backup.restore_failed"]);
    });

    it("relâche l'état quand le daemon refuse la demande", async () => {
      const id = await terminee("local");
      wings.restoreBackup.mockRejectedValueOnce(new Error("daemon injoignable"));

      await expect(service.restore(serverId, id, false)).rejects.toThrow("daemon injoignable");
      expect(await etat()).toBeNull();
    });

    it("refuse de restaurer un serveur déjà occupé, sans rien demander au daemon", async () => {
      const id = await terminee("local");
      await db.update(servers).set({ state: "installing" }).where(eq(servers.id, serverId));

      await expect(service.restore(serverId, id, false)).rejects.toBeInstanceOf(ConflictException);
      expect(wings.restoreBackup).not.toHaveBeenCalled();
      expect(await etat()).toBe("installing");
    });

    // Revue du lot (R1) : supprimer l'archive rendue faisait répondre 404 au
    // compte rendu de fin, que Wings ne rejoue pas ; le serveur restait bloqué.
    it.each(["local", "s3"] as const)(
      "%s : refuse de supprimer une sauvegarde pendant la restauration",
      async (disk) => {
        const id = await terminee(disk);
        await service.restore(serverId, id, false);

        await expect(service.remove(serverId, id)).rejects.toBeInstanceOf(ConflictException);
        expect(wings.deleteBackup).not.toHaveBeenCalled();
        expect(s3.discard).not.toHaveBeenCalled();
        expect(await ligne(id)).toBeDefined();

        await rapport().restored(nodeId, id, true);
        expect(await etat()).toBeNull();
        await service.remove(serverId, id);
        expect(await ligne(id)).toBeUndefined();
      },
    );

    // Revue du lot (R2) : un compte rendu perdu laissait l'état pour toujours.
    it("lève une restauration restée sans compte rendu au-delà du délai, pas avant", async () => {
      const id = await terminee("local");
      await service.restore(serverId, id, false);
      const vieillir = (ms: number) =>
        db
          .update(servers)
          .set({ updatedAt: new Date(Date.now() - ms).toISOString() })
          .where(eq(servers.id, serverId));

      await vieillir(RESTORE_STALE_MS - 60_000);
      expect(await rapport().expireStaleRestores()).toBe(0);
      expect(await etat()).toBe("restoring");

      await vieillir(RESTORE_STALE_MS + 60_000);
      expect(await rapport().expireStaleRestores()).toBe(1);
      expect(await etat()).toBeNull();

      // Le compte rendu arrivé après coup ne change plus rien.
      await rapport().restored(nodeId, id, true);
      expect(await etat()).toBeNull();
    });

    it("ne lève pas une suspension décidée pendant la restauration", async () => {
      const id = await terminee("local");
      await service.restore(serverId, id, false);
      await db.update(servers).set({ state: "suspended" }).where(eq(servers.id, serverId));

      await rapport().restored(nodeId, id, true);
      expect(await etat()).toBe("suspended");
    });

    it("n'accepte le compte rendu que du node qui héberge le serveur", async () => {
      const id = await terminee("local");
      await service.restore(serverId, id, false);
      const autre = await seedNode(db, { locationId: await seedLocation(db) });

      await expect(rapport().restored(autre, id, true)).rejects.toBeInstanceOf(NotFoundException);
      expect(await etat()).toBe("restoring");
    });
  });

  it("supprime une archive distante sans passer par le daemon, dépôt ouvert compris", async () => {
    const id = await terminee("s3", "depot-ouvert");
    await service.remove(serverId, id);

    expect(wings.deleteBackup).not.toHaveBeenCalled();
    expect(s3.discard).toHaveBeenCalledWith(`${serverId}/${id}.tar.gz`, "depot-ouvert");
    expect(await ligne(id)).toBeUndefined();
  });

  it("retire une sauvegarde locale que le node n'a plus", async () => {
    const id = await terminee("local");
    wings.deleteBackup.mockRejectedValueOnce(
      new WingsUnavailableError("N1", "HTTP 404", 404, "The requested backup was not found."),
    );

    await service.remove(serverId, id);
    expect(await ligne(id)).toBeUndefined();
  });

  /*
   * Une place restante, cinq demandes simultanées.
   *
   * Le quota était compté, puis la ligne insérée, sans rien entre les deux :
   * cinq clics (ou cinq appels d'API) à `limite - 1` lisaient tous le même
   * compte et passaient tous. Le disque du node se remplissait au-delà de ce
   * que le quota promettait de contenir.
   */
  it("n'accorde la dernière place qu'une fois, même à des demandes simultanées", async () => {
    await db.update(servers).set({ backupLimit: 3 }).where(eq(servers.id, serverId));
    await terminee("local");
    await terminee("local");

    /*
     * Le choix du lieu d'archive se fait entre le compte et l'insertion : on
     * y retient chaque demande jusqu'à ce que les cinq y soient. Toutes ont
     * alors lu le compte avant qu'aucune n'écrive — l'entrelacement exact du
     * défaut, rendu certain au lieu d'être laissé au hasard des connexions.
     */
    let arrivees = 0;
    let lacher: () => void = () => undefined;
    const toutes = new Promise<void>((resolve) => {
      lacher = resolve;
    });
    s3.isConfigured.mockImplementation(async () => {
      arrivees += 1;
      if (arrivees === 5) lacher();
      await toutes;
      return true;
    });

    const issues = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) => service.create(serverId, `Rafale ${i}`, [])),
    );

    expect(issues.filter((issue) => issue.status === "fulfilled")).toHaveLength(1);
    for (const issue of issues.filter((i) => i.status === "rejected")) {
      expect((issue as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
    }
    expect((await service.quota(serverId)).used).toBe(3);
  });

  it("garde la ligne quand le node ne répond pas", async () => {
    const id = await terminee("local");
    wings.deleteBackup.mockRejectedValueOnce(new WingsUnavailableError("N1", "délai dépassé"));

    await expect(service.remove(serverId, id)).rejects.toBeInstanceOf(WingsUnavailableError);
    expect(await ligne(id)).toBeDefined();
  });
});
