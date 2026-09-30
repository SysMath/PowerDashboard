import { decryptSecret, encryptSecret } from "@gamedashboard/auth";

/**
 * Secrets chiffrés rangés en base, liés à leur place.
 *
 * GCM authentifie le contenu d'une valeur, pas l'endroit où elle est rangée.
 * Sans contexte, qui écrit en base sans connaître la clé maître permutait deux
 * valeurs valides sans que rien le détecte : le secret TOTP de son propre
 * compte recopié sur celui d'une victime, et il passait le second facteur de
 * celle-ci avec sa propre application ; le chiffré du jeton d'un node
 * compromis recopié sur un autre node, et il s'authentifiait sous l'identité
 * de ce dernier (audit ASVS, NC-18).
 *
 * Chaque valeur est donc chiffrée avec le contexte `<table>.<colonne>:<clé>`,
 * où la clé est l'identifiant de la ligne (la clé du réglage pour
 * `settings`). Recopiée ailleurs, elle ne se relit plus.
 *
 * **Une colonne ajoutée ici s'ajoute aussi à `REKEY_TARGETS`**
 * (`rekey.ts`), avec la même table et la même clé de ligne : le test de
 * `rekey.test.ts` le vérifie. Sans quoi une rotation de la clé maître ne la
 * reprendrait pas, ou la reprendrait sous un autre contexte — illisible.
 */
export const SECRET_COLUMNS = [
  "nodes.daemon_token_enc",
  "node_agents.token_enc",
  "database_hosts.password_enc",
  "databases.password_enc",
  "user_credentials_totp.secret_enc",
  "webhooks.secret_enc",
  "application_webhooks.secret_enc",
  "settings.value",
] as const;

export type SecretColumn = (typeof SECRET_COLUMNS)[number];

/** Contexte d'une valeur : sa colonne et sa ligne. */
export function secretContext(column: SecretColumn, rowKey: string): string {
  // Une clé vide lierait toutes les valeurs de la colonne au même contexte :
  // c'est une ligne pas encore créée, pas une ligne à lier.
  if (rowKey === "") throw new Error(`Secret de ${column} sans identifiant de ligne.`);
  return `${column}:${rowKey}`;
}

/**
 * Chiffre un secret pour la ligne `rowKey` de `column`.
 *
 * L'identifiant doit exister **avant** l'écriture : pour une insertion, il se
 * tire avec `randomUUID()` et se passe à `values({ id, … })`, plutôt que
 * d'être laissé à la base.
 */
export function encryptRowSecret(column: SecretColumn, rowKey: string, plaintext: string): string {
  return encryptSecret(plaintext, undefined, secretContext(column, rowKey));
}

/**
 * Relit le secret de la ligne `rowKey` de `column`.
 *
 * Lève si la valeur a été écrite pour une autre ligne ou une autre colonne.
 * Une valeur écrite avant la liaison (`v3:` ou sans préfixe) se relit encore :
 * elle sera liée à sa prochaine écriture, ou par `scripts/rekey-secrets.mts`.
 */
export function decryptRowSecret(column: SecretColumn, rowKey: string, payload: string): string {
  return decryptSecret(payload, undefined, secretContext(column, rowKey));
}
