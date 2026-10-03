import {
  channelsFor,
  NOTIFICATION_EVENTS,
  type NotificationChannel,
  storedChannels,
} from "@gamedashboard/contracts";
import { appDevices, type Database, notificationPreferences } from "@gamedashboard/db";
import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import { DATABASE } from "../../common/database.provider";

/** Un événement, tel que l'écran du compte le présente. */
export interface NotificationPreference {
  type: string;
  group: string;
  channels: NotificationChannel[];
  /** Vrai quand le choix n'est pas offert : l'écran l'affiche verrouillé. */
  mandatory: boolean;
}

/**
 * Ce que chacun veut recevoir, et par quels moyens.
 *
 * **L'absence de ligne est un état à part entière**, et non un trou à combler :
 * elle veut dire « cet utilisateur n'a rien réglé », auquel cas le défaut du
 * catalogue s'applique. Créer une ligne par événement à l'inscription figerait
 * les défauts du jour, et les faire évoluer ensuite ne changerait plus rien
 * pour personne.
 */
@Injectable()
export class NotificationPreferencesRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Réglages effectifs, défauts compris, dans l'ordre du catalogue. */
  async forUser(userId: string): Promise<NotificationPreference[]> {
    const stored = await this.storedFor(userId);

    return NOTIFICATION_EVENTS.map((event) => ({
      type: event.type,
      group: event.group,
      channels: [...channelsFor(event.type, stored.get(event.type) ?? null)],
      mandatory: event.mandatory === true,
    }));
  }

  /**
   * Moyens à employer pour un envoi.
   *
   * Une seule lecture, et la décision est prise par le contrat : le dépôt ne
   * connaît ni les défauts ni les événements obligatoires, et n'a donc aucune
   * occasion de les interpréter autrement que l'écran.
   */
  async channelsFor(userId: string, type: string): Promise<readonly NotificationChannel[]> {
    const [row] = await this.db
      .select({ channels: notificationPreferences.channels })
      .from(notificationPreferences)
      .where(
        and(eq(notificationPreferences.userId, userId), eq(notificationPreferences.event, type)),
      )
      .limit(1);

    return channelsFor(type, row?.channels ?? null);
  }

  /**
   * Enregistre un choix.
   *
   * Les moyens inconnus sont écartés plutôt que refusés : la liste vient d'un
   * écran, elle peut porter un canal retiré depuis, et faire échouer
   * l'enregistrement entier pour cela ferait perdre les choix valides.
   *
   * Le téléphone y est toujours dit, coupé ou non (`storedChannels`) : un
   * choix enregistré ne retombe plus sur le défaut.
   *
   * Un événement obligatoire est **ignoré** en silence côté écriture — l'écran
   * ne le propose pas, et une requête forgée ne doit pas pouvoir couper une
   * annonce de suspension.
   */
  async save(userId: string, type: string, channels: readonly string[]): Promise<void> {
    const event = NOTIFICATION_EVENTS.find((candidate) => candidate.type === type);
    if (!event || event.mandatory) return;

    const values = {
      channels: storedChannels(channels),
      updatedAt: new Date().toISOString(),
    };

    await this.db
      .insert(notificationPreferences)
      .values({ userId, event: type, ...values })
      .onConflictDoUpdate({
        target: [notificationPreferences.userId, notificationPreferences.event],
        set: values,
      });
  }

  /**
   * Téléphones de ce compte qui recevront ses notifications poussées : liés,
   * valables, et inscrits dans le mode que sert le panel. L'écran le dit
   * quand il n'y en a aucun, plutôt que de laisser croire qu'ils sonneront.
   */
  async pushDevices(userId: string, mode: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(appDevices)
      .where(
        and(
          eq(appDevices.userId, userId),
          eq(appDevices.pushMode, mode),
          isNotNull(appDevices.pushHandle),
          isNull(appDevices.revokedAt),
          gt(appDevices.expiresAt, sql`now()`),
        ),
      );
    return row?.n ?? 0;
  }

  private async storedFor(userId: string): Promise<Map<string, string[]>> {
    const rows = await this.db
      .select({ event: notificationPreferences.event, channels: notificationPreferences.channels })
      .from(notificationPreferences)
      .where(eq(notificationPreferences.userId, userId));

    return new Map(rows.map((row) => [row.event, row.channels]));
  }
}
