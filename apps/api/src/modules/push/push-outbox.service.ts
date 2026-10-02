import { pushServerName } from "@gamedashboard/contracts";
import { appDevices, type Database, pushOutbox, users } from "@gamedashboard/db";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import { DATABASE } from "../../common/database.provider";
import { pushConfig } from "./push-config";

/** Comme l'API : trente jours sans usage, et l'appareil ne reçoit plus rien. */
const INACTIF = sql`interval '30 days'`;

/**
 * Met en file les notifications à pousser vers les téléphones d'un compte.
 *
 * Seuls les appareils encore valables et inscrits dans le mode que sert le
 * panel reçoivent : une poignée de relais ne sert à rien en direct, et
 * inversement. L'envoi lui-même est l'affaire de `PushSenderService`.
 */
@Injectable()
export class PushOutboxService {
  private readonly logger = new Logger(PushOutboxService.name);

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** N'échoue jamais : la cloche est déjà écrite, le téléphone n'est qu'un doublon. */
  async enqueue(input: {
    userId: string;
    notificationId: string;
    type: string;
    serverName: string | null;
  }): Promise<number> {
    const { mode } = pushConfig();
    if (mode === "aucune") return 0;
    try {
      const appareils = await this.db
        .select({ id: appDevices.id, locale: users.locale })
        .from(appDevices)
        .innerJoin(users, eq(users.id, appDevices.userId))
        .where(
          and(
            eq(appDevices.userId, input.userId),
            eq(appDevices.pushMode, mode),
            isNotNull(appDevices.pushHandle),
            isNull(appDevices.revokedAt),
            gt(appDevices.expiresAt, sql`now()`),
            sql`coalesce(${appDevices.lastSeenAt}, ${appDevices.createdAt}) > now() - ${INACTIF}`,
          ),
        );
      if (appareils.length === 0) return 0;
      await this.db.insert(pushOutbox).values(
        appareils.map((appareil) => ({
          deviceId: appareil.id,
          notificationId: input.notificationId,
          type: input.type,
          serverName: pushServerName(input.serverName),
          locale: appareil.locale === "en" ? "en" : "fr",
        })),
      );
      return appareils.length;
    } catch (error) {
      this.logger.warn(
        `Notification « ${input.type} » non mise en file pour le téléphone — ${
          error instanceof Error ? error.message : "erreur inconnue"
        }`,
      );
      return 0;
    }
  }
}
