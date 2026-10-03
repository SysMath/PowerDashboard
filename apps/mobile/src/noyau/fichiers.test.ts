import type { ClientFileEntryView } from "@gamedashboard/contracts";
import { describe, expect, it } from "vitest";
import {
  actionsEntree,
  adresseEnvoi,
  estArchive,
  fil,
  joindre,
  normaliser,
  ouverture,
  parent,
  refusDaemon,
  refusNom,
  TAILLE_EDITABLE,
  trier,
} from "./fichiers";

const entree = (nom: string, autre: Partial<ClientFileEntryView> = {}): ClientFileEntryView => ({
  name: nom,
  mode: "-rw-r--r--",
  size: 120,
  directory: false,
  file: true,
  symlink: false,
  mime: "text/plain; charset=utf-8",
  modified: "2026-10-02T12:00:00Z",
  ...autre,
});

describe("gestionnaire de fichiers", () => {
  it("range les dossiers d'abord, puis par nom", () => {
    const rangees = trier([
      entree("b.txt"),
      entree("world", { directory: true, file: false }),
      entree("A.txt"),
      entree("plugins", { directory: true, file: false }),
    ]).map((e) => e.name);
    expect(rangees).toEqual(["plugins", "world", "A.txt", "b.txt"]);
  });

  it("compose des chemins absolus propres, et la racine reste la racine", () => {
    expect(normaliser("plugins//Essentials/")).toBe("/plugins/Essentials");
    expect(joindre("/", "server.properties")).toBe("/server.properties");
    expect(joindre("/plugins/", "./config.yml")).toBe("/plugins/config.yml");
    expect(parent("/plugins/Essentials")).toBe("/plugins");
    expect(parent("/")).toBe("/");
    expect(fil("/plugins/Essentials")).toEqual([
      { nom: "/", chemin: "/" },
      { nom: "plugins", chemin: "/plugins" },
      { nom: "Essentials", chemin: "/plugins/Essentials" },
    ]);
  });

  it("n'ouvre dans l'éditeur que du texte de 1 Mo au plus", () => {
    expect(ouverture(entree("world", { directory: true }))).toBe("dossier");
    expect(ouverture(entree("server.properties", { mime: "application/octet-stream" }))).toBe(
      "editer",
    );
    expect(ouverture(entree("ops.json", { mime: "application/json" }))).toBe("editer");
    expect(ouverture(entree("vide", { mime: "inode/x-empty", size: 0 }))).toBe("editer");
    expect(ouverture(entree("latest.log", { size: TAILLE_EDITABLE }))).toBe("editer");
    expect(ouverture(entree("latest.log", { size: TAILLE_EDITABLE + 1 }))).toBe("trop-gros");
    expect(ouverture(entree("server.jar", { mime: "application/java-archive" }))).toBe("binaire");
    expect(ouverture(entree("level.dat", { mime: "application/octet-stream" }))).toBe("binaire");
  });

  it("reconnaît les archives que le daemon extrait", () => {
    expect(estArchive("monde.tar.gz")).toBe(true);
    expect(estArchive("pack.ZIP")).toBe(true);
    expect(estArchive("server.jar")).toBe(false);
  });

  it("refuse un nom vide, réservé ou qui change de dossier", () => {
    expect(refusNom("  ")).toBe("vide");
    expect(refusNom("..")).toBe("reserve");
    expect(refusNom("a/b")).toBe("barre");
    expect(refusNom("mondes")).toBeNull();
  });

  it("dépose chez le daemon avec le jeton et le dossier dans la requête", () => {
    const grant = { token: "a b&c", url: "https://node.example:8080/upload/file" };
    expect(adresseEnvoi(grant, "plugins/")).toBe(
      "https://node.example:8080/upload/file?token=a%20b%26c&directory=%2Fplugins",
    );
    expect(adresseEnvoi({ ...grant, url: `${grant.url}?v=1` }, "/")).toContain("?v=1&token=");
  });

  it("rend le refus du daemon tel qu'il l'écrit", () => {
    expect(refusDaemon('{"error":"fichier plus volumineux que la limite de 100 MB"}')).toBe(
      "fichier plus volumineux que la limite de 100 MB",
    );
    expect(refusDaemon('{"errors":[{"detail":"jeton expiré"}]}')).toBe("jeton expiré");
    expect(refusDaemon("<html>")).toBeNull();
    expect(refusDaemon('{"error":""}')).toBeNull();
  });

  it("ne propose que les gestes qui ont un sens pour l'entrée", () => {
    expect(
      actionsEntree(entree("plugins", { directory: true, file: false, mime: "inode/directory" })),
    ).toEqual(["ouvrir", "renommer", "compresser", "supprimer"]);
    expect(actionsEntree(entree("server.properties"))).toEqual([
      "ouvrir",
      "telecharger",
      "renommer",
      "compresser",
      "supprimer",
    ]);
    expect(actionsEntree(entree("monde.tar.gz", { mime: "application/gzip" }))).toEqual([
      "telecharger",
      "renommer",
      "compresser",
      "extraire",
      "supprimer",
    ]);
    // Trop gros pour l'éditeur : il se télécharge, il ne s'ouvre pas.
    expect(actionsEntree(entree("latest.log", { size: TAILLE_EDITABLE + 1 }))).not.toContain(
      "ouvrir",
    );
  });
});
