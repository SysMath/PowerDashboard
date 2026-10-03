import { randomBytes } from "node:crypto";
import { PUSH_RELAY_SIGNATURE_HEADER } from "@gamedashboard/contracts";
import {
  appDevices,
  type Database,
  notificationPreferences,
  pushOutbox,
  pushRelayHandles,
  pushRelayInstances,
  servers,
} from "@gamedashboard/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { seedLocation, seedNode, seedServer, seedUser } from "../../test/fixtures";
import {
  createThrowawayDatabase,
  HAS_DATABASE,
  type ThrowawayDatabase,
} from "../../test/throwaway-database";
import { AppDeviceRepository } from "../auth/app-device.repository";
import { instanceId } from "../auth/instance.controller";
import type { MailerService } from "../mail/mailer.service";
import { NotificationPreferencesRepository } from "../notifications/notification-preferences.repository";
import { NotificationsService } from "../notifications/notifications.service";
import type { BrandingService } from "../reseller/branding.service";
import type { ClientWebhookEmitterService } from "../webhooks/client-webhook-emitter.service";
import { EXPO_PUSH_URL } from "./expo-push";
import { instanceKey } from "./push-instance-key";
import { PushOutboxService } from "./push-outbox.service";
import { PUSH_MAX_ATTEMPTS, PushSenderService } from "./push-sender.service";
import { RELAIS_ENVOIS_PAR_HEURE, RelaisService } from "./relais.service";
import { RelaisClient } from "./relais-client";

// La clé d'instance du panel est rangée chiffrée.
process.env.APP_SECRET_KEY ??= "clé de test des notifications poussées, jamais employée ailleurs";

/**
 * Notifications poussées, contre une vraie base (ADR 0010, lot 4).
 *
 * Ce que l'ADR exige d'être vérifié : envoi borné, jeton périmé effacé,
 * contenu sans détail ; au relais, envoi non signé ou signé par une autre
 * instance refusé, poignée d'une autre instance refusée, débit plafonné,
 * rien de gardé hormis les poignées.
 */

const JETON_A = "ExponentPushToken[appareilAAAA]";
const JETON_B = "ExponentPushToken[appareilBBBB]";
const ORIGINE = "https://1.1.1.1";

type Appel = [string | URL, RequestInit | undefined];

describe.skipIf(!HAS_DATABASE)("notifications poussées (intégration)", () => {
  let throwaway: ThrowawayDatabase;
  let db: Database;
  let notifications: NotificationsService;
  let sender: PushSenderService;
  let userId: string;
  let serverId: string;

  beforeAll(async () => {
    throwaway = await createThrowawayDatabase();
    db = throwaway.db;
    notifications = new NotificationsService(
      db,
      new NotificationPreferencesRepository(db),
      { send: async () => {}, isConfigured: async () => false } as unknown as MailerService,
      { emit: async () => {} } as unknown as ClientWebhookEmitterService,
      {
        forReseller: async () => ({ branding: { name: "Panel", replyTo: null }, domain: null }),
      } as unknown as BrandingService,
      new PushOutboxService(db),
    );
    sender = new PushSenderService(db);
  }, 60_000);

  afterAll(async () => {
    await throwaway?.drop();
  });

  beforeEach(async () => {
    await db.execute(sql.raw("truncate table users, push_relay_instances, settings cascade"));
    userId = await seedUser(db);
    const nodeId = await seedNode(db, { locationId: await seedLocation(db) });
    serverId = await seedServer(db, { nodeId, ownerId: userId });
    await db.update(servers).set({ name: "Survie" }).where(eq(servers.id, serverId));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function appareil(input: {
    mode?: string | null;
    handle?: string | null;
    revoked?: boolean;
  }): Promise<string> {
    const [row] = await db
      .insert(appDevices)
      .values({
        userId,
        name: "Pixel de Léa",
        platform: "android",
        publicKey: "cle",
        secretHash: randomBytes(16).toString("hex"),
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        lastSeenAt: new Date().toISOString(),
        pushMode: input.mode ?? null,
        pushHandle: input.handle ?? null,
        ...(input.revoked ? { revokedAt: new Date().toISOString(), revokedReason: "user" } : {}),
      })
      .returning({ id: appDevices.id });
    if (!row) throw new Error("appareil non créé");
    return row.id;
  }

  /** `notify` lance la mise en file sans l'attendre : on attend qu'elle arrive. */
  async function file(attendu: number) {
    await vi.waitFor(async () => {
      expect(await db.select().from(pushOutbox)).toHaveLength(attendu);
    });
    return db.select().from(pushOutbox);
  }

  const panne = () =>
    notifications.notify({
      userId,
      type: "server.unreachable",
      title: "Survie est injoignable",
      body: "Le node 10.0.0.4 ne répond plus depuis 14 h 02.",
      level: "danger",
      serverId,
    });

  describe("en direct", () => {
    beforeEach(() => {
      vi.stubEnv("EXPO_ACCESS_TOKEN", "jeton-editeur");
    });

    it("met en file pour les seuls téléphones valables, inscrits dans ce mode", async () => {
      await appareil({ mode: "direct", handle: JETON_A });
      await appareil({ mode: "direct", handle: JETON_B, revoked: true });
      await appareil({ mode: "relais", handle: "a".repeat(43) });
      await appareil({});

      await panne();
      const [ligne] = await file(1);
      expect(ligne?.type).toBe("server.unreachable");
      expect(ligne?.serverName).toBe("Survie");
    });

    it("ne pousse rien d'un type que le compte a coupé pour le téléphone", async () => {
      await appareil({ mode: "direct", handle: JETON_A });
      await db.insert(notificationPreferences).values({
        userId,
        event: "server.unreachable",
        channels: ["inapp", "email", "-push"],
      });
      await panne();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await db.select().from(pushOutbox)).toHaveLength(0);
    });

    it("envoie le seul contenu fermé, puis ne garde rien", async () => {
      await appareil({ mode: "direct", handle: JETON_A });
      await panne();
      await file(1);
      const appel = vi.fn(async () => Response.json({ data: [{ status: "ok", id: "x" }] }));
      sender.appel = appel as unknown as typeof fetch;

      await sender.tick();

      const [url, init] = appel.mock.calls[0] as unknown as Appel;
      expect(String(url)).toBe(EXPO_PUSH_URL);
      const [message] = JSON.parse(String(init?.body));
      expect(message.to).toBe(JETON_A);
      expect(message.title).toBe("Survie");
      expect(message.body).toBe("Serveur injoignable");
      // Le même jeton Expo sert tous les panels du téléphone : l'instance dit
      // lequel ouvrir au toucher.
      expect(message.data).toEqual({
        instance: await instanceId(db),
        notification: expect.any(String),
        type: "server.unreachable",
      });
      // Ni le titre ni le corps de la cloche : l'adresse du node n'en sort pas.
      expect(String(init?.body)).not.toContain("10.0.0.4");
      expect(await db.select().from(pushOutbox)).toHaveLength(0);
    });

    it("oublie le jeton d'un téléphone désinscrit chez Expo", async () => {
      const id = await appareil({ mode: "direct", handle: JETON_A });
      await panne();
      await file(1);
      sender.appel = (async () =>
        Response.json({
          data: [{ status: "error", details: { error: "DeviceNotRegistered" } }],
        })) as unknown as typeof fetch;

      await sender.tick();

      const [ligne] = await db.select().from(appDevices).where(eq(appDevices.id, id));
      expect(ligne?.pushHandle).toBeNull();
      expect(await db.select().from(pushOutbox)).toHaveLength(0);
    });

    it("reprend un échec passager, trois fois au plus", async () => {
      await appareil({ mode: "direct", handle: JETON_A });
      await panne();
      await file(1);
      const appel = vi.fn(async () => new Response("", { status: 503 }));
      sender.appel = appel as unknown as typeof fetch;

      for (let essai = 1; essai <= PUSH_MAX_ATTEMPTS; essai += 1) {
        await db.update(pushOutbox).set({ nextAttemptAt: sql`now()` });
        await sender.tick();
      }
      expect(appel).toHaveBeenCalledTimes(PUSH_MAX_ATTEMPTS);
      expect(await db.select().from(pushOutbox)).toHaveLength(0);
    });

    it("n'envoie rien à un appareil retiré après la mise en file", async () => {
      const id = await appareil({ mode: "direct", handle: JETON_A });
      await panne();
      await file(1);
      await new AppDeviceRepository(db).revokeById(userId, id, "user");
      const appel = vi.fn();
      sender.appel = appel as unknown as typeof fetch;

      await sender.tick();
      expect(appel).not.toHaveBeenCalled();
      expect(await db.select().from(pushOutbox)).toHaveLength(0);
    });

    it("retire un jeton à l'ancien appareil quand un autre le dépose", async () => {
      const ancien = await appareil({ mode: "direct", handle: JETON_A });
      const nouveau = await appareil({});
      await new AppDeviceRepository(db).setPush(nouveau, { mode: "direct", poignee: JETON_A });
      const lignes = await db.select().from(appDevices);
      expect(lignes.find((l) => l.id === ancien)?.pushHandle).toBeNull();
      expect(lignes.find((l) => l.id === nouveau)?.pushHandle).toBe(JETON_A);
    });
  });

  describe("par le relais", () => {
    let relais: RelaisService;
    let appelsExpo: unknown[][];

    beforeEach(() => {
      vi.stubEnv("PUSH_RELAY_URL", "https://relais.exemple.fr");
      relais = new RelaisService(db);
      appelsExpo = [];
      // Le relais lit le descripteur du panel, puis écrit à Expo.
      relais.appel = (async (url: string | URL, init?: RequestInit) => {
        if (String(url) === `${ORIGINE}/.well-known/gamedashboard`) {
          const { publicKey } = await instanceKey(db);
          return Response.json(descripteur(await instanceId(db), publicKey));
        }
        const lot = JSON.parse(String(init?.body)) as unknown[];
        appelsExpo.push(lot);
        return Response.json({ data: lot.map(() => ({ status: "ok", id: "x" })) });
      }) as typeof fetch;
      // Le panel parle au relais : ici, directement au service.
      sender.appel = (async (url: string | URL, init?: RequestInit) => {
        const corps = JSON.parse(String(init?.body));
        if (String(url).endsWith("/instances")) {
          const issue = await relais.enregistrer({ ...corps, origine: ORIGINE });
          return new Response("", { status: issue === "enregistree" ? 200 : 403 });
        }
        const signature = new Headers(init?.headers).get(PUSH_RELAY_SIGNATURE_HEADER);
        const issue = await relais.envoyer(corps, signature ?? "", "jeton-editeur");
        return issue.issue === "envoye"
          ? Response.json({ data: issue.resultats })
          : new Response("", { status: issue.issue === "inconnue" ? 404 : 401 });
      }) as typeof fetch;
    });

    const descripteur = (instance: string, cle: string) => ({
      produit: "gamedashboard",
      api: 1,
      version: null,
      version_app_minimale: "1.0.0",
      instance,
      nom: "Panel",
      origine: ORIGINE,
      notifications: "relais",
      relais: "https://relais.exemple.fr",
      cle_notifications: cle,
    });

    it("enregistre le panel, inscrit le téléphone, et pousse par sa poignée", async () => {
      const instance = await instanceId(db);
      const poignee = await (async () => {
        await new RelaisClient(db, "https://relais.exemple.fr", sender.appel).enregistrer();
        return relais.inscrire({ instance, jeton: JETON_A });
      })();
      expect(poignee).toMatch(/^[A-Za-z0-9_-]{43}$/);
      await appareil({ mode: "relais", handle: poignee });

      await panne();
      await file(1);
      await sender.tick();

      expect(appelsExpo).toHaveLength(1);
      expect(appelsExpo[0]?.[0]).toMatchObject({
        to: JETON_A,
        title: "Survie",
        data: { instance },
      });
      expect(await db.select().from(pushOutbox)).toHaveLength(0);
      // Le relais ne garde que la poignée, sous son condensat.
      const gardees = await db.select().from(pushRelayHandles);
      expect(gardees).toHaveLength(1);
      expect(JSON.stringify(gardees)).not.toContain(poignee);
    });

    it("refuse d'enregistrer une clé que le descripteur ne publie pas", async () => {
      const autre = (await import("node:crypto")).generateKeyPairSync("ed25519");
      const cle = autre.publicKey.export({ type: "spki", format: "der" }).toString("base64");
      const issue = await relais.enregistrer({
        instance: await instanceId(db),
        cle,
        origine: ORIGINE,
      });
      expect(issue).toBe("refusee");
      expect(await db.select().from(pushRelayInstances)).toHaveLength(0);
    });

    it("refuse un envoi non signé, ou signé par une autre instance", async () => {
      const client = new RelaisClient(db, "https://relais.exemple.fr", sender.appel);
      await client.enregistrer();
      const instance = await instanceId(db);
      const poignee = (await relais.inscrire({ instance, jeton: JETON_A })) ?? "";
      const envoi = {
        instance,
        horodatage: Date.now(),
        messages: [
          {
            poignee,
            type: "server.unreachable",
            serveur: "Survie",
            notification: "0b9b8f2e-4d6c-4b1e-9a51-2f3d1c0e7a11",
            langue: "fr" as const,
          },
        ],
      };
      expect((await relais.envoyer(envoi, "", "jeton-editeur")).issue).toBe("signature");
      const { sign, generateKeyPairSync } = await import("node:crypto");
      const intrus = generateKeyPairSync("ed25519").privateKey;
      const { pushRelaySignedText } = await import("@gamedashboard/contracts");
      const fausse = sign(null, Buffer.from(pushRelaySignedText(envoi)), intrus).toString("base64");
      expect((await relais.envoyer(envoi, fausse, "jeton-editeur")).issue).toBe("signature");
      expect(appelsExpo).toHaveLength(0);
    });

    it("refuse qu'une instance écrive à la poignée d'une autre", async () => {
      // Une autre instance, enregistrée directement, avec son téléphone.
      await db.insert(pushRelayInstances).values({ instance: "autre-instance", publicKey: "x" });
      const etrangere =
        (await relais.inscrire({ instance: "autre-instance", jeton: JETON_B })) ?? "";
      await new RelaisClient(db, "https://relais.exemple.fr", sender.appel).enregistrer();
      await appareil({ mode: "relais", handle: etrangere });

      await panne();
      await file(1);
      await sender.tick();

      expect(appelsExpo).toHaveLength(0);
      // Le panel apprend que la poignée ne vaut rien ici, et l'oublie.
      const [ligne] = await db.select().from(appDevices);
      expect(ligne?.pushHandle).toBeNull();
    });

    it("refuse un envoi rejoué ou trop ancien, et plafonne le débit", async () => {
      const client = new RelaisClient(db, "https://relais.exemple.fr", sender.appel);
      await client.enregistrer();
      const instance = await instanceId(db);
      const poignee = (await relais.inscrire({ instance, jeton: JETON_A })) ?? "";
      const { sign } = await import("node:crypto");
      const { pushRelaySignedText } = await import("@gamedashboard/contracts");
      const { privateKey } = await instanceKey(db);
      const signer = (horodatage: number, nombre = 1) => {
        const envoi = {
          instance,
          horodatage,
          messages: Array.from({ length: nombre }, () => ({
            poignee,
            type: "server.unreachable",
            serveur: "Survie",
            notification: "0b9b8f2e-4d6c-4b1e-9a51-2f3d1c0e7a11",
            langue: "fr" as const,
          })),
        };
        return {
          envoi,
          signature: sign(null, Buffer.from(pushRelaySignedText(envoi)), privateKey).toString(
            "base64",
          ),
        };
      };

      const premier = signer(Date.now());
      expect((await relais.envoyer(premier.envoi, premier.signature, "j")).issue).toBe("envoye");
      expect((await relais.envoyer(premier.envoi, premier.signature, "j")).issue).toBe("rejoue");
      const ancien = signer(Date.now() - 10 * 60_000);
      expect((await relais.envoyer(ancien.envoi, ancien.signature, "j")).issue).toBe("perime");

      let refuse = false;
      for (let tour = 0; tour < RELAIS_ENVOIS_PAR_HEURE / 100 + 1 && !refuse; tour += 1) {
        const lot = signer(Date.now() + tour, 100);
        refuse = (await relais.envoyer(lot.envoi, lot.signature, "j")).issue === "debit";
      }
      expect(refuse).toBe(true);
    });
  });
});
