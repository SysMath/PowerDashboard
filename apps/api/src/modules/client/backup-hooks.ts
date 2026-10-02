import { Injectable, Logger } from "@nestjs/common";

type AvantRestauration = (serverId: string, backupId: string) => Promise<unknown>;
/** Rend vrai quand l'archive sera faite ailleurs que par Wings. */
type Archivage = (serverId: string, backupId: string) => Promise<boolean>;

/**
 * Ce que le module des instantanés ajoute aux sauvegardes (ADR 0009) :
 *
 * - un instantané de sûreté juste avant qu'une sauvegarde soit rendue à
 *   Wings ;
 * - une archive S3 cohérente, tirée d'un instantané par l'agent de node, à
 *   la place de celle de Wings.
 *
 * L'inscription va dans ce sens parce que l'autre ferait un cycle : les
 * instantanés dépendent de l'agent de node, qui dépend de l'administration,
 * qui importe déjà ce module.
 *
 * **Jamais bloquant** : un agent muet ou en échec ne doit ni empêcher la
 * restauration demandée ni faire perdre la sauvegarde. L'échec est consigné,
 * et Wings fait ce qu'il faisait sans agent.
 */
@Injectable()
export class BackupHooks {
  private readonly logger = new Logger(BackupHooks.name);
  private avant: AvantRestauration | null = null;
  private archivage: Archivage | null = null;

  register(fn: AvantRestauration): void {
    this.avant = fn;
  }

  registerArchive(fn: Archivage): void {
    this.archivage = fn;
  }

  async beforeRestore(serverId: string, backupId: string): Promise<void> {
    if (!this.avant) return;
    try {
      await this.avant(serverId, backupId);
    } catch (error) {
      this.logger.warn(
        `Instantané de sûreté avant restauration de ${backupId} : ${message(error)}`,
      );
    }
  }

  /** Faux : l'archive reste à Wings, comme sans agent. */
  async archiveElsewhere(serverId: string, backupId: string): Promise<boolean> {
    if (!this.archivage) return false;
    try {
      return await this.archivage(serverId, backupId);
    } catch (error) {
      this.logger.warn(`Archive de ${backupId} par l'agent de node : ${message(error)}`);
      return false;
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
