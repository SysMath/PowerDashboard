import { ConflictException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import type { ActivityService } from "../activity/activity.service";
import type { ServerAccessService } from "../client/server-access.service";
import { ClientSnapshotsController } from "./client-snapshots.controller";
import type { SnapshotsService } from "./snapshots.service";

const NOM = "gd-20260930T120000.000Z";

/**
 * Un serveur suspendu, en installation ou en restauration ne se touche pas
 * par l'onglet des instantanés : ni prise, ni restauration, ni épinglage.
 * L'épinglage passait à côté de `requireOperable`.
 */
describe("ClientSnapshotsController sur un serveur bloqué", () => {
  const appels: string[] = [];
  const access = {
    require: async () => {},
    requireOperable: async () => {
      throw new ConflictException("Serveur suspendu.");
    },
  } as unknown as ServerAccessService;
  const snapshots = new Proxy(
    {},
    {
      get: (_, name) => async () => {
        appels.push(String(name));
        return { orderId: "o", existing: false };
      },
    },
  ) as unknown as SnapshotsService;
  const activity = { record: async () => {} } as unknown as ActivityService;
  const controller = new ClientSnapshotsController(access, snapshots, activity);
  const requete = { user: { id: "u" }, scopes: null } as never;

  it.each([
    ["prendre", () => controller.take(requete, "s")],
    ["épingler", () => controller.pin(requete, "s", NOM, { label: "avant mise à jour" })],
    ["désépingler", () => controller.unpin(requete, "s", NOM)],
    ["restaurer", () => controller.restore(requete, "s", NOM)],
  ])("refuse de %s en 409 sans rien demander au service", async (_, action) => {
    appels.length = 0;
    await expect(action()).rejects.toBeInstanceOf(ConflictException);
    expect(appels).toEqual([]);
  });
});
