import type { Database } from "@gamedashboard/db";
import { ConflictException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { S3Service } from "../storage/s3.service";
import type { WingsClientService } from "../wings/wings-client.service";
import type { WingsTokenService } from "../wings/wings-token.service";
import { BackupHooks } from "./backup-hooks";
import { BackupsService } from "./backups.service";

/** Attente d'une sauvegarde préalable : relue jusqu'au compte rendu du daemon. */

function service(etats: (boolean | null | undefined)[]) {
  const suite = [...etats];
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            const etat = suite.length > 1 ? suite.shift() : suite[0];
            return etat === undefined ? [] : [{ isSuccessful: etat }];
          },
        }),
      }),
    }),
  } as unknown as Database;
  return new BackupsService(
    db,
    {} as WingsClientService,
    {} as WingsTokenService,
    {} as S3Service,
    new BackupHooks(),
  );
}

describe("BackupsService.awaitCompletion", () => {
  it("attend la fin, puis rend la main", async () => {
    const pause = vi.fn(async () => {});
    await service([null, null, true]).awaitCompletion("srv", "b", 60_000, pause);
    expect(pause).toHaveBeenCalledTimes(2);
  });

  it("refuse une sauvegarde ratée", async () => {
    await expect(
      service([null, false]).awaitCompletion("srv", "b", 60_000, async () => {}),
    ).rejects.toThrow(/a échoué/);
  });

  it("renonce au-delà du délai, sans rien laisser croire", async () => {
    await expect(
      service([null]).awaitCompletion("srv", "b", 0, async () => {}),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("refuse une sauvegarde disparue", async () => {
    await expect(service([undefined]).awaitCompletion("srv", "b", 60_000)).rejects.toThrow(
      /disparu/,
    );
  });
});
