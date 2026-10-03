import { generateToken, hashToken, tokensMatch } from "@gamedashboard/auth";
import {
  APP_ACCESS_TOKEN_PREFIX,
  APP_ACCESS_TTL_MS,
  APP_DEVICE_IDLE_MS,
  APP_DEVICE_MAX_AGE_MS,
  APP_DEVICE_SECRET_PREFIX,
  APP_LINK_CODE_TTL_MS,
  APP_PRESENCE_TTL_MS,
  APP_SIGNATURE_SKEW_MS,
  type AppDeviceGrant,
  type AppDeviceSummary,
  type AppPlatform,
  type AppPushBody,
  appLinkMessage,
  appPresenceMessage,
  appRefreshMessage,
} from "@gamedashboard/contracts";
import { appDevices, appLinkCodes, type Database, users } from "@gamedashboard/db";
import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { DATABASE } from "../../common/database.provider";
import {
  canonicalPublicKey,
  freshSignature,
  importDevicePublicKey,
  pkceChallenge,
  verifyDeviceSignature,
} from "./app-device-crypto";
import type { SessionUser } from "./session.repository";

/** Pourquoi un appareil a été retiré. */
export type AppDeviceRevocation = "user" | "device" | "replay" | "credentials" | "expired";

/**
 * Issue d'un échange ou d'un renouvellement.
 *
 * `replayed` est distinct d'`invalid` : un code ou un secret présenté une
 * seconde fois a été copié, l'appareil qu'il désignait vient d'être retiré,
 * et le titulaire doit en être prévenu.
 */
export type AppGrantOutcome =
  | { status: "granted"; userId: string; deviceName: string; grant: AppDeviceGrant }
  | { status: "replayed"; userId: string; deviceId: string; deviceName: string }
  | { status: "invalid" };

export interface AppPrincipal {
  user: SessionUser;
  deviceId: string;
}

const INVALID = { status: "invalid" } as const;

/**
 * Dernière activité écrite au plus une fois par minute, comme pour une
 * session : un jeton sert à chaque requête, et l'écriture ne décrit que
 * l'inactivité, qui se compte en jours.
 */
const LAST_SEEN_PRECISION_MS = 60 * 1000;

/** Un appareil inactif depuis trente jours est délié. */
function idle(lastSeenAt: string | null, createdAt: string, now: number): boolean {
  return now - new Date(lastSeenAt ?? createdAt).getTime() > APP_DEVICE_IDLE_MS;
}

/**
 * Appareils mobiles liés (ADR 0010) : liaison, renouvellement, présence.
 *
 * Tout ce qui authentifie est ici, à côté des sessions, et rien n'en sort en
 * clair hormis au moment où on le remet à l'application.
 */
@Injectable()
export class AppDeviceRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Code d'autorisation, après que la personne a dit oui dans le navigateur.
   *
   * Les codes de plus d'un jour sont effacés au passage : ils ne servent plus
   * à rien, pas même à reconnaître un rejeu, qui se joue en secondes.
   */
  async createLinkCode(
    userId: string,
    input: { codeChallenge: string; deviceName: string; platform: AppPlatform },
  ): Promise<{ code: string; expiresAt: string }> {
    const code = generateToken();
    const expiresAt = new Date(Date.now() + APP_LINK_CODE_TTL_MS).toISOString();
    await this.db
      .delete(appLinkCodes)
      .where(lt(appLinkCodes.createdAt, new Date(Date.now() - 86_400_000).toISOString()));
    await this.db.insert(appLinkCodes).values({
      userId,
      codeHash: hashToken(code),
      codeChallenge: input.codeChallenge,
      deviceName: input.deviceName,
      platform: input.platform,
      expiresAt,
    });
    return { code, expiresAt };
  }

  /**
   * Échange un code contre un appareil.
   *
   * Dans cet ordre, et chaque étape compte : un code déjà servi retire
   * l'appareil qu'il a créé ; le vérificateur PKCE et la signature par la
   * nouvelle clé sont contrôlés **avant** de consommer le code, pour qu'un
   * tiers qui l'aurait intercepté ne puisse même pas le brûler ; la
   * consommation est conditionnelle, si bien que deux échanges simultanés
   * n'en font gagner qu'un.
   */
  async exchange(input: {
    code: string;
    codeVerifier: string;
    publicKey: string;
    appVersion?: string;
    signedAt: number;
    signature: string;
    ip: string | null;
  }): Promise<AppGrantOutcome> {
    const now = Date.now();
    const codeHash = hashToken(input.code);
    const [row] = await this.db
      .select()
      .from(appLinkCodes)
      .where(eq(appLinkCodes.codeHash, codeHash))
      .limit(1);
    if (!row) return INVALID;

    if (row.usedAt !== null) {
      if (!row.deviceId) return INVALID;
      const revoked = await this.revokeById(row.userId, row.deviceId, "replay");
      return revoked
        ? { status: "replayed", userId: row.userId, deviceId: row.deviceId, deviceName: revoked }
        : INVALID;
    }
    if (new Date(row.expiresAt).getTime() <= now) return INVALID;
    if (!tokensMatch(pkceChallenge(input.codeVerifier), row.codeChallenge)) return INVALID;

    const key = importDevicePublicKey(input.publicKey);
    if (!key || !freshSignature(input.signedAt, now, APP_SIGNATURE_SKEW_MS)) return INVALID;
    const message = appLinkMessage({
      code: input.code,
      publicKey: input.publicKey,
      signedAt: input.signedAt,
    });
    if (!verifyDeviceSignature(input.publicKey, message, input.signature)) return INVALID;

    const [owner] = await this.db
      .select({ suspendedAt: users.suspendedAt })
      .from(users)
      .where(eq(users.id, row.userId))
      .limit(1);
    if (!owner || owner.suspendedAt !== null) return INVALID;

    const fresh = newGrantSecrets(now);
    const deviceExpiresAt = new Date(now + APP_DEVICE_MAX_AGE_MS).toISOString();

    const deviceId = await this.db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(appLinkCodes)
        .set({ usedAt: new Date(now).toISOString() })
        .where(and(eq(appLinkCodes.id, row.id), isNull(appLinkCodes.usedAt)))
        .returning({ id: appLinkCodes.id });
      if (!claimed) return null;

      const [device] = await tx
        .insert(appDevices)
        .values({
          userId: row.userId,
          name: row.deviceName,
          platform: row.platform,
          appVersion: input.appVersion ?? null,
          publicKey: canonicalPublicKey(key),
          secretHash: hashToken(fresh.deviceSecret),
          accessTokenHash: hashToken(fresh.accessToken),
          accessExpiresAt: fresh.accessExpiresAt,
          lastSeenAt: new Date(now).toISOString(),
          lastIp: input.ip,
          expiresAt: deviceExpiresAt,
        })
        .returning({ id: appDevices.id });
      if (!device) return null;
      await tx.update(appLinkCodes).set({ deviceId: device.id }).where(eq(appLinkCodes.id, row.id));
      return device.id;
    });
    if (!deviceId) return INVALID;

    return {
      status: "granted",
      userId: row.userId,
      deviceName: row.deviceName,
      grant: { deviceId, ...fresh, deviceExpiresAt },
    };
  }

  /**
   * Renouvelle le jeton d'accès, et remplace le secret d'appareil.
   *
   * Le secret précédent présenté de nouveau retire l'appareil, signature ou
   * non : il ne pouvait venir que d'une copie du trousseau. L'application,
   * elle, ne renouvelle jamais deux fois en même temps.
   */
  async refresh(input: {
    deviceId: string;
    deviceSecret: string;
    appVersion?: string;
    signedAt: number;
    signature: string;
    ip: string | null;
  }): Promise<AppGrantOutcome> {
    const now = Date.now();
    const device = await this.activeDevice(input.deviceId, now);
    if (!device) return INVALID;

    const presented = hashToken(input.deviceSecret);
    if (device.previousSecretHash && tokensMatch(presented, device.previousSecretHash)) {
      const revoked = await this.revokeById(device.userId, device.id, "replay");
      return revoked
        ? { status: "replayed", userId: device.userId, deviceId: device.id, deviceName: revoked }
        : INVALID;
    }
    if (!tokensMatch(presented, device.secretHash)) return INVALID;
    if (!freshSignature(input.signedAt, now, APP_SIGNATURE_SKEW_MS)) return INVALID;
    const message = appRefreshMessage({
      deviceId: device.id,
      secretSha256: presented,
      signedAt: input.signedAt,
    });
    if (!verifyDeviceSignature(device.publicKey, message, input.signature)) return INVALID;

    const fresh = newGrantSecrets(now);
    const [updated] = await this.db
      .update(appDevices)
      .set({
        secretHash: hashToken(fresh.deviceSecret),
        previousSecretHash: presented,
        accessTokenHash: hashToken(fresh.accessToken),
        accessExpiresAt: fresh.accessExpiresAt,
        appVersion: input.appVersion ?? device.appVersion,
        lastSeenAt: new Date(now).toISOString(),
        lastIp: input.ip,
        updatedAt: new Date(now).toISOString(),
      })
      .where(and(eq(appDevices.id, device.id), eq(appDevices.secretHash, presented)))
      .returning({ id: appDevices.id });
    if (!updated) return INVALID;

    return {
      status: "granted",
      userId: device.userId,
      deviceName: device.name,
      grant: { deviceId: device.id, ...fresh, deviceExpiresAt: device.expiresAt },
    };
  }

  /**
   * Le compte derrière un jeton d'accès `gd_mob_`, ou `null`.
   *
   * Mêmes refus qu'une session : jeton expiré, appareil retiré ou trop
   * ancien, compte suspendu.
   */
  async resolveAccess(token: string, ip: string | null): Promise<AppPrincipal | null> {
    if (!token.startsWith(APP_ACCESS_TOKEN_PREFIX)) return null;
    const now = Date.now();
    const [row] = await this.db
      .select({
        deviceId: appDevices.id,
        accessExpiresAt: appDevices.accessExpiresAt,
        expiresAt: appDevices.expiresAt,
        revokedAt: appDevices.revokedAt,
        lastSeenAt: appDevices.lastSeenAt,
        suspendedAt: users.suspendedAt,
        id: users.id,
        email: users.email,
        nameFirst: users.nameFirst,
        nameLast: users.nameLast,
        role: users.role,
        locale: users.locale,
        timezone: users.timezone,
        emailVerifiedAt: users.emailVerifiedAt,
        avatarUrl: users.avatarUrl,
      })
      .from(appDevices)
      .innerJoin(users, eq(appDevices.userId, users.id))
      .where(eq(appDevices.accessTokenHash, hashToken(token)))
      .limit(1);

    if (!row || row.revokedAt !== null || row.suspendedAt !== null) return null;
    if (!row.accessExpiresAt || new Date(row.accessExpiresAt).getTime() <= now) return null;
    if (new Date(row.expiresAt).getTime() <= now) return null;

    if (!row.lastSeenAt || now - new Date(row.lastSeenAt).getTime() >= LAST_SEEN_PRECISION_MS) {
      try {
        await this.db
          .update(appDevices)
          .set({ lastSeenAt: new Date(now).toISOString(), lastIp: ip })
          .where(eq(appDevices.id, row.deviceId));
      } catch {
        // Sans conséquence : la trace se rattrapera à la requête suivante.
      }
    }

    const {
      deviceId,
      accessExpiresAt: _a,
      expiresAt: _e,
      revokedAt: _r,
      lastSeenAt: _l,
      suspendedAt: _s,
      ...user
    } = row;
    return { deviceId, user: { ...user, authMethod: "app", impersonator: null } };
  }

  /** Adresse du compte, pour nommer le titulaire au journal d'un échange public. */
  async accountEmail(userId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return row?.email ?? null;
  }

  /** Tire un défi de présence ; il remplace le précédent, s'il y en avait un. */
  async issueChallenge(deviceId: string): Promise<{ challenge: string; expiresAt: string }> {
    const challenge = generateToken();
    const expiresAt = new Date(Date.now() + APP_PRESENCE_TTL_MS).toISOString();
    await this.db
      .update(appDevices)
      .set({ challengeHash: hashToken(challenge), challengeExpiresAt: expiresAt })
      .where(eq(appDevices.id, deviceId));
    return { challenge, expiresAt };
  }

  /**
   * Vérifie une confirmation de présence (`<défi>.<signature>`) pour ce geste.
   *
   * Le défi est consommé avant la vérification, réussie ou non : il ne sert
   * qu'une fois, et un essai raté oblige à en redemander un.
   */
  async consumePresence(
    deviceId: string,
    header: string | null,
    gesture: { method: string; path: string },
  ): Promise<boolean> {
    if (!header) return false;
    const dot = header.indexOf(".");
    if (dot <= 0) return false;
    const challenge = header.slice(0, dot);
    const signature = header.slice(dot + 1);

    const [row] = await this.db
      .update(appDevices)
      .set({ challengeHash: null, challengeExpiresAt: null })
      .where(
        and(
          eq(appDevices.id, deviceId),
          eq(appDevices.challengeHash, hashToken(challenge)),
          gt(appDevices.challengeExpiresAt, sql`now()`),
        ),
      )
      .returning({ publicKey: appDevices.publicKey });
    if (!row) return false;

    const message = appPresenceMessage({ deviceId, challenge, ...gesture });
    return verifyDeviceSignature(row.publicKey, message, signature);
  }

  /** Appareils encore liés d'un compte, le plus récemment vu en tête. */
  async listForUser(userId: string): Promise<AppDeviceSummary[]> {
    const now = Date.now();
    const rows = await this.db
      .select({
        id: appDevices.id,
        name: appDevices.name,
        platform: appDevices.platform,
        appVersion: appDevices.appVersion,
        createdAt: appDevices.createdAt,
        lastSeenAt: appDevices.lastSeenAt,
        lastIp: appDevices.lastIp,
        expiresAt: appDevices.expiresAt,
      })
      .from(appDevices)
      .where(
        and(
          eq(appDevices.userId, userId),
          isNull(appDevices.revokedAt),
          sql`${appDevices.expiresAt} > now()`,
        ),
      )
      .orderBy(desc(sql`coalesce(${appDevices.lastSeenAt}, ${appDevices.createdAt})`));

    return rows
      .filter((row) => !idle(row.lastSeenAt, row.createdAt, now))
      .map((row) => ({ ...row, platform: row.platform as AppPlatform }));
  }

  /**
   * Retire un appareil du compte. Rend son nom, ou `null` si rien n'a été
   * retiré — inconnu, à quelqu'un d'autre ou déjà retiré, sans dire lequel.
   */
  async revokeById(
    userId: string,
    deviceId: string,
    reason: AppDeviceRevocation,
  ): Promise<string | null> {
    const [row] = await this.db
      .update(appDevices)
      .set(revocation(reason))
      .where(
        and(
          eq(appDevices.id, deviceId),
          eq(appDevices.userId, userId),
          isNull(appDevices.revokedAt),
        ),
      )
      .returning({ name: appDevices.name });
    return row?.name ?? null;
  }

  /** Retire tous les appareils d'un compte (mot de passe changé, compte suspendu…). */
  async revokeAll(userId: string, reason: AppDeviceRevocation): Promise<number> {
    return revokeAppDevices(this.db, userId, reason);
  }

  /**
   * Où pousser les notifications de cet appareil : son jeton Expo ou sa
   * poignée du relais, selon le mode du panel. `null` l'efface. Un jeton
   * déjà inscrit sur un autre appareil de ce panel lui est retiré : un
   * téléphone délié puis relié ne reçoit pas tout en double.
   */
  async setPush(deviceId: string, push: AppPushBody | null): Promise<void> {
    await this.db.transaction(async (tx) => {
      if (push) {
        await tx
          .update(appDevices)
          .set({ pushMode: null, pushHandle: null })
          .where(
            and(eq(appDevices.pushHandle, push.poignee), sql`${appDevices.id} <> ${deviceId}`),
          );
      }
      await tx
        .update(appDevices)
        .set({ pushMode: push?.mode ?? null, pushHandle: push?.poignee ?? null })
        .where(and(eq(appDevices.id, deviceId), isNull(appDevices.revokedAt)));
    });
  }

  /** Un appareil encore valable (ni retiré, ni trop ancien, ni endormi), ou `null`. */
  private async activeDevice(deviceId: string, now: number) {
    const [device] = await this.db
      .select()
      .from(appDevices)
      .where(and(eq(appDevices.id, deviceId), isNull(appDevices.revokedAt)))
      .limit(1);
    if (!device) return null;
    const expired =
      new Date(device.expiresAt).getTime() <= now || idle(device.lastSeenAt, device.createdAt, now);
    if (expired) {
      await this.revokeById(device.userId, device.id, "expired");
      return null;
    }
    const [owner] = await this.db
      .select({ suspendedAt: users.suspendedAt })
      .from(users)
      .where(eq(users.id, device.userId))
      .limit(1);
    return owner && owner.suspendedAt === null ? device : null;
  }
}

/**
 * Retire tous les appareils d'un compte.
 *
 * Fonction et non méthode : `SessionRepository.revokeOthers` l'appelle aussi,
 * pour que chaque chemin qui ferme les sessions (mot de passe changé ou
 * réinitialisé, compte suspendu, « déconnecter partout ») coupe les
 * appareils du même geste, sans qu'aucun de ces chemins ait à y penser.
 */
export async function revokeAppDevices(
  db: Database,
  userId: string,
  reason: AppDeviceRevocation,
): Promise<number> {
  const rows = await db
    .update(appDevices)
    .set(revocation(reason))
    .where(and(eq(appDevices.userId, userId), isNull(appDevices.revokedAt)))
    .returning({ id: appDevices.id });
  return rows.length;
}

/** Ce qu'efface un retrait : plus aucun jeton ni défi ne doit pouvoir servir. */
function revocation(reason: AppDeviceRevocation) {
  const now = new Date().toISOString();
  return {
    revokedAt: now,
    revokedReason: reason,
    accessTokenHash: null,
    accessExpiresAt: null,
    challengeHash: null,
    challengeExpiresAt: null,
    // Un appareil retiré ne reçoit plus rien, pas même ce qui était en file
    // (`PushSenderService` écarte une ligne sans poignée).
    pushMode: null,
    pushHandle: null,
    updatedAt: now,
  };
}

function newGrantSecrets(now: number) {
  return {
    accessToken: `${APP_ACCESS_TOKEN_PREFIX}${generateToken()}`,
    accessExpiresAt: new Date(now + APP_ACCESS_TTL_MS).toISOString(),
    deviceSecret: `${APP_DEVICE_SECRET_PREFIX}${generateToken()}`,
  };
}
