import { Injectable, Logger } from "@nestjs/common";

type AvantRestauration = (serverId: string, backupId: string) => Promise<unknown>;

/**
 * Ce qui se fait juste avant qu'une sauvegarde soit rendue à Wings.
 *
 * Le module des instantanés s'y inscrit pour prendre un instantané de sûreté
 * (ADR 0009). L'inscription va dans ce sens parce que l'autre ferait un
 * cycle : les instantanés dépendent de l'agent de node, qui dépend de
 * l'administration, qui importe déjà ce module.
 *
 * **Jamais bloquant** : un agent muet ou en échec ne doit pas empêcher la
 * restauration demandée. L'échec est consigné, la restauration suit.
 */
@Injectable()
export class BackupRestoreHooks {
  private readonly logger = new Logger(BackupRestoreHooks.name);
  private avant: AvantRestauration | null = null;

  register(fn: AvantRestauration): void {
    this.avant = fn;
  }

  async beforeRestore(serverId: string, backupId: string): Promise<void> {
    if (!this.avant) return;
    try {
      await this.avant(serverId, backupId);
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Instantané de sûreté avant restauration de ${backupId} : ${cause}`);
    }
  }
}
