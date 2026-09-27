import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { ActivityService } from "../activity/activity.service";
import type { AuthenticatedRequest } from "../auth/session.guard";
import type { EulaService } from "../marketplace/eula.service";
import type { WingsClientService } from "../wings/wings-client.service";
import type { WingsTokenService } from "../wings/wings-token.service";
import type { FileUploadService } from "./file-upload.service";
import type { ServerAccessService } from "./server-access.service";
import type { ServerPlayersService } from "./server-players.service";
import { ServerRuntimeController } from "./server-runtime.controller";

/**
 * Aucun chemin qui sort du volume, ni aucun octet nul, n'est relayé au daemon.
 *
 * Le confinement au volume est le travail de Wings, et il le fait (§4.3). Le
 * panel ne relayait pourtant rien moins que tout : `../../etc/passwd` ou un
 * octet nul partaient tels quels, et la sûreté de chaque serveur reposait sur
 * une seule ligne de défense, dans un programme que le panel ne contrôle pas.
 * Le refus d'ici est une seconde ligne, pas un remplacement.
 */

const SERVEUR = "srv-1";
const requete = {
  user: { id: "u-1" },
  scopes: null,
  ip: "127.0.0.1",
} as unknown as AuthenticatedRequest & { ip?: string };

function monter() {
  const access = {
    require: vi.fn(async () => ({ isOwner: true })),
    requireOperable: vi.fn(async () => {}),
  };
  const wings = {
    listDirectory: vi.fn(async () => []),
    readFile: vi.fn(async () => ""),
    writeFile: vi.fn(async () => {}),
    createDirectory: vi.fn(async () => {}),
    renameFile: vi.fn(async () => {}),
    chmodFiles: vi.fn(async () => {}),
    deleteFiles: vi.fn(async () => {}),
    compressFiles: vi.fn(async () => ({ name: "a.tar.gz", size: 1 })),
    decompressFile: vi.fn(async () => {}),
  };
  const tokens = { fileDownloadGrant: vi.fn(async () => "https://node.test/fichier") };
  const uploads = { open: vi.fn(async () => ({ id: "x", chunkSize: 1, chunks: 1, received: [] })) };
  const activity = { record: vi.fn(async () => {}), labelFor: vi.fn(async () => "Matheo") };
  const controleur = new ServerRuntimeController(
    access as unknown as ServerAccessService,
    wings as unknown as WingsClientService,
    {} as EulaService,
    tokens as unknown as WingsTokenService,
    activity as unknown as ActivityService,
    uploads as unknown as FileUploadService,
    {} as ServerPlayersService,
  );
  return { controleur, wings, tokens, uploads };
}

const SORTIE = "/../../etc/passwd";
const NUL = "/server.properties\0.txt";

describe("chemins relayés au daemon", () => {
  it("refuse un dossier ou un fichier qui sort du volume, sans rien relayer", async () => {
    const { controleur, wings, tokens } = monter();

    await expect(controleur.files(requete, SERVEUR, SORTIE)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(controleur.fileContents(requete, SERVEUR, SORTIE)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      controleur.writeFile(requete, SERVEUR, SORTIE, { content: "x" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(controleur.downloadFile(requete, SERVEUR, SORTIE)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(wings.listDirectory).not.toHaveBeenCalled();
    expect(wings.readFile).not.toHaveBeenCalled();
    expect(wings.writeFile).not.toHaveBeenCalled();
    expect(tokens.fileDownloadGrant).not.toHaveBeenCalled();
  });

  it("refuse un chemin donné deux fois en paramètre, au lieu d'une erreur 500", async () => {
    // `?file=a&file=b` arrive en tableau : `refusePath` tombait en TypeError.
    const { controleur, wings, tokens } = monter();
    const double = ["/a", "/b"];

    for (const appel of [
      () => controleur.files(requete, SERVEUR, double),
      () => controleur.fileContents(requete, SERVEUR, double),
      () => controleur.writeFile(requete, SERVEUR, double, { content: "x" }),
      () => controleur.downloadFile(requete, SERVEUR, double),
    ]) {
      await expect(appel()).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(wings.listDirectory).not.toHaveBeenCalled();
    expect(wings.readFile).not.toHaveBeenCalled();
    expect(wings.writeFile).not.toHaveBeenCalled();
    expect(tokens.fileDownloadGrant).not.toHaveBeenCalled();
  });

  it("refuse un octet nul", async () => {
    const { controleur, wings } = monter();
    await expect(controleur.fileContents(requete, SERVEUR, NUL)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(wings.readFile).not.toHaveBeenCalled();
  });

  it("juge chaque entrée relative à son dossier", async () => {
    const { controleur, wings } = monter();
    const hors = { root: "/", files: ["../voisin"] };

    await expect(controleur.deleteFiles(requete, SERVEUR, hors)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(controleur.compressFiles(requete, SERVEUR, hors)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      controleur.decompressFile(requete, SERVEUR, { root: "/", file: "../a.zip" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controleur.createDirectory(requete, SERVEUR, { root: "/", name: "../mondes" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controleur.chmodFiles(requete, SERVEUR, {
        root: "/../..",
        files: [{ file: "a", mode: "644" }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controleur.renameFile(requete, SERVEUR, { root: "/", from: "a.jar", to: "../../a.jar" }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(wings.deleteFiles).not.toHaveBeenCalled();
    expect(wings.compressFiles).not.toHaveBeenCalled();
    expect(wings.decompressFile).not.toHaveBeenCalled();
    expect(wings.createDirectory).not.toHaveBeenCalled();
    expect(wings.chmodFiles).not.toHaveBeenCalled();
    expect(wings.renameFile).not.toHaveBeenCalled();
  });

  it("refuse un dossier d'envoi reprenable qui sort du volume", async () => {
    const { controleur, uploads } = monter();
    await expect(
      controleur.openUpload(requete, SERVEUR, { directory: "/\0", fileName: "a.zip", size: 1 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(uploads.open).not.toHaveBeenCalled();
  });

  it("laisse remonter d'un dossier tant qu'on reste dans le volume", async () => {
    // `../a.jar` depuis `plugins` est un déplacement que l'écran propose : il
    // ne sort de rien, et le refuser retirerait une fonction sans rien protéger.
    const { controleur, wings } = monter();
    await controleur.renameFile(requete, SERVEUR, {
      root: "/plugins",
      from: "a.jar",
      to: "../a.jar",
    });
    expect(wings.renameFile).toHaveBeenCalledWith(SERVEUR, "/plugins", "a.jar", "../a.jar");
  });
});
