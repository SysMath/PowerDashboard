import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/**
 * Le cœur de `scripts/rekey-secrets.mts` : relire une valeur avec l'ancienne
 * clé dérivée, la réécrire avec la nouvelle, liée à sa ligne.
 *
 * Sorti du script pour être éprouvé : le script agit sur la base en une
 * transaction, ce qui ne se teste pas sans elle, alors que tout ce qui peut
 * mal tourner côté chiffrement se joue ici.
 *
 * **N'importe pas `@gamedashboard/auth`**, pour la raison que donne le script :
 * il se lance *avant* la mise en ligne du nouveau code, et ne doit donc pas
 * dépendre de la version déployée de la bibliothèque. Le format est redit
 * ici ; le test vérifie qu'il reste celui que `decryptSecret` sait lire, et
 * que les contextes sont ceux de `row-secrets.ts`.
 */

/** Longueur du tag GCM produit par `encryptSecret`, seule acceptée à la relecture. */
const TAG_BYTES = 16;
/** Préfixe d'une valeur sans contexte, comme `FORMAT_VERSION` de `secrets.ts`. */
const UNBOUND = "v3";
/** Préfixe d'une valeur liée à sa ligne, comme `BOUND_FORMAT_VERSION` de `secrets.ts`. */
const BOUND = "v4";

export interface RekeyOptions {
  /** Clé maître d'où l'on vient. Égale à `toSecret` pour un simple changement de sel. */
  fromSecret: string;
  fromSalt: string;
  toSecret: string;
  toSalt: string;
}

export interface Rekeyer {
  /**
   * Rend la valeur rechiffrée, liée à `context` quand il est donné, ou `null`
   * s'il n'y a rien à faire : valeur déjà reprise, jamais chiffrée, ou qui ne
   * se relit pas — liée à un autre contexte, c'est-à-dire recopiée d'une
   * autre ligne, n'est pas blanchie en valeur de celle-ci.
   */
  rekey(payload: string, context?: string): string | null;
  /**
   * Vrai si la valeur est déjà sous sa forme d'arrivée : nouvelle clé, et
   * liée à `context` quand il est donné. Sépare, dans le bilan, ce qui est
   * déjà repris de ce qui ne se relit pas du tout.
   */
  isCurrent(payload: string, context?: string): boolean;
}

/** Une valeur chiffrée découpée, et si elle est liée à un contexte. */
export interface Ciphertext {
  bound: boolean;
  iv: string;
  tag: string;
  data: string;
}

/**
 * Découpe une valeur chiffrée.
 *
 * Trois formes, comme dans `decryptSecret` : `v4:iv:tag:données` (liée à sa
 * ligne), `v3:iv:tag:données` et `iv:tag:données` (antérieures, sans
 * contexte). Ne reconnaître que la forme sans préfixe laissait de côté
 * **toute** valeur écrite depuis l'introduction du préfixe : une rotation de
 * la clé maître ne reprenait alors rien, et le panel perdait ses secrets à la
 * bascule de `APP_SECRET_KEY`. Il en irait de même de la forme `v4:`.
 */
export function parseCiphertext(payload: string): Ciphertext | null {
  const split = payload.split(":");
  const prefixed = split.length === 4 && (split[0] === UNBOUND || split[0] === BOUND);
  const parts = prefixed ? split.slice(1) : split;
  if (parts.length !== 3 || parts.some((part) => part === "")) return null;
  const [iv, tag, data] = parts as [string, string, string];
  return { bound: prefixed && split[0] === BOUND, iv, tag, data };
}

export function createRekeyer(options: RekeyOptions): Rekeyer {
  const fromKey = scryptSync(options.fromSecret, options.fromSalt, 32);
  const toKey = scryptSync(options.toSecret, options.toSalt, 32);
  /**
   * Même clé des deux côtés : la reprise ne fait que **lier** les valeurs qui
   * ne le sont pas encore (NC-18). Une valeur déjà liée n'a rien à gagner à
   * être réécrite, et la laisser rend le script idempotent dans ce cas aussi.
   */
  const sameKey = fromKey.equals(toKey);

  function decryptWith(key: Buffer, value: Ciphertext, context?: string): string | null {
    try {
      // Longueur du tag imposée : sans elle, GCM accepte un tag tronqué, et
      // un chiffré forgé avec un tag de quatre octets ressortirait d'ici
      // rechiffré avec un tag complet, c'est-à-dire blanchi.
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64url"), {
        authTagLength: TAG_BYTES,
      });
      if (context !== undefined) decipher.setAAD(Buffer.from(context, "utf8"));
      decipher.setAuthTag(Buffer.from(value.tag, "base64url"));
      return (
        decipher.update(Buffer.from(value.data, "base64url")).toString("utf8") +
        decipher.final("utf8")
      );
    } catch {
      // GCM authentifie : une valeur qui ne vient pas de cette clé, ou pas de
      // cette ligne, échoue franchement au lieu de rendre des octets arbitraires.
      return null;
    }
  }

  function encryptTo(plaintext: string, context?: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", toKey, iv);
    if (context !== undefined) cipher.setAAD(Buffer.from(context, "utf8"));
    const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const parts = [iv, cipher.getAuthTag(), data].map((part) => part.toString("base64url"));
    return `${context === undefined ? UNBOUND : BOUND}:${parts.join(":")}`;
  }

  return {
    rekey(payload, context) {
      if (context === "") return null;
      const value = parseCiphertext(payload);
      if (!value) return null;

      if (value.bound) {
        // Une valeur liée ne se relit qu'avec son contexte, et n'a besoin
        // d'être réécrite que si la clé change.
        if (context === undefined || sameKey) return null;
        const clear = decryptWith(fromKey, value, context);
        return clear === null ? null : encryptTo(clear, context);
      }

      /*
       * Valeur sans contexte, écrite avant la liaison. Normalement sous
       * l'ancienne clé ; mais une rotation lancée sur une base dont une partie
       * est déjà sous la nouvelle clé sans être liée doit la lier aussi,
       * plutôt que la laisser de côté sans le dire.
       */
      const clear =
        decryptWith(fromKey, value) ??
        (context !== undefined && !sameKey ? decryptWith(toKey, value) : null);
      if (clear === null) return null;
      if (context === undefined && sameKey) return null;
      return encryptTo(clear, context);
    },

    isCurrent(payload, context) {
      const value = parseCiphertext(payload);
      if (!value || value.bound !== (context !== undefined)) return false;
      return decryptWith(toKey, value, context) !== null;
    },
  };
}

/**
 * Une colonne chiffrée à reprendre.
 *
 * `read`/`write` existent pour la seule table dont la colonne n'est pas du
 * texte : `settings.value` est du `jsonb`, et une chaîne y est stockée avec ses
 * guillemets. La lire brute donnerait `"iv:tag:données"` — trois parties, mais
 * la première commence par un guillemet, et le déchiffrement échouerait sans
 * qu'on sache pourquoi.
 */
export interface RekeyTarget {
  table: string;
  /** Colonne qui identifie la ligne, et qui entre dans le contexte. */
  key: string;
  column: string;
  where?: string;
  read?: string;
  write?: (value: string) => string;
}

/**
 * Colonnes chiffrées à reprendre.
 *
 * **Les mêmes que `SECRET_COLUMNS` de `row-secrets.ts`, avec la même clé de
 * ligne** : le contexte d'une valeur est `<table>.<colonne>:<clé>`, et une
 * reprise sous un autre contexte que celui de l'API rendrait la valeur
 * illisible. `rekey.test.ts` compare les deux listes.
 */
export const REKEY_TARGETS: readonly RekeyTarget[] = [
  { table: "nodes", key: "id", column: "daemon_token_enc" },
  // Clé de ligne : le node, la table n'ayant pas d'autre identifiant.
  { table: "node_agents", key: "node_id", column: "token_enc" },
  { table: "database_hosts", key: "id", column: "password_enc" },
  { table: "databases", key: "id", column: "password_enc" },
  { table: "user_credentials_totp", key: "id", column: "secret_enc" },
  { table: "webhooks", key: "id", column: "secret_enc" },
  { table: "application_webhooks", key: "id", column: "secret_enc" },
  {
    table: "settings",
    // La clé du réglage, et non son identifiant : c'est elle que l'API lit.
    key: "key",
    column: "value",
    where: `"is_secret" = true`,
    read: `"value" #>> '{}'`,
    write: (value) => `to_jsonb(${sqlLiteral(value)}::text)`,
  },
];

/** Contexte d'une valeur de `target` rangée sur la ligne `rowKey`. */
export function targetContext(target: RekeyTarget, rowKey: string): string {
  return `${target.table}.${target.column}:${rowKey}`;
}

/** Littéral SQL : le script compose ses requêtes à la main, table par table. */
export function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
