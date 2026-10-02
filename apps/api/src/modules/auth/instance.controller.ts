import { randomUUID } from "node:crypto";
import {
  APP_MINIMUM_VERSION,
  APP_PROTOCOL_VERSION,
  type InstanceIdentity,
} from "@gamedashboard/contracts";
import { type Database, settings } from "@gamedashboard/db";
import { Controller, Get, Header, Inject } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DATABASE } from "../../common/database.provider";
import { pushConfig } from "../push/push-config";
import { instanceKey } from "../push/push-instance-key";

/** Clé de réglage de l'identifiant d'instance. */
export const INSTANCE_ID_SETTING = "instance.id";

/**
 * Identité publique de l'instance, que Next sert en descripteur à
 * `/.well-known/gamedashboard` (ADR 0010), avec le nom de la marque du
 * domaine interrogé.
 *
 * Rien de secret : l'application la lit avant toute connexion. Elle n'est pas
 * exposée au monde par nginx — seul Next la lit, par l'adresse interne de
 * l'API.
 */
@Controller("api/v1/instance")
export class InstanceController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  @Get()
  @Header("cache-control", "no-store")
  async identity(): Promise<{ data: InstanceIdentity }> {
    return {
      data: {
        produit: "gamedashboard",
        api: APP_PROTOCOL_VERSION,
        version: process.env.GAMEDASHBOARD_VERSION ?? null,
        version_app_minimale: APP_MINIMUM_VERSION,
        instance: await instanceId(this.db),
        origine: process.env.PANEL_ORIGIN ?? "http://localhost:3000",
        ...(await this.notifications()),
      },
    };
  }

  /**
   * Le chemin des notifications poussées. Par le relais, le descripteur
   * publie aussi la clé publique du panel : c'est là que le relais la lit
   * pour croire que l'instance est servie à cette origine.
   */
  private async notifications(): Promise<
    Pick<InstanceIdentity, "notifications" | "relais" | "cle_notifications">
  > {
    const config = pushConfig();
    if (config.mode !== "relais" || !config.relayUrl) return { notifications: config.mode };
    return {
      notifications: "relais",
      relais: config.relayUrl,
      cle_notifications: (await instanceKey(this.db)).publicKey,
    };
  }
}

/**
 * Identifiant de l'instance : tiré au hasard la première fois qu'on le
 * demande, puis gardé dans les réglages, jamais réutilisé.
 *
 * Il change si la base repart de zéro — un panel réinstallé — et c'est ce
 * que l'application doit voir : une adresse déjà liée qui répond avec un
 * autre identifiant n'est plus le même panel. L'insertion est
 * conditionnelle : deux premières lectures simultanées lisent la même valeur.
 */
export async function instanceId(db: Database): Promise<string> {
  const read = async () => {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, INSTANCE_ID_SETTING))
      .limit(1);
    return typeof row?.value === "string" ? row.value : null;
  };
  const existing = await read();
  if (existing) return existing;
  await db
    .insert(settings)
    .values({ key: INSTANCE_ID_SETTING, value: randomUUID() })
    .onConflictDoNothing({ target: settings.key });
  return (await read()) ?? "";
}
