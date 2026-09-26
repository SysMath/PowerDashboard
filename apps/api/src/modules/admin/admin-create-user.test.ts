import "reflect-metadata";
import { PROVISIONAL_PASSWORD_TTL_MS, passwordStanding, verifyPassword } from "@gamedashboard/auth";
import { describe, expect, it, vi } from "vitest";
import { AdminActionsService } from "./admin-actions.service";

/**
 * Mot de passe provisoire d'un compte créé par l'administration (ASVS 2.3.1).
 *
 * `create-admin` et `reset-password` posaient déjà une échéance ; le
 * formulaire de l'administration, non : le secret qu'il affiche une fois, et
 * que l'administrateur transmet par courriel ou messagerie, restait le mot de
 * passe durable du compte.
 */
function service() {
  const inserted: Record<string, unknown>[] = [];
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        inserted.push(values);
        return { returning: async () => [{ id: "11111111-1111-4111-8111-111111111111" }] };
      },
    }),
  };
  const webhooks = { emit: vi.fn(async () => undefined) };
  const svc = new AdminActionsService(
    ...([db, {}, {}, webhooks, {}, {}] as unknown as ConstructorParameters<
      typeof AdminActionsService
    >),
  );
  return { svc, inserted };
}

const creer = (svc: AdminActionsService, withPassword: boolean) =>
  svc.createUser({
    email: "ada@gamedashboard.test",
    nameFirst: "Ada",
    nameLast: "Lovelace",
    role: "user",
    withPassword,
  });

describe("compte créé par l'administration", () => {
  it("donne au mot de passe tiré au sort une échéance de vingt-quatre heures", async () => {
    const { svc, inserted } = service();
    const avant = Date.now();

    const { temporaryPassword } = await creer(svc, true);

    const row = inserted[0] as { passwordHash: string; passwordExpiresAt: string | null };
    expect(temporaryPassword).toBeTruthy();
    expect(await verifyPassword(row.passwordHash, temporaryPassword as string)).toBe(true);
    expect(row.passwordExpiresAt).toEqual(expect.any(String));
    const echeance = new Date(row.passwordExpiresAt as string).getTime();
    expect(echeance).toBeGreaterThanOrEqual(avant + PROVISIONAL_PASSWORD_TTL_MS);
    expect(echeance).toBeLessThanOrEqual(Date.now() + PROVISIONAL_PASSWORD_TTL_MS);
    // La connexion le traite en provisoire : elle mène à son changement.
    expect(passwordStanding(row.passwordExpiresAt)).toBe("provisional");
  });

  it("ne pose aucune échéance sur un compte sans mot de passe local", async () => {
    const { svc, inserted } = service();

    const { temporaryPassword } = await creer(svc, false);

    expect(temporaryPassword).toBeNull();
    expect(inserted[0]).toMatchObject({ passwordHash: null, passwordExpiresAt: null });
  });
});
