import "reflect-metadata";
import { randomBytes } from "node:crypto";
import { type Database, settings, users } from "@gamedashboard/db";
import { type CanActivate, type ExecutionContext, ForbiddenException } from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sousDomainesInertes } from "../../test/sous-domaines";
import {
  createThrowawayDatabase,
  HAS_DATABASE,
  type ThrowawayDatabase,
} from "../../test/throwaway-database";
import type { DenialLogService } from "../activity/denial-log.service";
import { ApiKeyRepository } from "../auth/api-key.repository";
import { IMPERSONATION_TTL_MS } from "../auth/impersonation";
import { SessionGuard, sessionCookie } from "../auth/session.guard";
import { SessionRepository } from "../auth/session.repository";
import { TwoFactorRepository } from "../auth/two-factor.repository";
import type { S3Service } from "../storage/s3.service";
import type { WebhookEmitterService } from "../webhooks/webhook-emitter.service";
import type { WingsClientService } from "../wings/wings-client.service";
import { WingsTokenService } from "../wings/wings-token.service";
import { AdminController } from "./admin.controller";
import { AdminGuard } from "./admin.guard";
import { AdminActionsService } from "./admin-actions.service";
import { AdminWriteGuard } from "./admin-write.guard";
import { PlatformSettingsService } from "./platform-settings.service";
import { StaffTwoFactorGuard } from "./staff-2fa.guard";

/**
 * Doute D-5 du rapport ASVS : une session empruntée dont la cible est promue.
 *
 * La prise en main ne s'ouvre que sur un compte client, et la session porte le
 * rôle **du client**, relu à chaque requête. Qu'un second administrateur le
 * promeuve pendant les trente minutes de l'emprunt, et la session empruntée
 * devient celle d'un administrateur : l'agent écrirait dans `/admin` sous le
 * nom de la cible, sans rien qui le dise au journal.
 *
 * Le test joue la vraie chaîne de gardes d'une route d'écriture, lue sur le
 * contrôleur, contre une vraie base.
 */
describe.skipIf(!HAS_DATABASE)("session empruntée d'un compte promu (intégration)", () => {
  let throwaway: ThrowawayDatabase;
  let db: Database;
  let sessions: SessionRepository;
  let chain: CanActivate[];

  beforeAll(async () => {
    throwaway = await createThrowawayDatabase();
    db = throwaway.db;
    sessions = new SessionRepository(db);

    const instances = new Map<unknown, CanActivate>([
      [SessionGuard, new SessionGuard(sessions, new ApiKeyRepository(db))],
      // Le journal des refus se tait : le sujet est la réponse du garde.
      [AdminGuard, new AdminGuard({ record: async () => {} } as unknown as DenialLogService)],
      [
        StaffTwoFactorGuard,
        new StaffTwoFactorGuard(new PlatformSettingsService(db), new TwoFactorRepository(db)),
      ],
      [AdminWriteGuard, new AdminWriteGuard()],
    ]);
    const declared = [
      ...(Reflect.getMetadata(GUARDS_METADATA, AdminController) ?? []),
      ...(Reflect.getMetadata(GUARDS_METADATA, AdminController.prototype.setFlag) ?? []),
    ] as unknown[];
    chain = declared.map((guard) => {
      const instance = instances.get(guard);
      if (!instance) throw new Error(`garde non préparé : ${String(guard)}`);
      return instance;
    });

    /*
     * Seconde preuve du personnel **désactivée** ici, à dessein : exigée, elle
     * refuserait la cible (sans second facteur) et le test passerait pour une
     * raison qui n'est pas la sienne. Ce qui doit tenir, c'est qu'une session
     * empruntée n'entre pas dans l'administration, quel que soit ce réglage.
     */
    await db.insert(settings).values({ key: "security.staffRequires2fa", value: false });
  }, 60_000);

  afterAll(async () => {
    await throwaway?.drop();
  });

  async function account(role: "admin" | "user") {
    const [row] = await db
      .insert(users)
      .values({
        email: `compte-${randomBytes(4).toString("hex")}@gamedashboard.test`,
        nameFirst: "Camille",
        nameLast: "Martin",
        role,
        emailVerifiedAt: new Date().toISOString(),
      })
      .returning({ id: users.id });
    if (!row) throw new Error("compte non créé");
    return row.id;
  }

  async function passes(token: string): Promise<void> {
    const request = {
      method: "POST",
      cookies: { [sessionCookie()]: token },
      headers: {},
      ip: "203.0.113.7",
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    // Comme Nest : un garde qui rend `false` produit un 403.
    for (const guard of chain) {
      if (!(await guard.canActivate(context))) throw new ForbiddenException();
    }
  }

  it("refuse l'écriture admin d'une session empruntée dont la cible a été promue", async () => {
    const agent = await account("admin");
    const confrere = await account("admin");
    const client = await account("user");

    const token = await sessions.create(client, {
      authMethod: "impersonation",
      impersonatorId: agent,
      ttlMs: IMPERSONATION_TTL_MS,
    });

    const actions = new AdminActionsService(
      db,
      {} as WingsClientService,
      sessions,
      { emit: async () => undefined } as unknown as WebhookEmitterService,
      new WingsTokenService(db),
      {} as S3Service,
      sousDomainesInertes(),
    );
    await actions.setUserRole(confrere, client, "admin");

    // Témoin : une session ordinaire du même compte, désormais administrateur,
    // passe la même chaîne. Le refus attendu vient bien de l'emprunt.
    await expect(passes(await sessions.create(client, {}))).resolves.toBeUndefined();
    await expect(passes(token)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
