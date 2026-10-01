import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { BackupRestoreHooks } from "../client/backup-restore-hooks";
import { SnapshotsService } from "./snapshots.service";

/** Inscrit l'instantané de sûreté avant chaque restauration de sauvegarde. */
@Injectable()
export class SnapshotHooks implements OnModuleInit {
  constructor(
    @Inject(BackupRestoreHooks) private readonly backups: BackupRestoreHooks,
    @Inject(SnapshotsService) private readonly snapshots: SnapshotsService,
  ) {}

  onModuleInit(): void {
    this.backups.register((serverId, backupId) =>
      this.snapshots.safetyBeforeBackupRestore(serverId, backupId),
    );
  }
}
