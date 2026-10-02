import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import type { Database } from "./client";

/**
 * Migrateur de la base, pour tout serveur depuis PostgreSQL 9.6.
 *
 * C'est celui de drizzle-orm, refait à l'identique là où cela compte : même
 * journal (`meta/_journal.json`), mêmes morceaux (`--> statement-breakpoint`),
 * même table de suivi (`drizzle.__drizzle_migrations`, empreinte SHA-256 du
 * fichier, date du journal). Une base migrée par l'un se poursuit donc avec
 * l'autre, et `drizzle-kit migrate` reste l'outil d'un serveur à soi.
 *
 * Il en diffère sur deux points, pour les hébergements mutualisés dont le
 * PostgreSQL n'a pas suivi (9.6 chez certains) :
 *
 * - **une transaction par migration**, et non une pour toutes : c'est ce qui
 *   laisse un `ALTER TYPE … ADD VALUE` se jouer hors transaction avant la
 *   version 12, et une valeur ajoutée à une énumération servir dès la
 *   migration suivante ;
 * - **des adaptations au serveur**, appliquées au texte des migrations au
 *   moment de les jouer, jamais aux fichiers : voir `adaptStatements`.
 *
 * Et il fournit les fonctions qu'un serveur ancien n'a pas encore
 * (`REMPLACANTS`) : `gen_random_uuid()` avant la version 13, que les tables
 * demandent comme valeur par défaut de leurs identifiants, et `date_bin()`
 * avant la version 14, qu'emploie l'historique des mesures.
 */

export interface Migration {
  tag: string;
  /** Empreinte SHA-256 du fichier, comme drizzle-orm la calcule. */
  hash: string;
  /** Date du journal : c'est elle qui ordonne et qui se compare. */
  folderMillis: number;
  statements: string[];
}

export function readMigrations(folder: string): Migration[] {
  const journal = JSON.parse(readFileSync(join(folder, "meta", "_journal.json"), "utf8")) as {
    entries: { tag: string; when: number }[];
  };
  return journal.entries.map((entry) => {
    const query = readFileSync(join(folder, `${entry.tag}.sql`)).toString();
    return {
      tag: entry.tag,
      hash: createHash("sha256").update(query).digest("hex"),
      folderMillis: entry.when,
      statements: query.split("--> statement-breakpoint"),
    };
  });
}

/**
 * Ce qu'un serveur ancien refuse, réécrit pour lui.
 *
 * - Avant 11 : `EXECUTE FUNCTION` n'existe pas dans `CREATE TRIGGER` ;
 *   `EXECUTE PROCEDURE`, son ancien nom, dit la même chose (et reste
 *   accepté ensuite, mais on ne touche pas à ce qui passe).
 * - Avant 12 : `ALTER TYPE … ADD VALUE` refuse de s'exécuter dans une
 *   transaction. Un tel morceau est mis à part, pour être joué avant la
 *   transaction de sa migration : sans risque, car `IF NOT EXISTS` le rend
 *   rejouable, et une valeur de plus dans une énumération ne gêne rien si la
 *   suite échoue.
 */
export function adaptStatements(
  statements: string[],
  serverVersion: number,
): { outside: string[]; inside: string[] } {
  const outside: string[] = [];
  const inside: string[] = [];
  for (const statement of statements) {
    const adapted =
      serverVersion < 110000
        ? statement.replace(/\bEXECUTE\s+FUNCTION\b/gi, "EXECUTE PROCEDURE")
        : statement;
    if (serverVersion < 120000 && isAddValueOnly(adapted)) outside.push(adapted);
    else inside.push(adapted);
  }
  return { outside, inside };
}

/** Longueur au-delà de laquelle une instruction n'est pas un simple `ADD VALUE`. */
const ADD_VALUE_MAX_LENGTH = 1024;

function isAddValueOnly(statement: string): boolean {
  const code = statement
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .trim();
  // Un `ADD VALUE` tient en une ligne. La borne garde la regex, quadratique
  // sur « ALTER TYPE » suivi de milliers d'espaces, loin de ce cas.
  if (code.length > ADD_VALUE_MAX_LENGTH) return false;
  return /^ALTER\s+TYPE\s+[^;]+\s+ADD\s+VALUE\s+[^;]+;?$/i.test(code);
}

/**
 * `gen_random_uuid()` pour un serveur antérieur à la version 13, qui ne l'a
 * qu'avec l'extension pgcrypto — qu'un compte mutualisé ne peut pas
 * installer.
 *
 * Un UUID de version 4 tiré de `random()` : pas un hasard cryptographique,
 * mais le panel ne s'en sert que comme clé primaire, jamais comme secret
 * (jetons et codes sont tirés par l'application). L'horloge et le processus
 * entrent dans le mélange pour que deux connexions ne tirent jamais la même
 * suite.
 */
export const UUID_FUNCTION = `
CREATE OR REPLACE FUNCTION public.gen_random_uuid() RETURNS uuid AS $$
  SELECT (
    substr(h, 1, 12) || '4' || substr(h, 14, 3)
    || substr('89ab', floor(random() * 4)::int + 1, 1)
    || substr(h, 18, 15)
  )::uuid
  FROM (SELECT md5(random()::text || clock_timestamp()::text || pg_backend_pid()::text) AS h) AS tirage
$$ LANGUAGE sql VOLATILE`;

/**
 * `date_bin()` pour un serveur antérieur à la version 14 : l'historique des
 * mesures d'un serveur (`server-metrics.service.ts`) range ses relevés par
 * pas de quelques minutes à quelques heures, alignés sur l'époque.
 *
 * Même calcul que l'original, en secondes pures : le pas ne dépend ni du
 * fuseau ni des changements d'heure, et la fonction reste immuable. Arrondi
 * vers le bas, y compris avant l'origine.
 */
export const DATE_BIN_FUNCTION = `
CREATE OR REPLACE FUNCTION public.date_bin(pas interval, source timestamptz, origine timestamptz)
RETURNS timestamptz AS $$
  SELECT origine + (
    floor(extract(epoch from (source - origine))::numeric / extract(epoch from pas)::numeric)
    * extract(epoch from pas)::numeric
  )::double precision * interval '1 second'
$$ LANGUAGE sql IMMUTABLE STRICT`;

/**
 * Fonctions que le panel appelle et qu'un serveur ancien n'a pas, avec leur
 * remplaçant. Chacune n'est créée que si elle manque : un serveur récent
 * garde toujours la sienne.
 */
const REMPLACANTS = [
  { signature: "gen_random_uuid()", definition: UUID_FUNCTION },
  {
    signature: "date_bin(interval, timestamp with time zone, timestamp with time zone)",
    definition: DATE_BIN_FUNCTION,
  },
];

export async function serverVersion(db: Database): Promise<number> {
  const [ligne] = await db.execute<{ server_version_num: string }>(sql`show server_version_num`);
  return Number(ligne?.server_version_num ?? 0);
}

export async function migrateDatabase(db: Database, folder: string): Promise<void> {
  const version = await serverVersion(db);
  if (version < 90600) {
    throw new Error(`PostgreSQL ${version} : la version 9.6 au moins est nécessaire.`);
  }

  for (const { signature, definition } of REMPLACANTS) {
    const [fonction] = await db.execute<{ present: boolean }>(
      sql`select to_regprocedure(${signature}) is not null as present`,
    );
    if (!fonction?.present) await db.execute(sql.raw(definition));
  }

  await db.execute(sql`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);
  const [derniere] = await db.execute<{ created_at: string | number }>(
    sql`select created_at from "drizzle"."__drizzle_migrations" order by created_at desc limit 1`,
  );

  for (const migration of readMigrations(folder)) {
    if (derniere && Number(derniere.created_at) >= migration.folderMillis) continue;
    const { outside, inside } = adaptStatements(migration.statements, version);
    for (const statement of outside) await db.execute(sql.raw(statement));
    await db.transaction(async (tx) => {
      for (const statement of inside) await tx.execute(sql.raw(statement));
      await tx.execute(
        sql`insert into "drizzle"."__drizzle_migrations" ("hash", "created_at") values (${migration.hash}, ${migration.folderMillis})`,
      );
    });
  }
}
