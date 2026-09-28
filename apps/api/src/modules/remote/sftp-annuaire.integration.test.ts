import { generateKeyPairSync, randomBytes } from "node:crypto";
import { hashPassword } from "@gamedashboard/auth";
import { type Database, servers, users } from "@gamedashboard/db";
import { Logger } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedLocation, seedNode, seedServer } from "../../test/fixtures";
import {
  createThrowawayDatabase,
  HAS_DATABASE,
  type ThrowawayDatabase,
} from "../../test/throwaway-database";
import type { PlatformSettingsService, SsoConfiguration } from "../admin/platform-settings.service";
import { SshKeyRepository } from "../auth/ssh-key.repository";
import { ServerSettingsService } from "../client/server-settings.service";
import type { WingsClientService } from "../wings/wings-client.service";
import { SftpAuthService } from "./sftp-auth.service";

/**
 * SFTP quand l'annuaire est obligatoire : clés SSH seulement (relecture F7,
 * choix de Matheol du 2026-09-26).
 *
 * La page de connexion refusait déjà tout mot de passe local, et le SFTP
 * l'acceptait encore : un compte retiré de l'annuaire gardait les fichiers de
 * ses serveurs tant qu'il n'était pas suspendu dans le panel.
 */

const MOT_DE_PASSE = "phrase-de-passe-solide-42";
const ANNUAIRE = { clientId: "panel" } as unknown as SsoConfiguration;

/** Clé publique ed25519 au format d'OpenSSH, tirée pour le test. */
function clePublique(): string {
  const { publicKey } = generateKeyPairSync("ed25519");
  const brute = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const chaine = (octets: Buffer) => {
    const longueur = Buffer.alloc(4);
    longueur.writeUInt32BE(octets.length);
    return Buffer.concat([longueur, octets]);
  };
  const blob = Buffer.concat([chaine(Buffer.from("ssh-ed25519")), chaine(brute)]);
  return `ssh-ed25519 ${blob.toString("base64")} camille@portable`;
}

describe.skipIf(!HAS_DATABASE)("SFTP et annuaire obligatoire (intégration)", () => {
  let throwaway: ThrowawayDatabase;
  let db: Database;
  let annuaire: SsoConfiguration | null;
  const reglages = {
    ssoConfiguration: async () => annuaire,
  } as unknown as PlatformSettingsService;

  beforeAll(async () => {
    Logger.overrideLogger(false);
    throwaway = await createThrowawayDatabase();
    db = throwaway.db;
  }, 60_000);

  afterAll(async () => {
    await throwaway?.drop();
  });

  /** Un compte avec mot de passe local et une clé, propriétaire d'un serveur. */
  async function monde() {
    const [compte] = await db
      .insert(users)
      .values({
        email: `camille-${randomBytes(4).toString("hex")}@gamedashboard.test`,
        nameFirst: "Camille",
        nameLast: "Martin",
        role: "user",
        passwordHash: await hashPassword(MOT_DE_PASSE),
        emailVerifiedAt: new Date().toISOString(),
      })
      .returning({ id: users.id, email: users.email });
    if (!compte) throw new Error("compte non créé");
    const nodeId = await seedNode(db, { locationId: await seedLocation(db) });
    const serverId = await seedServer(db, { nodeId, ownerId: compte.id });
    const [server] = await db
      .select({ shortId: servers.uuidShort })
      .from(servers)
      .where(eq(servers.id, serverId));
    const cle = clePublique();
    await new SshKeyRepository(db).add(compte.id, "Portable", cle);

    const sftp = new SftpAuthService(db, new SshKeyRepository(db), reglages);
    const essai = (type: "password" | "public_key", password: string) =>
      sftp.authenticate(nodeId, {
        type,
        username: `${compte.email}.${server?.shortId}`,
        password,
        ip: `198.51.100.${Math.floor(Math.random() * 200)}`,
      });
    return { compte, serverId, cle, essai };
  }

  it("sans annuaire obligatoire, le mot de passe et la clé ouvrent tous deux", async () => {
    annuaire = null;
    const { essai, cle } = await monde();

    expect(await essai("password", MOT_DE_PASSE)).not.toBeNull();
    expect(await essai("public_key", cle)).not.toBeNull();
  });

  it("annuaire obligatoire : le bon mot de passe est refusé, la clé ouvre encore", async () => {
    annuaire = ANNUAIRE;
    const { essai, cle, serverId, compte } = await monde();

    expect(await essai("password", MOT_DE_PASSE)).toBeNull();
    expect(await essai("public_key", cle)).toMatchObject({ server: serverId, user: compte.id });
  });

  it("l'écran SFTP du serveur annonce la règle", async () => {
    const { compte, serverId } = await monde();
    const ecran = new ServerSettingsService(db, {} as WingsClientService, reglages);

    annuaire = null;
    expect((await ecran.get(serverId, compte.email)).sftpPasswordAccepted).toBe(true);
    annuaire = ANNUAIRE;
    expect((await ecran.get(serverId, compte.email)).sftpPasswordAccepted).toBe(false);
  });
});
