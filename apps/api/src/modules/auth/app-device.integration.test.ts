import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import {
  APP_ACCESS_TOKEN_PREFIX,
  APP_DEVICE_SECRET_PREFIX,
  appLinkMessage,
  appPresenceMessage,
  appRefreshMessage,
} from "@gamedashboard/contracts";
import { appDevices, appLinkCodes, type Database, settings, users } from "@gamedashboard/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedUser } from "../../test/fixtures";
import {
  createThrowawayDatabase,
  HAS_DATABASE,
  type ThrowawayDatabase,
} from "../../test/throwaway-database";
import { AppDeviceRepository } from "./app-device.repository";
import { INSTANCE_ID_SETTING, instanceId } from "./instance.controller";
import { SessionRepository } from "./session.repository";

/**
 * Liaison de l'application mobile, contre une vraie base (ADR 0010).
 *
 * Chaque refus attendu de l'ADR est vérifié : code expiré, rejoué, PKCE ou
 * signature faux, secret rejoué qui retire l'appareil, durées de 30 et 90
 * jours, coupure avec les sessions, défi de présence à usage unique.
 */

interface Telephone {
  privateKey: KeyObject;
  publicKey: string;
}

function telephone(): Telephone {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    privateKey,
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

const signer = (t: Telephone, message: string) =>
  sign("sha256", Buffer.from(message, "utf8"), { key: t.privateKey, dsaEncoding: "der" }).toString(
    "base64url",
  );

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

describe.skipIf(!HAS_DATABASE)("AppDeviceRepository (intégration)", () => {
  let throwaway: ThrowawayDatabase;
  let db: Database;
  let devices: AppDeviceRepository;
  let userId: string;

  beforeAll(async () => {
    throwaway = await createThrowawayDatabase();
    db = throwaway.db;
    devices = new AppDeviceRepository(db);
  }, 60_000);

  afterAll(async () => {
    await throwaway?.drop();
  });

  beforeEach(async () => {
    await db.execute(sql.raw("truncate table users cascade"));
    userId = await seedUser(db);
  });

  /** Lie un téléphone de bout en bout et rend ce qu'il garde. */
  async function lier(t: Telephone = telephone()) {
    const { verifier, challenge } = pkce();
    const { code } = await devices.createLinkCode(userId, {
      codeChallenge: challenge,
      deviceName: "Pixel de Léa",
      platform: "android",
    });
    const signedAt = Date.now();
    const outcome = await devices.exchange({
      code,
      codeVerifier: verifier,
      publicKey: t.publicKey,
      signedAt,
      signature: signer(t, appLinkMessage({ code, publicKey: t.publicKey, signedAt })),
      ip: "203.0.113.7",
    });
    if (outcome.status !== "granted") throw new Error(`liaison ${outcome.status}`);
    return { t, code, verifier, grant: outcome.grant };
  }

  async function renouveler(t: Telephone, deviceId: string, deviceSecret: string) {
    const signedAt = Date.now();
    const secretSha256 = createHash("sha256").update(deviceSecret).digest("hex");
    return devices.refresh({
      deviceId,
      deviceSecret,
      signedAt,
      signature: signer(t, appRefreshMessage({ deviceId, secretSha256, signedAt })),
      ip: "203.0.113.8",
    });
  }

  it("lie un téléphone : jeton d'accès, secret d'appareil, compte reconnu", async () => {
    const { grant } = await lier();

    expect(grant.accessToken.startsWith(APP_ACCESS_TOKEN_PREFIX)).toBe(true);
    expect(grant.deviceSecret.startsWith(APP_DEVICE_SECRET_PREFIX)).toBe(true);
    const principal = await devices.resolveAccess(grant.accessToken, "203.0.113.7");
    expect(principal?.user.id).toBe(userId);
    expect(principal?.deviceId).toBe(grant.deviceId);
    expect(principal?.user.authMethod).toBe("app");
    expect(principal?.user.impersonator).toBeNull();

    // Rien en clair en base.
    const [ligne] = await db.select().from(appDevices).where(eq(appDevices.id, grant.deviceId));
    expect(JSON.stringify(ligne)).not.toContain(grant.accessToken);
    expect(JSON.stringify(ligne)).not.toContain(grant.deviceSecret);
  });

  it("accepte la clé publique brute d'iOS (point X9.63 de 65 octets)", async () => {
    const t = telephone();
    const brut = Buffer.from(t.publicKey, "base64").subarray(-65).toString("base64");
    const { grant } = await lier({ ...t, publicKey: brut });
    expect(await devices.resolveAccess(grant.accessToken, null)).not.toBeNull();
  });

  it("refuse un vérificateur PKCE faux sans brûler le code", async () => {
    const t = telephone();
    const { verifier, challenge } = pkce();
    const { code } = await devices.createLinkCode(userId, {
      codeChallenge: challenge,
      deviceName: "Pixel",
      platform: "android",
    });
    const signedAt = Date.now();
    const signature = signer(t, appLinkMessage({ code, publicKey: t.publicKey, signedAt }));
    const base = { code, publicKey: t.publicKey, signedAt, signature, ip: null };

    expect(await devices.exchange({ ...base, codeVerifier: pkce().verifier })).toEqual({
      status: "invalid",
    });
    // Le vrai détenteur du vérificateur passe encore.
    expect((await devices.exchange({ ...base, codeVerifier: verifier })).status).toBe("granted");
  });

  it("refuse une liaison signée par une autre clé, ou trop ancienne", async () => {
    const t = telephone();
    const autre = telephone();
    const { verifier, challenge } = pkce();
    const { code } = await devices.createLinkCode(userId, {
      codeChallenge: challenge,
      deviceName: "Pixel",
      platform: "android",
    });
    const signedAt = Date.now();
    const message = appLinkMessage({ code, publicKey: t.publicKey, signedAt });

    const parAutre = await devices.exchange({
      code,
      codeVerifier: verifier,
      publicKey: t.publicKey,
      signedAt,
      signature: signer(autre, message),
      ip: null,
    });
    expect(parAutre.status).toBe("invalid");

    const ancien = Date.now() - 10 * 60_000;
    const perime = await devices.exchange({
      code,
      codeVerifier: verifier,
      publicKey: t.publicKey,
      signedAt: ancien,
      signature: signer(t, appLinkMessage({ code, publicKey: t.publicKey, signedAt: ancien })),
      ip: null,
    });
    expect(perime.status).toBe("invalid");
  });

  it("refuse un code expiré", async () => {
    const t = telephone();
    const { verifier, challenge } = pkce();
    const { code } = await devices.createLinkCode(userId, {
      codeChallenge: challenge,
      deviceName: "Pixel",
      platform: "android",
    });
    await db.update(appLinkCodes).set({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    const signedAt = Date.now();
    const outcome = await devices.exchange({
      code,
      codeVerifier: verifier,
      publicKey: t.publicKey,
      signedAt,
      signature: signer(t, appLinkMessage({ code, publicKey: t.publicKey, signedAt })),
      ip: null,
    });
    expect(outcome.status).toBe("invalid");
  });

  it("un code présenté deux fois retire l'appareil qu'il avait créé", async () => {
    const { t, code, verifier, grant } = await lier();
    const signedAt = Date.now();
    const rejeu = await devices.exchange({
      code,
      codeVerifier: verifier,
      publicKey: t.publicKey,
      signedAt,
      signature: signer(t, appLinkMessage({ code, publicKey: t.publicKey, signedAt })),
      ip: null,
    });

    expect(rejeu).toMatchObject({ status: "replayed", deviceId: grant.deviceId });
    expect(await devices.resolveAccess(grant.accessToken, null)).toBeNull();
  });

  it("renouvelle en remplaçant le secret ; l'ancien jeton tombe", async () => {
    const { t, grant } = await lier();
    const suite = await renouveler(t, grant.deviceId, grant.deviceSecret);

    expect(suite.status).toBe("granted");
    if (suite.status !== "granted") return;
    expect(suite.grant.deviceSecret).not.toBe(grant.deviceSecret);
    expect(await devices.resolveAccess(grant.accessToken, null)).toBeNull();
    expect(await devices.resolveAccess(suite.grant.accessToken, null)).not.toBeNull();
  });

  it("un secret remplacé puis rejoué retire l'appareil", async () => {
    const { t, grant } = await lier();
    const suite = await renouveler(t, grant.deviceId, grant.deviceSecret);
    if (suite.status !== "granted") throw new Error("renouvellement refusé");

    const rejeu = await renouveler(t, grant.deviceId, grant.deviceSecret);
    expect(rejeu).toMatchObject({ status: "replayed", userId });
    expect(await devices.resolveAccess(suite.grant.accessToken, null)).toBeNull();
    // Le secret légitime ne sert plus non plus : il faut repasser par le navigateur.
    expect((await renouveler(t, grant.deviceId, suite.grant.deviceSecret)).status).toBe("invalid");
  });

  it("refuse un renouvellement signé par une autre clé, sans retirer l'appareil", async () => {
    const { grant } = await lier();
    const refus = await renouveler(telephone(), grant.deviceId, grant.deviceSecret);
    expect(refus.status).toBe("invalid");
    expect(await devices.resolveAccess(grant.accessToken, null)).not.toBeNull();
  });

  it("délie un appareil inactif depuis trente jours, et à quatre-vingt-dix jours au plus", async () => {
    const endormi = await lier();
    await db
      .update(appDevices)
      .set({ lastSeenAt: new Date(Date.now() - 31 * 86_400_000).toISOString() })
      .where(eq(appDevices.id, endormi.grant.deviceId));
    expect(
      (await renouveler(endormi.t, endormi.grant.deviceId, endormi.grant.deviceSecret)).status,
    ).toBe("invalid");

    const ancien = await lier();
    await db
      .update(appDevices)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(appDevices.id, ancien.grant.deviceId));
    expect(await devices.resolveAccess(ancien.grant.accessToken, null)).toBeNull();
    expect(
      (await renouveler(ancien.t, ancien.grant.deviceId, ancien.grant.deviceSecret)).status,
    ).toBe("invalid");

    expect(await devices.listForUser(userId)).toEqual([]);
  });

  it("refuse le jeton d'un compte suspendu", async () => {
    const { grant } = await lier();
    await db
      .update(users)
      .set({ suspendedAt: new Date().toISOString() })
      .where(eq(users.id, userId));
    expect(await devices.resolveAccess(grant.accessToken, null)).toBeNull();
  });

  it("tombe avec les sessions : mot de passe changé, « déconnecter partout »", async () => {
    const { t, grant } = await lier();
    await new SessionRepository(db).revokeOthers(userId, null);

    expect(await devices.resolveAccess(grant.accessToken, null)).toBeNull();
    expect((await renouveler(t, grant.deviceId, grant.deviceSecret)).status).toBe("invalid");
    const [ligne] = await db.select().from(appDevices).where(eq(appDevices.id, grant.deviceId));
    expect(ligne?.revokedReason).toBe("credentials");
  });

  it("se retire depuis le panel, et seulement par son titulaire", async () => {
    const { grant } = await lier();
    const autre = await seedUser(db);

    expect(await devices.revokeById(autre, grant.deviceId, "user")).toBeNull();
    expect(await devices.listForUser(userId)).toHaveLength(1);
    expect(await devices.revokeById(userId, grant.deviceId, "user")).toBe("Pixel de Léa");
    expect(await devices.listForUser(userId)).toEqual([]);
    expect(await devices.resolveAccess(grant.accessToken, null)).toBeNull();
  });

  it("confirme la présence par un défi signé, à usage unique et lié au geste", async () => {
    const { t, grant } = await lier();
    const geste = { method: "POST", path: `/api/v1/client/servers/abc/backups/def/restore` };
    const signe = (challenge: string, autreGeste = geste) =>
      `${challenge}.${signer(t, appPresenceMessage({ deviceId: grant.deviceId, challenge, ...autreGeste }))}`;

    expect(await devices.consumePresence(grant.deviceId, null, geste)).toBe(false);

    const { challenge } = await devices.issueChallenge(grant.deviceId);
    const entete = signe(challenge);
    expect(await devices.consumePresence(grant.deviceId, entete, geste)).toBe(true);
    // Rejoué : le défi est consommé.
    expect(await devices.consumePresence(grant.deviceId, entete, geste)).toBe(false);

    // Signé pour un autre geste : refusé.
    const second = await devices.issueChallenge(grant.deviceId);
    const ailleurs = { method: "DELETE", path: "/api/v1/client/servers/abc/backups/def" };
    expect(
      await devices.consumePresence(grant.deviceId, signe(second.challenge, ailleurs), geste),
    ).toBe(false);

    // Expiré : refusé.
    const troisieme = await devices.issueChallenge(grant.deviceId);
    await db
      .update(appDevices)
      .set({ challengeExpiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(appDevices.id, grant.deviceId));
    expect(await devices.consumePresence(grant.deviceId, signe(troisieme.challenge), geste)).toBe(
      false,
    );
  });

  it("tire l'identifiant d'instance une fois, puis le garde", async () => {
    await db.delete(settings).where(eq(settings.key, INSTANCE_ID_SETTING));
    const [a, b] = await Promise.all([instanceId(db), instanceId(db)]);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(b).toBe(a);
    expect(await instanceId(db)).toBe(a);
  });
});
