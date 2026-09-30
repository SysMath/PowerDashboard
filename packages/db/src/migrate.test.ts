import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it } from "vitest";
import { adaptStatements, readMigrations } from "./migrate";

/**
 * Le migrateur compatible, sans base : ce qu'il lit, et ce qu'il réécrit
 * pour un PostgreSQL ancien. Le passage sur un vrai serveur est dans
 * `apps/api/src/common/migrate.integration.test.ts`.
 */

const DOSSIER = fileURLToPath(new URL("../migrations", import.meta.url));
const fichier = (tag: string) => readFileSync(`${DOSSIER}/${tag}.sql`, "utf8");

describe("readMigrations", () => {
  it("lit comme drizzle-orm : mêmes empreintes, mêmes dates, mêmes morceaux", () => {
    // Une empreinte ou une date qui diffère, et une base migrée par l'un
    // rejouerait tout avec l'autre.
    const drizzle = readMigrationFiles({ migrationsFolder: DOSSIER });
    const nous = readMigrations(DOSSIER);
    expect(
      nous.map(({ hash, folderMillis, statements }) => ({ hash, folderMillis, statements })),
    ).toEqual(
      drizzle.map(({ hash, folderMillis, sql }) => ({ hash, folderMillis, statements: sql })),
    );
  });
});

describe("adaptStatements", () => {
  const declencheur = fichier("0025_activity_logs_append_only");
  const enumeration = fichier("0030_oauth_identity_split");

  it("ne touche à rien sur un serveur récent", () => {
    expect(adaptStatements([declencheur, enumeration], 160004)).toEqual({
      outside: [],
      inside: [declencheur, enumeration],
    });
  });

  it("avant 11, écrit EXECUTE PROCEDURE, que ces serveurs connaissent", () => {
    const { inside } = adaptStatements([declencheur], 100023);
    expect(inside[0]).toContain("FOR EACH ROW EXECUTE PROCEDURE activity_logs_append_only()");
    expect(inside[0]).not.toMatch(/EXECUTE\s+FUNCTION/i);
    expect(adaptStatements([declencheur], 110000).inside[0]).toBe(declencheur);
  });

  it("avant 12, joue ADD VALUE hors transaction, même précédé de commentaires", () => {
    expect(adaptStatements([enumeration], 90622)).toEqual({ outside: [enumeration], inside: [] });
    expect(adaptStatements([enumeration], 110000).outside).toEqual([enumeration]);
    expect(adaptStatements([enumeration], 120000).outside).toEqual([]);
  });

  it("laisse dans la transaction un morceau qui fait autre chose qu'ajouter une valeur", () => {
    const melange = `ALTER TYPE "role" ADD VALUE 'x';\nUPDATE "users" SET "role" = 'x';`;
    expect(adaptStatements([melange], 90622)).toEqual({ outside: [], inside: [melange] });
  });

  it("écarte une instruction démesurée sans passer par la regex quadratique", () => {
    const longue = `ALTER TYPE ${" ".repeat(100_000)}x`;
    const debut = performance.now();
    expect(adaptStatements([longue], 90622)).toEqual({ outside: [], inside: [longue] });
    expect(performance.now() - debut).toBeLessThan(200);
  });
});
