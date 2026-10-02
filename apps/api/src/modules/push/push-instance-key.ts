import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import { type Database, settings } from "@gamedashboard/db";
import { eq } from "drizzle-orm";
import { decryptRowSecret, encryptRowSecret } from "../../common/row-secrets";

/** Réglage chiffré qui porte la clé privée de l'instance, auprès du relais. */
export const PUSH_INSTANCE_KEY_SETTING = "push.instance_key";

export interface InstanceKey {
  privateKey: KeyObject;
  /** Clé publique Ed25519 (SPKI DER, base64), déclarée au relais. */
  publicKey: string;
}

/**
 * La paire Ed25519 du panel auprès du relais de l'éditeur (ADR 0010) : tirée
 * la première fois qu'on la demande, puis gardée chiffrée dans les réglages
 * (contexte `settings.value:push.instance_key`, reprise par la rotation de
 * la clé maître comme tout réglage secret). L'insertion est conditionnelle :
 * deux premières lectures simultanées lisent la même clé.
 */
export async function instanceKey(db: Database): Promise<InstanceKey> {
  const read = async () => {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, PUSH_INSTANCE_KEY_SETTING))
      .limit(1);
    return typeof row?.value === "string" ? row.value : null;
  };
  let stored = await read();
  if (!stored) {
    const { privateKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    await db
      .insert(settings)
      .values({
        key: PUSH_INSTANCE_KEY_SETTING,
        value: encryptRowSecret("settings.value", PUSH_INSTANCE_KEY_SETTING, pem),
        isSecret: true,
      })
      .onConflictDoNothing({ target: settings.key });
    stored = await read();
  }
  if (!stored) throw new Error("Clé d'instance des notifications introuvable.");
  const privateKey = createPrivateKey(
    decryptRowSecret("settings.value", PUSH_INSTANCE_KEY_SETTING, stored),
  );
  const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  return { privateKey, publicKey: publicKey.toString("base64") };
}
