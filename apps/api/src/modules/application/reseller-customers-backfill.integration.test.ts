import { readFileSync } from "node:fs";
import {
  activityLogs,
  applicationKeys,
  type Database,
  resellerCustomers,
  servers,
  users,
} from "@gamedashboard/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedLocation, seedNode, seedServer, seedUser } from "../../test/fixtures";
import {
  createThrowawayDatabase,
  HAS_DATABASE,
  type ThrowawayDatabase,
} from "../../test/throwaway-database";

/**
 * Le rattrapage de la migration 0057 : quels comptes existants reçoivent un
 * créateur.
 *
 * La migration a déjà tourné sur la base jetable, vide ; on rejoue ici son
 * `INSERT` sur un jeu de données. Il doit être **prudent** : un compte
 * rattaché à tort devient atteignable par une clé de revendeur, alors qu'un
 * compte oublié se règle depuis l'administration.
 */
const RATTRAPAGE = (() => {
  const fichier = readFileSync(
    new URL("../../../../../packages/db/migrations/0057_reseller_customers.sql", import.meta.url),
    "utf8",
  );
  const insertion = fichier
    .split("--> statement-breakpoint")
    .find((bloc) => bloc.includes('INSERT INTO "reseller_customers"'));
  if (!insertion) throw new Error("Rattrapage introuvable dans la migration 0057.");
  return insertion;
})();

describe.skipIf(!HAS_DATABASE)(
  "rattrapage des créateurs de comptes, migration 0057 (intégration)",
  () => {
    let throwaway: ThrowawayDatabase;
    let db: Database;
    let nodeId: string;

    beforeAll(async () => {
      throwaway = await createThrowawayDatabase();
      db = throwaway.db;
    }, 60_000);

    afterAll(async () => {
      await throwaway?.drop();
    });

    beforeEach(async () => {
      await db.execute(
        sql.raw(
          "truncate table activity_logs, application_keys, servers, allocations, eggs, nests, nodes, locations, users cascade",
        ),
      );
      nodeId = await seedNode(db, { locationId: await seedLocation(db) });
    });

    async function revendeur(): Promise<string> {
      const id = await seedUser(db);
      await db.update(users).set({ role: "reseller" }).where(eq(users.id, id));
      return id;
    }

    async function cle(name: string, resellerId: string | null): Promise<void> {
      await db.insert(applicationKeys).values({
        name,
        prefix: `gd_app_${Math.random().toString(16).slice(2, 10)}`,
        keyHash: "empreinte",
        scopes: ["users.write"],
        resellerId,
      });
    }

    /** La trace qu'écrit `POST /users` : l'acteur y figure par le nom de la clé. */
    async function creeParCle(name: string): Promise<string> {
      const userId = await seedUser(db);
      await db.insert(activityLogs).values({
        event: "application.user_created",
        serverId: null,
        actorId: null,
        actorType: "api_key",
        actorLabel: `application:${name}`,
        ip: null,
        properties: { userId },
        at: new Date().toISOString(),
      });
      return userId;
    }

    async function rattrape(): Promise<{ userId: string; resellerId: string; origin: string }[]> {
      await db.execute(sql.raw(RATTRAPAGE));
      return db
        .select({
          userId: resellerCustomers.userId,
          resellerId: resellerCustomers.resellerId,
          origin: resellerCustomers.origin,
        })
        .from(resellerCustomers);
    }

    it("rattache le compte créé par la clé d'un revendeur, sans serveur ou servi chez lui", async () => {
      const r = await revendeur();
      await cle("Boutique de R", r);
      const sansServeur = await creeParCle("Boutique de R");
      const servi = await creeParCle("Boutique de R");
      const id = await seedServer(db, { nodeId, ownerId: servi });
      await db.update(servers).set({ resellerId: r }).where(eq(servers.id, id));

      const lignes = await rattrape();

      expect(lignes).toHaveLength(2);
      expect(lignes).toEqual(
        expect.arrayContaining([
          { userId: sansServeur, resellerId: r, origin: "journal" },
          { userId: servi, resellerId: r, origin: "journal" },
        ]),
      );
    });

    it("ne rattache rien quand la trace est ambiguë, étrangère ou dépassée", async () => {
      const r = await revendeur();
      const confrere = await revendeur();
      // Deux clés du même nom : l'acteur ne désigne plus un revendeur.
      await cle("Boutique", r);
      await cle("Boutique", confrere);
      await creeParCle("Boutique");
      // Clé de plateforme.
      await cle("Facturation", null);
      await creeParCle("Facturation");
      // Clé supprimée depuis.
      await creeParCle("Ancienne boutique");
      // Compte devenu administrateur.
      await cle("Boutique de R", r);
      const promu = await creeParCle("Boutique de R");
      await db.update(users).set({ role: "admin" }).where(eq(users.id, promu));
      // Compte servi ailleurs depuis.
      const serviAilleurs = await creeParCle("Boutique de R");
      const id = await seedServer(db, { nodeId, ownerId: serviAilleurs });
      await db.update(servers).set({ resellerId: confrere }).where(eq(servers.id, id));
      // Compte inscrit de lui-même : aucune trace.
      await seedUser(db);

      expect(await rattrape()).toEqual([]);
    });

    /** Une suppression de compte consignée, `delaiMs` après maintenant. */
    async function suppression(
      event: "admin.user_deleted" | "application.user_deleted",
      actorLabel: string,
      delaiMs = 1_000,
    ): Promise<void> {
      await db.insert(activityLogs).values({
        event,
        serverId: null,
        actorId: null,
        actorType: event === "admin.user_deleted" ? "user" : "api_key",
        actorLabel,
        ip: null,
        properties: { userId: "00000000-0000-4000-8000-000000000000" },
        at: new Date(Date.now() + delaiMs).toISOString(),
      });
    }

    it("une clé du même nom créée après la trace n'hérite pas des comptes d'un revendeur supprimé", async () => {
      // R1 a créé le compte avec sa clé « WHMCS », puis R1 a été supprimé : sa
      // clé est partie en cascade. Il ne reste que la trace.
      await creeParCle("WHMCS");
      await new Promise((resolve) => setTimeout(resolve, 20));
      // R2 déclare ensuite sa propre clé « WHMCS ».
      await cle("WHMCS", await revendeur());

      expect(await rattrape()).toEqual([]);
    });

    it("deux clés homonymes en même temps, celle du créateur supprimée depuis : rien", async () => {
      const r1 = await revendeur();
      const r2 = await revendeur();
      await cle("WHMCS", r1);
      await cle("WHMCS", r2);
      await creeParCle("WHMCS");
      // L'administration supprime R1, et sa clé avec lui.
      await suppression("admin.user_deleted", "admin@exemple.fr");
      await db.delete(applicationKeys).where(eq(applicationKeys.resellerId, r1));

      expect(await rattrape()).toEqual([]);
    });

    it("une suppression par une clé qui n'est que de revendeur ne bloque rien ; par la plateforme, si", async () => {
      const r = await revendeur();
      await cle("Boutique de R", r);
      const compte = await creeParCle("Boutique de R");
      // La boutique supprime un autre de ses clients : elle ne peut pas
      // supprimer un revendeur.
      await suppression("application.user_deleted", "application:Boutique de R");

      expect(await rattrape()).toEqual([{ userId: compte, resellerId: r, origin: "journal" }]);

      await db.delete(resellerCustomers);
      await cle("Facturation", null);
      await suppression("application.user_deleted", "application:Facturation", 2_000);
      expect(await rattrape()).toEqual([]);
    });

    it("ne touche pas un rattachement déjà posé, et se rejoue sans effet", async () => {
      const r = await revendeur();
      await cle("Boutique de R", r);
      const compte = await creeParCle("Boutique de R");
      await db.insert(resellerCustomers).values({ userId: compte, resellerId: r, origin: "api" });

      const premier = await rattrape();
      const second = await rattrape();

      expect(premier).toEqual([{ userId: compte, resellerId: r, origin: "api" }]);
      expect(second).toEqual(premier);
    });
  },
);
