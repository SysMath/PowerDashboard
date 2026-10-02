import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { BackupHooks } from "../client/backup-hooks";
import { SnapshotsService } from "./snapshots.service";

/**
 * Inscrit les instantanés auprès des sauvegardes : instantané de sûreté
 * avant chaque restauration, archive S3 tirée d'un instantané.
 */
@Injectable()
export class SnapshotHooks implements OnModuleInit {
  constructor(
    @Inject(BackupHooks) private readonly backups: BackupHooks,
    @Inject(SnapshotsService) private readonly snapshots: SnapshotsService,
  ) {}

  onModuleInit(): void {
    this.backups.register((serverId, backupId) =>
      this.snapshots.safetyBeforeBackupRestore(serverId, backupId),
    );
    this.backups.registerArchive((serverId, backupId) =>
      this.snapshots.archiveBackup(serverId, backupId),
    );
  }
}
