import type { PushOutcome } from "@gamedashboard/contracts";
import { appDevices, type Database, pushOutbox } from "@gamedashboard/db";
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import { battre } from "../../common/background-tick";
import { DATABASE } from "../../common/database.provider";
import { instanceId } from "../auth/instance.controller";
import { envoyerExpo } from "./expo-push";
import { pushConfig } from "./push-config";
import { pushText } from "./push-text";
import { RelaisClient } from "./relais-client";

/** Dix secondes : une panne de serveur arrive sur le téléphone sans attendre. */
const TICK_MS = 10_000;

/** Un lot par tour, celui qu'Expo et le relais acceptent en une requête. */
export const PUSH_BATCH = 100;

/** Trois essais, une minute puis deux d'écart, puis l'envoi est abandonné. */
export const PUSH_MAX_ATTEMPTS = 3;

/** Une notification vieille d'une heure n'a plus rien d'urgent : la cloche suffit. */
const PEREMPTION = sql`interval '1 hour'`;

/**
 * Pousse la file vers les téléphones, en direct par Expo ou par le relais de
 * l'éditeur (ADR 0010). Une tâche de `battre()`, bornée : un lot par tour,
 * trois essais au plus, rien de gardé une fois l'envoi tranché. Un téléphone
 * qu'Expo ou le relais disent désinscrit perd sa poignée.
 */
@Injectable()
export class PushSenderService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PushSenderService.name);
  private timer: NodeJS.Timeout | null = null;
  private enVol = false;
  /** Remplaçable par les tests ; jamais par la configuration. */
  appel: typeof fetch = (entree, init) => fetch(entree, init);

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  onModuleInit(): void {
    this.timer = setInterval(
      () => battre(this.logger, "notifications poussées", () => this.tick()),
      TICK_MS,
    );
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.enVol) return;
    this.enVol = true;
    try {
      await this.envoyerUnLot();
    } finally {
      this.enVol = false;
    }
  }

  private async envoyerUnLot(): Promise<void> {
    const config = pushConfig();
    await this.db.delete(pushOutbox).where(sql`${pushOutbox.createdAt} < now() - ${PEREMPTION}`);
    if (config.mode === "aucune") return;

    const lot = await this.db
      .select({
        id: pushOutbox.id,
        deviceId: pushOutbox.deviceId,
        notificationId: pushOutbox.notificationId,
        type: pushOutbox.type,
        serverName: pushOutbox.serverName,
        locale: pushOutbox.locale,
        attempts: pushOutbox.attempts,
        pushMode: appDevices.pushMode,
        pushHandle: appDevices.pushHandle,
      })
      .from(pushOutbox)
      .innerJoin(appDevices, eq(appDevices.id, pushOutbox.deviceId))
      .where(lte(pushOutbox.nextAttemptAt, sql`now()`))
      .orderBy(asc(pushOutbox.createdAt))
      .limit(PUSH_BATCH);

    // Un appareil retiré, réinscrit dans un autre mode ou sans poignée
    // depuis la mise en file : rien à faire de sa ligne.
    const valables = lot.filter((ligne) => ligne.pushMode === config.mode && ligne.pushHandle);
    const caducs = lot.filter((ligne) => !valables.includes(ligne)).map((ligne) => ligne.id);
    if (caducs.length > 0) await this.db.delete(pushOutbox).where(inArray(pushOutbox.id, caducs));
    if (valables.length === 0) return;

    const messages = valables.map((ligne) => ({
      poignee: ligne.pushHandle ?? "",
      type: ligne.type,
      serveur: ligne.serverName,
      notification: ligne.notificationId,
      langue: ligne.locale === "en" ? ("en" as const) : ("fr" as const),
    }));
    let issues: PushOutcome[];
    if (config.mode === "direct" && config.expoAccessToken) {
      const instance = await instanceId(this.db);
      issues = await envoyerExpo(
        messages.map((message) => ({
          to: message.poignee,
          ...pushText(message),
          data: { instance, notification: message.notification, type: message.type },
        })),
        config.expoAccessToken,
        this.appel,
      );
    } else if (config.mode === "relais" && config.relayUrl) {
      issues = await new RelaisClient(this.db, config.relayUrl, this.appel).envoyer(messages);
    } else {
      return;
    }
    await this.trancher(valables, issues);
  }

  private async trancher(
    lot: { id: string; deviceId: string; pushHandle: string | null; attempts: number }[],
    issues: PushOutcome[],
  ): Promise<void> {
    const finies: string[] = [];
    for (const [rang, ligne] of lot.entries()) {
      const issue = issues[rang] ?? "reessayer";
      if (issue === "inconnue" && ligne.pushHandle) {
        // Désinscrit : la poignée est oubliée, sauf si le téléphone en a
        // déposé une autre entre-temps.
        await this.db
          .update(appDevices)
          .set({ pushMode: null, pushHandle: null })
          .where(
            and(eq(appDevices.id, ligne.deviceId), eq(appDevices.pushHandle, ligne.pushHandle)),
          );
      }
      if (issue !== "reessayer" || ligne.attempts + 1 >= PUSH_MAX_ATTEMPTS) {
        finies.push(ligne.id);
        continue;
      }
      await this.db
        .update(pushOutbox)
        .set({
          attempts: ligne.attempts + 1,
          nextAttemptAt: sql`now() + ${sql.raw(`interval '${60 * 2 ** ligne.attempts} seconds'`)}`,
        })
        .where(eq(pushOutbox.id, ligne.id));
    }
    if (finies.length > 0) await this.db.delete(pushOutbox).where(inArray(pushOutbox.id, finies));
    const reprises = issues.filter((issue) => issue === "reessayer").length;
    if (reprises > 0) this.logger.warn(`${reprises} notification(s) poussée(s) à reprendre.`);
  }
}
