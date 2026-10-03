import { type Database, resellerBrandings, servers, users } from "@gamedashboard/db";
import { Logger } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { seedLocation, seedNode, seedServer, seedUser } from "../../test/fixtures";
import {
  createThrowawayDatabase,
  HAS_DATABASE,
  type ThrowawayDatabase,
} from "../../test/throwaway-database";
import { PlatformSettingsService } from "../admin/platform-settings.service";
import type { Mail, MailerService } from "../mail/mailer.service";
import { PushOutboxService } from "../push/push-outbox.service";
import { BrandingService } from "../reseller/branding.service";
import type { ClientWebhookEmitterService } from "../webhooks/client-webhook-emitter.service";
import { NotificationPreferencesRepository } from "./notification-preferences.repository";
import { NotificationsService } from "./notifications.service";

/**
 * Les courriels de notification portent la marque du serveur.
 *
 * Ils partaient sans nom d'expéditeur, sans lien et sans marque : le client
 * d'un revendeur recevait « Serveur injoignable » d'une adresse inconnue, et
 * devait deviner où aller voir.
 */
describe.skipIf(!HAS_DATABASE)("courriels de notification : marque (intégration)", () => {
  let throwaway: ThrowawayDatabase;
  let db: Database;
  let service: NotificationsService;
  let clientId: string;
  let revendeurId: string;
  let serverId: string;
  const send = vi.fn(async (_mail: Mail) => true);

  const envoye = async (): Promise<Mail> => {
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    return send.mock.calls[0]?.[0] as Mail;
  };
  const prevenir = () =>
    service.notify({
      userId: clientId,
      type: "server.unreachable",
      title: "Serveur injoignable",
      body: "Survie ne répond plus.",
      level: "danger",
      serverId,
    });

  beforeAll(async () => {
    Logger.overrideLogger(false);
    throwaway = await createThrowawayDatabase();
    db = throwaway.db;
    const settings = new PlatformSettingsService(db);
    await settings.save({ "brand.name": "Hébergeur", "brand.domain": "game.hebergeur.fr" });
    service = new NotificationsService(
      db,
      new NotificationPreferencesRepository(db),
      { send } as unknown as MailerService,
      { emit: async () => {} } as unknown as ClientWebhookEmitterService,
      new BrandingService(db, settings),
      new PushOutboxService(db),
    );
  }, 60_000);

  afterAll(async () => {
    await throwaway?.drop();
  });

  beforeEach(async () => {
    await db.execute(
      sql.raw(
        "truncate table notifications, reseller_brandings, servers, allocations, eggs, nests, nodes, locations, users cascade",
      ),
    );
    send.mockClear();
    clientId = await seedUser(db);
    await db
      .update(users)
      .set({ emailVerifiedAt: new Date().toISOString() })
      .where(eq(users.id, clientId));
    revendeurId = await seedUser(db);
    const nodeId = await seedNode(db, { locationId: await seedLocation(db) });
    serverId = await seedServer(db, { nodeId, ownerId: clientId });
    await db.update(servers).set({ resellerId: revendeurId }).where(eq(servers.id, serverId));
  });

  it("prend la marque et le domaine vérifié du revendeur du serveur", async () => {
    await db.insert(resellerBrandings).values({
      userId: revendeurId,
      name: "Revendeur",
      replyTo: "support@revendeur.fr",
      domain: "panel.revendeur.fr",
      domainToken: "jeton",
      domainVerifiedAt: new Date().toISOString(),
    });

    await prevenir();
    const mail = await envoye();

    expect(mail).toMatchObject({ fromName: "Revendeur", replyTo: "support@revendeur.fr" });
    expect(mail.text).toContain(`https://panel.revendeur.fr/server/${serverId}`);
  });

  it("retombe sur la plateforme tant que le domaine du revendeur n'est pas vérifié", async () => {
    await db.insert(resellerBrandings).values({
      userId: revendeurId,
      name: "Revendeur",
      domain: "panel.revendeur.fr",
      domainToken: "jeton",
    });

    await prevenir();
    const mail = await envoye();

    expect(mail).toMatchObject({ fromName: "Hébergeur", replyTo: null });
    expect(mail.text).toContain(`https://game.hebergeur.fr/server/${serverId}`);
    expect(mail.text).not.toContain("revendeur");
  });
});
