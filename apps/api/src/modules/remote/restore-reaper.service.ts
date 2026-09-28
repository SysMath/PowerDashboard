import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { battre } from "../../common/background-tick";
import { RemoteBackupService } from "./remote-backup.service";

/** Cinq minutes : le délai est de six heures, inutile d'être plus précis. */
const TICK_MS = 5 * 60_000;

/**
 * Balayage des restaurations perdues (`RemoteBackupService.expireStaleRestores`),
 * sur le modèle des transferts perdus (`ServerTransferReaperService`).
 */
@Injectable()
export class RestoreReaperService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RestoreReaperService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(@Inject(RemoteBackupService) private readonly backups: RemoteBackupService) {}

  onModuleInit(): void {
    this.timer = setInterval(
      () =>
        battre(this.logger, "restaurations perdues", async () => {
          await this.backups.expireStaleRestores();
        }),
      TICK_MS,
    );
    // Ce minuteur ne doit pas empêcher le processus de s'arrêter.
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
