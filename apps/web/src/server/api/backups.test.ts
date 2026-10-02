import { BACKUP_RESTORE_TIMEOUT_MS } from "@gamedashboard/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Une restauration attend d'abord l'instantané de sûreté de l'agent (ADR
 * 0009) : avec le délai ordinaire de dix secondes, l'écran disait « délai
 * dépassé » à une restauration qui partait pourtant.
 */

const client = vi.hoisted(() => ({ apiFetch: vi.fn(), apiSend: vi.fn(async () => undefined) }));
vi.mock("./client", () => client);
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const { deleteBackup, restoreBackup } = await import("./backups");

describe("actions des sauvegardes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("laisse à la restauration le temps de l'instantané de sûreté", async () => {
    await expect(restoreBackup("srv", "bkp", true)).resolves.toEqual({ error: null });
    expect(client.apiSend).toHaveBeenCalledWith(
      "/api/v1/client/servers/srv/backups/bkp/restore",
      { truncate: true },
      "POST",
      { delaiMs: BACKUP_RESTORE_TIMEOUT_MS },
    );
  });

  it("garde le délai ordinaire pour les autres gestes", async () => {
    await deleteBackup("srv", "bkp");
    expect(client.apiSend).toHaveBeenCalledWith(
      "/api/v1/client/servers/srv/backups/bkp",
      undefined,
      "DELETE",
    );
  });
});
