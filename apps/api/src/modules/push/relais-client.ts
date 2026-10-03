import { sign } from "node:crypto";
import {
  PUSH_RELAY_SIGNATURE_HEADER,
  type PushMessage,
  type PushOutcome,
  pushRelaySignedText,
} from "@gamedashboard/contracts";
import { type Database, settings } from "@gamedashboard/db";
import { eq } from "drizzle-orm";
import { instanceId } from "../auth/instance.controller";
import { instanceKey } from "./push-instance-key";

/** Réglage qui retient le relais auprès duquel ce panel s'est enregistré. */
export const PUSH_RELAY_REGISTERED_SETTING = "push.relay_registered";

const DELAI_MS = 15_000;

export type EnvoiRelais = PushMessage & { poignee: string };

/**
 * Ce panel, client du relais de l'éditeur (ADR 0010) : il s'y enregistre une
 * fois avec sa clé publique, puis signe chaque envoi. Il ne connaît que des
 * poignées, jamais un jeton Expo.
 */
export class RelaisClient {
  constructor(
    private readonly db: Database,
    private readonly url: string,
    private readonly appel: typeof fetch = fetch,
  ) {}

  /** Enregistre l'instance si ce relais ne la connaît pas encore. */
  async enregistrer(): Promise<boolean> {
    if ((await this.enregistreAupres()) === this.url) return true;
    const { publicKey } = await instanceKey(this.db);
    const reponse = await this.poster("instances", {
      instance: await instanceId(this.db),
      cle: publicKey,
    });
    if (!reponse?.ok) return false;
    await this.db
      .insert(settings)
      .values({ key: PUSH_RELAY_REGISTERED_SETTING, value: this.url })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: this.url, updatedAt: new Date().toISOString() },
      });
    return true;
  }

  /** Envoie un lot signé ; une issue par message, dans l'ordre. */
  async envoyer(messages: readonly EnvoiRelais[]): Promise<PushOutcome[]> {
    const reessayer = messages.map((): PushOutcome => "reessayer");
    if (messages.length === 0 || !(await this.enregistrer())) return reessayer;
    const envoi = {
      instance: await instanceId(this.db),
      horodatage: Date.now(),
      messages: [...messages],
    };
    const { privateKey } = await instanceKey(this.db);
    const signature = sign(null, Buffer.from(pushRelaySignedText(envoi)), privateKey);
    const reponse = await this.poster("envois", envoi, {
      [PUSH_RELAY_SIGNATURE_HEADER]: signature.toString("base64"),
    });
    if (reponse?.status === 404) {
      // Le relais a oublié l'instance (base repartie de zéro) : on se
      // réenregistrera au prochain tour.
      await this.db.delete(settings).where(eq(settings.key, PUSH_RELAY_REGISTERED_SETTING));
      return reessayer;
    }
    if (!reponse?.ok) return reessayer;
    const corps = (await reponse.json().catch(() => null)) as { data?: unknown } | null;
    const issues = Array.isArray(corps?.data) ? corps.data : [];
    return messages.map((_, rang): PushOutcome => {
      const issue = issues[rang];
      return issue === "envoyee" || issue === "inconnue" ? issue : "reessayer";
    });
  }

  private async enregistreAupres(): Promise<string | null> {
    const [row] = await this.db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, PUSH_RELAY_REGISTERED_SETTING))
      .limit(1);
    return typeof row?.value === "string" ? row.value : null;
  }

  private async poster(
    route: "instances" | "envois",
    corps: unknown,
    entetes: Record<string, string> = {},
  ): Promise<Response | null> {
    try {
      return await this.appel(`${this.url}/api/v1/relais/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", ...entetes },
        body: JSON.stringify(corps),
        signal: AbortSignal.timeout(DELAI_MS),
      });
    } catch {
      return null;
    }
  }
}
