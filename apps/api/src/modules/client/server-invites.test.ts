import { createHash } from "node:crypto";
import type { Database } from "@gamedashboard/db";
import { ForbiddenException, GoneException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import type { PlatformSettingsService } from "../admin/platform-settings.service";
import type { MailerService } from "../mail/mailer.service";
import type { BrandingService } from "../reseller/branding.service";
import { ServerInvitesService } from "./server-invites.service";

/**
 * Les trois refus qui font tenir l'invitation par courriel.
 *
 * Le reste du service se lit : un enregistrement, un envoi, une insertion. Ces
 * trois-là sont les règles, et elles ont la particularité de **ne jamais se
 * voir quand elles fonctionnent** — un lien accepté normalement les traverse
 * sans rien afficher. Une refonte qui les supprimerait laisserait tous les
 * écrans intacts, et donnerait : un lien transféré qui ouvre l'accès à qui le
 * reçoit, une invitation qui survit au retrait des droits de son auteur, et un
 * lien périmé qui marche encore.
 */

const SERVEUR = "11111111-1111-1111-1111-111111111111";
const PROPRIETAIRE = "22222222-2222-2222-2222-222222222222";
const AUTEUR = "33333333-3333-3333-3333-333333333333";
const INVITE = "44444444-4444-4444-4444-444444444444";
const JETON = "un-jeton-assez-long-pour-passer-le-controle-de-forme";

/**
 * Base simulée qui rend, dans l'ordre, les lectures que `accept` enchaîne :
 * l'invitation, le serveur, puis les permissions de l'auteur.
 */
function service(scenario: {
  invite: Record<string, unknown>;
  ownerId?: string;
  auteurPermissions?: string[] | null;
}) {
  let lecture = 0;
  const limit = async () => {
    lecture += 1;
    if (lecture === 1) return [scenario.invite];
    if (lecture === 2) return [{ ownerId: scenario.ownerId ?? PROPRIETAIRE }];
    return scenario.auteurPermissions ? [{ permissions: scenario.auteurPermissions }] : [];
  };
  const db = {
    select: () => ({
      // Le serveur se lit sous verrou (`for share`), le reste sans.
      from: () => ({ where: () => ({ limit, for: () => ({ limit }) }) }),
    }),
    // La transaction de l'acceptation passe par la même base simulée.
    transaction: (travail: (tx: unknown) => Promise<unknown>) => travail(db),
  } as unknown as Database;

  return new ServerInvitesService(
    db,
    { isConfigured: async () => true } as unknown as MailerService,
    { text: async () => "panel.test" } as unknown as PlatformSettingsService,
    { forHost: async () => ({ name: "Test", resellerId: null }) } as unknown as BrandingService,
  );
}

/** Invitation en règle, que chaque cas dégrade sur un seul point. */
function invitation(surcharge: Record<string, unknown> = {}) {
  return {
    id: "55555555-5555-5555-5555-555555555555",
    serverId: SERVEUR,
    email: "invite@exemple.fr",
    // Le service ne compare le condensat qu'après l'avoir trouvé par index :
    // la simulation rend la ligne, la valeur doit donc correspondre au jeton.
    tokenHash: createHash("sha256").update(JETON).digest("hex"),
    permissions: ["console.read", "files.read"],
    invitedBy: AUTEUR,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    acceptedAt: null,
    ...surcharge,
  };
}

describe("acceptation d'une invitation", () => {
  it("refuse un compte dont l'adresse n'est pas celle invitée", async () => {
    const svc = service({ invite: invitation() });

    await expect(svc.accept(JETON, INVITE, "quelquun.dautre@exemple.fr")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("refuse quand l'auteur n'a plus les droits qu'il a promis", async () => {
    // L'auteur avait `files.read` en émettant ; il ne lui reste que la console.
    const svc = service({ invite: invitation(), auteurPermissions: ["console.read"] });

    await expect(svc.accept(JETON, INVITE, "invite@exemple.fr")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("accepte quand l'auteur est le propriétaire, sans regarder ses permissions", async () => {
    // Le propriétaire n'a pas de ligne dans `server_subusers` : exiger qu'il y
    // figure rendrait caduque toute invitation émise par lui, c'est-à-dire la
    // quasi-totalité.
    const svc = service({
      invite: invitation({ invitedBy: PROPRIETAIRE }),
      ownerId: PROPRIETAIRE,
    });

    // L'insertion n'est pas simulée : on s'arrête avant, et ce qui compte est
    // qu'aucun des trois refus ne soit levé jusque-là.
    await expect(svc.accept(JETON, INVITE, "invite@exemple.fr")).rejects.not.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("refuse un lien périmé", async () => {
    const svc = service({
      invite: invitation({ expiresAt: new Date(Date.now() - 1_000).toISOString() }),
    });

    await expect(svc.accept(JETON, INVITE, "invite@exemple.fr")).rejects.toBeInstanceOf(
      GoneException,
    );
  });

  it("refuse un lien déjà employé", async () => {
    const svc = service({ invite: invitation({ acceptedAt: new Date().toISOString() }) });

    await expect(svc.accept(JETON, INVITE, "invite@exemple.fr")).rejects.toBeInstanceOf(
      GoneException,
    );
  });
});
