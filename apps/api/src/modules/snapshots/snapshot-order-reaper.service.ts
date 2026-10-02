import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { battre } from "../../common/background-tick";
import { SnapshotsService } from "./snapshots.service";

const TICK_MS = 60_000;

/**
 * Balayage des ordres d'instantanés restés sans compte rendu
 * (`SnapshotsService.sweep`). Un agent qui ne tire plus rien n'appelle plus
 * le panel : sans ce balayage, une restauration garderait son serveur en
 * `restoring`, et une archive laisserait sa sauvegarde « en cours ».
 */
@Injectable()
export class SnapshotOrderReaperService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SnapshotOrderReaperService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(@Inject(SnapshotsService) private readonly snapshots: SnapshotsService) {}

  onModuleInit(): void {
    this.timer = setInterval(
      () =>
        battre(this.logger, "ordres d'instantanés sans nouvelles", async () => {
          await this.snapshots.sweep();
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
