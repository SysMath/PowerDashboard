import { randomBytes } from "node:crypto";
import { type Database, servers, users } from "@gamedashboard/db";
import { NotFoundException } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedLocation, seedNode, seedServer } from "../../test/fixtures";
import {
  createThrowawayDatabase,
  HAS_DATABASE,
  type ThrowawayDatabase,
} from "../../test/throwaway-database";
import type { PlatformSettingsService } from "../admin/platform-settings.service";
import { AuthTokenRepository } from "./auth-token.repository";
import { BillingSsoService } from "./billing-sso.service";

/**
 * Le lien de facturation demandé par une clé de revendeur, contre une vraie
 * base.
 *
 * Ce lien ouvre une session **complète** : tous les serveurs du compte, ses
 * clés d'API, ses clés SSH. Un revendeur ne doit donc l'obtenir que pour un
 * client qui est entièrement le sien. Il suffisait qu'un seul serveur du
 * client relève de lui pour que la session s'ouvre, et avec elle les serveurs
 * que le même client a chez un confrère ou à la plateforme (NC-01).
 *
 * Contre une vraie base parce que la règle vit dans un prédicat SQL : un
 * `null` de `reseller_id` ne se compare pas comme une valeur, et c'est
 * précisément le serveur resté à la plateforme qu'une doublure laisserait
 * passer.
 */
describe.skipIf(!HAS_DATABASE)("lien de facturation d'un revendeur (intégration)", () => {
  let throwaway: ThrowawayDatabase;
  let db: Database;
  let billing: BillingSsoService;
  let nodeId: string;

  beforeAll(async () => {
    throwaway = await createThrowawayDatabase();
    db = throwaway.db;
    billing = new BillingSsoService(db, new AuthTokenRepository(db), {
      text: async () => "panel.test",
    } as unknown as PlatformSettingsService);
  }, 60_000);

  afterAll(async () => {
    await throwaway?.drop();
  });

  beforeEach(async () => {
    await db.execute(
      sql.raw("truncate table servers, allocations, eggs, nests, nodes, locations, users cascade"),
    );
    nodeId = await seedNode(db, { locationId: await seedLocation(db) });
  });

  async function compte(role: "user" | "reseller" = "user") {
    const [row] = await db
      .insert(users)
      .values({
        email: `${role}-${randomBytes(4).toString("hex")}@gamedashboard.test`,
        nameFirst: "Camille",
        nameLast: "Martin",
        role,
        passwordHash: null,
      })
      .returning({ id: users.id });
    if (!row) throw new Error("compte non créé");
    return row.id;
  }

  /** Un serveur du client, rattaché au revendeur donné (`null` : plateforme). */
  async function serveur(ownerId: string, resellerId: string | null) {
    const id = await seedServer(db, { nodeId, ownerId });
    await db.update(servers).set({ resellerId }).where(eq(servers.id, id));
  }

  it("ouvre le compte d'un client dont tous les serveurs relèvent du revendeur", async () => {
    const revendeur = await compte("reseller");
    const client = await compte();
    await serveur(client, revendeur);
    await serveur(client, revendeur);

    const lien = await billing.issue({ userId: client }, revendeur);
    expect(lien.url).toMatch(/^https:\/\/panel\.test\/sso\/.{16,}$/);
  });

  it("refuse le client qu'un autre revendeur sert aussi", async () => {
    const revendeur = await compte("reseller");
    const confrere = await compte("reseller");
    const client = await compte();
    await serveur(client, revendeur);
    await serveur(client, confrere);

    // Même refus que pour un compte inconnu : distinguer « pas à vous » de
    // « n'existe pas » apprendrait au revendeur qui sont les clients des autres.
    await expect(billing.issue({ userId: client }, revendeur)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(billing.issue({ userId: client }, confrere)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("refuse le client qui a aussi un serveur resté à la plateforme", async () => {
    const revendeur = await compte("reseller");
    const client = await compte();
    await serveur(client, revendeur);
    await serveur(client, null);

    await expect(billing.issue({ userId: client }, revendeur)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("refuse le client qui n'a aucun serveur chez le revendeur", async () => {
    const revendeur = await compte("reseller");
    const client = await compte();
    await serveur(client, null);

    await expect(billing.issue({ userId: client }, revendeur)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("refuse le compte qui n'a encore aucun serveur, quel qu'il soit", async () => {
    // Un compte sans serveur n'est à personne : sans ce refus, n'importe quelle
    // clé de revendeur ouvrirait la session du client tout neuf d'un confrère.
    const revendeur = await compte("reseller");
    const neuf = await compte();

    await expect(billing.issue({ userId: neuf }, revendeur)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("laisse la clé de la plateforme ouvrir un client servi par plusieurs revendeurs", async () => {
    // La plateforme détient tous les serveurs : aucun périmètre à franchir.
    const client = await compte();
    await serveur(client, await compte("reseller"));
    await serveur(client, null);

    await expect(billing.issue({ userId: client }, null)).resolves.toMatchObject({
      url: expect.stringMatching(/^https:\/\/panel\.test\/sso\//),
    });
  });
  it("un identifiant illisible est un compte inconnu, jamais une erreur 500 de la base", async () => {
    for (const cle of [null, await compte("reseller")]) {
      await expect(billing.issue({ userId: "nimporte-quoi" }, cle)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    }
  });
});
