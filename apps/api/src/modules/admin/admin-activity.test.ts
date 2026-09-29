import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import {
  ADMIN_CONTROLLERS,
  type Route,
  routeLabel,
  routesOf,
  WRITE_METHODS,
} from "../../test/routes";
import type { RecordInput } from "../activity/activity.service";
import { ResellerController } from "../reseller/reseller.controller";
import { AdminController } from "./admin.controller";

/**
 * Chaque geste d'administration laisse une trace (rapport ASVS, NC-11).
 *
 * Changement de rôle, création et suppression de compte, révocation de
 * sessions, enveloppe d'un revendeur, suspension et suppression de serveur,
 * transfert, suppression de node, parts, maintenance, réglages de la
 * plateforme : aucun ne consignait rien. Le jour où la seconde preuve du
 * personnel se retrouvait coupée, rien ne disait qui l'avait fait.
 */

/*
 * Toute route d'écriture de l'administration et de l'espace revendeur appelle
 * le journal. Contrôle lu sur le code du gestionnaire, et relevé d'office :
 * une liste tenue à la main ne verrait pas la route ajoutée ensuite.
 */
const WRITES: Route[] = [...ADMIN_CONTROLLERS, ResellerController]
  .flatMap(routesOf)
  .filter((route) => WRITE_METHODS.has(route.method));

/** `activity.record(…)`, l'aide `trace(…)`, `traceBinding(…)`, ou l'export consigné. */
const CONSIGNE = /\.record\(|\.trace\w*\(|\.exportPlatform\(/;

/*
 * Les routes dont le service écrit lui-même la ligne, et pourquoi. Le
 * changement de propriétaire l'écrit dans la transaction du changement : c'est
 * cette ligne qui cache l'ancien journal au nouveau titulaire, et elle ne doit
 * pas pouvoir manquer (`AdminServerService.setOwner`, testé dans
 * `server-owner.integration.test.ts`).
 */
const CONSIGNE_PAR_LE_SERVICE: Record<string, RegExp> = {
  "AdminController.setServerOwner": /\.setOwner\([^)]*event: "admin\.server_owner_changed"/s,
};

describe("gestes d'administration consignés", () => {
  it("relève les routes d'écriture", () => {
    expect(WRITES.length).toBeGreaterThan(60);
  });

  it.each(WRITES.map((route) => [routeLabel(route), route] as const))(
    "%s consigne son geste",
    (label, route) => {
      expect(route.handler.toString()).toMatch(CONSIGNE_PAR_LE_SERVICE[label] ?? CONSIGNE);
    },
  );
});

/* --- Ce que les lignes disent, et ce qu'elles taisent ---------------------- */

const admin = { id: "admin-1", email: "admin@gamedashboard.test", role: "admin" };
const request = { user: admin, ip: "203.0.113.7", headers: { "user-agent": "vitest" } };

/** Un service dont chaque méthode répond « rien », sauf celles qu'on précise. */
function stub(methods: Record<string, unknown> = {}): unknown {
  return new Proxy(methods, {
    get: (target, name) => {
      if (typeof name !== "string" || name === "then") return undefined;
      return name in target ? target[name] : vi.fn(async () => ({}));
    },
  });
}

/**
 * Le contrôleur, services remplacés : seuls le journal et la forme des
 * réponses comptent ici. Construit sans son constructeur, qui demande vingt
 * dépendances dont aucune n'est en jeu.
 */
function controller(services: Record<string, Record<string, unknown>> = {}) {
  const record = vi.fn(async (_: RecordInput) => undefined);
  const instance = Object.create(AdminController.prototype) as AdminController;
  // Les champs privés, posés comme le ferait le constructeur.
  const fields = instance as unknown as Record<string, unknown>;
  for (const field of [
    "adminServers",
    "actions",
    "platform",
    "transfers",
    "infrastructure",
    "branding",
  ]) {
    fields[field] = stub(services[field]);
  }
  fields.activityLog = { record };
  return { instance, record, trace: () => record.mock.calls.map(([input]) => input) };
}

describe("lignes du journal d'administration", () => {
  it("consigne un changement de rôle, avec l'ancien et le nouveau", async () => {
    const { instance, trace } = controller({
      actions: { setUserRole: async () => ({ previous: "user", email: "cible@x.test" }) },
    });
    await instance.setUserRole(request as never, "cible", { role: "admin" });
    expect(trace()).toEqual([
      expect.objectContaining({
        event: "admin.user_role_changed",
        actorId: "admin-1",
        actorLabel: "admin@gamedashboard.test",
        properties: { userId: "cible", account: "cible@x.test", from: "user", to: "admin" },
      }),
    ]);
  });

  it("consigne les réglages sans jamais la valeur d'un secret ni d'un identifiant", async () => {
    const { instance, trace } = controller({
      platform: {
        save: async (values: Record<string, unknown>) => ({ saved: Object.keys(values) }),
      },
      branding: { forgetAll: () => undefined },
    });
    await instance.saveSettings(request as never, {
      values: {
        "security.staffRequires2fa": false,
        "billing.provider": "whmcs",
        "smtp.password": "mot-de-passe-smtp",
        "s3.accessKey": "AKIA-IDENTIFIANT",
        "s3.secretKey": "cle-secrete-s3",
      },
    });

    const [ligne] = trace();
    expect(ligne?.event).toBe("admin.settings_saved");
    expect(ligne?.properties).toEqual({
      keys: [
        "security.staffRequires2fa",
        "billing.provider",
        "smtp.password",
        "s3.accessKey",
        "s3.secretKey",
      ],
      values: { "security.staffRequires2fa": false, "billing.provider": "whmcs" },
    });
    const texte = JSON.stringify(ligne);
    for (const secret of ["mot-de-passe-smtp", "AKIA-IDENTIFIANT", "cle-secrete-s3"]) {
      expect(texte).not.toContain(secret);
    }
  });

  it("consigne une fonctionnalité coupée", async () => {
    const { instance, trace } = controller({ platform: { setFlag: async () => undefined } });
    await instance.setFlag(request as never, "marketplace", { enabled: false });
    expect(trace()[0]).toMatchObject({
      event: "admin.feature_flag_set",
      properties: { key: "marketplace", enabled: false },
    });
  });

  it("ne consigne ni le mot de passe provisoire d'un compte créé, ni le jeton d'un node", async () => {
    const { instance, trace } = controller({
      actions: { createUser: async () => ({ id: "u", temporaryPassword: "provisoire-42" }) },
      infrastructure: {
        createNode: async () => ({ id: "n", tokenId: "tid", token: "jeton-du-daemon" }),
      },
    });
    await instance.createUser(request as never, {
      email: "Nouveau@X.test",
      nameFirst: "A",
      nameLast: "B",
    });
    await instance.createNode(request as never, {
      name: "N1",
      fqdn: "n1.test",
      locationId: "7b0c8f7e-3f1a-4c7e-9a51-2f7d6d1c0b11",
      memoryMb: 8192,
      diskMb: 102_400,
      cpuCores: 4,
    });

    const [compte, node] = trace();
    expect(compte).toMatchObject({
      event: "admin.user_created",
      properties: { userId: "u", account: "nouveau@x.test", role: "user", withPassword: true },
    });
    expect(node).toMatchObject({
      event: "node.created",
      properties: { nodeId: "n", tokenId: "tid" },
    });
    expect(JSON.stringify(trace())).not.toMatch(/provisoire-42|jeton-du-daemon/);
  });

  it("rattache la suspension au serveur, et la suppression à personne", async () => {
    const { instance, trace } = controller({
      actions: {
        setServerSuspended: async () => ({ sessionsNotClosed: 0 }),
        deleteServer: async () => ({ name: "Survie", ownerId: "client" }),
      },
    });
    await instance.suspendServer(request as never, "srv", { suspended: true, reason: " Impayé " });
    await instance.suspendServer(request as never, "srv", { suspended: false });
    await instance.deleteServer(request as never, "srv");

    expect(trace()).toEqual([
      expect.objectContaining({
        event: "admin.server_suspended",
        serverId: "srv",
        properties: { reason: "Impayé", sessionsNotClosed: 0 },
      }),
      expect.objectContaining({ event: "admin.server_resumed", serverId: "srv" }),
      // Le serveur n'existe plus : l'y rattacher ferait échouer l'écriture.
      expect.objectContaining({
        event: "admin.server_deleted",
        serverId: null,
        properties: { serverId: "srv", name: "Survie", ownerId: "client" },
      }),
    ]);
  });

  it("ne consigne pas la valeur d'une variable de serveur", async () => {
    const { instance, trace } = controller({
      adminServers: { setVariable: async () => undefined },
    });
    await instance.setServerVariable(request as never, "srv", {
      envVariable: "RCON_PASSWORD",
      value: "motdepasse-rcon",
    });
    expect(trace()[0]).toMatchObject({
      event: "admin.server_variable_set",
      serverId: "srv",
      properties: { envVariable: "RCON_PASSWORD" },
    });
    expect(JSON.stringify(trace())).not.toContain("motdepasse-rcon");
  });

  it("ne consigne rien quand le geste est refusé", async () => {
    const { instance, record } = controller({
      actions: {
        deleteUser: async () => {
          throw new Error("Ce compte possède 2 serveur(s).");
        },
      },
    });
    await expect(instance.deleteUser(request as never, "cible")).rejects.toThrow();
    expect(record).not.toHaveBeenCalled();
  });
});
