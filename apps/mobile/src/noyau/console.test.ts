import type { ClientServerView } from "@gamedashboard/contracts";
import { describe, expect, it } from "vitest";
import { lireServeur } from "./alimentation";
import { ajouterLignes, filtrerLignes, LIGNES_MAX, lireReleve } from "./console";
import { cibleNotification } from "./notifications";

describe("console", () => {
  it("retire les couleurs, le préfixe du daemon, et range par niveau", () => {
    const lignes = ajouterLignes(
      [],
      [
        "\u001b[32m[12:00:00 INFO]: Done\u001b[0m",
        "[Pterodactyl Daemon]: Checking server disk space usage",
        "[12:00:01 ERROR]: Could not bind",
        "\tat net.minecraft.Server.run(Server.java:42)",
      ],
    );
    expect(lignes.map((l) => [l.texte, l.niveau, l.source])).toEqual([
      ["[12:00:00 INFO]: Done", "info", "server"],
      ["Checking server disk space usage", null, "system"],
      ["[12:00:01 ERROR]: Could not bind", "error", "server"],
      ["\tat net.minecraft.Server.run(Server.java:42)", "error", "server"],
    ]);
    const erreurs = filtrerLignes(lignes, { source: "all", levels: ["error"], query: "" });
    expect(erreurs).toHaveLength(2);
  });

  it("ne garde que les dernières lignes en mémoire", () => {
    const beaucoup = Array.from({ length: LIGNES_MAX + 50 }, (_, i) => `ligne ${i}`);
    const lignes = ajouterLignes([], beaucoup);
    expect(lignes).toHaveLength(LIGNES_MAX);
    expect(lignes.at(-1)?.texte).toBe(`ligne ${LIGNES_MAX + 49}`);
  });

  it("lit le relevé du daemon, et rien d'autre", () => {
    expect(
      lireReleve(
        JSON.stringify({
          cpu_absolute: 12.5,
          memory_bytes: 1024,
          memory_limit_bytes: 2048,
          uptime: 9,
        }),
      ),
    ).toEqual({
      cpuPct: 12.5,
      memoireOctets: 1024,
      memoireLimiteOctets: 2048,
      disqueOctets: 0,
      dureeMs: 9,
    });
    expect(lireReleve("pas du json")).toBeNull();
    expect(lireReleve(JSON.stringify({ cpu_absolute: "12" }))).toBeNull();
  });
});

const serveur: ClientServerView = {
  id: "8c1b6f4e-1d2a-4b3c-9e8f-7a6b5c4d3e2f",
  shortId: "8c1b6f4e",
  name: "Survie",
  description: null,
  address: "203.0.113.5:25565",
  nodeName: "Machine 1",
  nodeUnreachableSince: null,
  game: "Minecraft",
  memoryMaxMb: 4096,
  diskMaxMb: 10240,
  cpuMaxPct: 200,
  state: null,
  runtimeState: "running",
  cpuPct: 10,
  memoryMb: 1024,
  diskMb: 512,
  players: 3,
  maxPlayers: 20,
  isOwner: true,
};

describe("lireServeur", () => {
  it("ouvre les ordres selon l'état du conteneur, comme le web", () => {
    expect(lireServeur(serveur, null).fermes).toEqual({
      start: true,
      restart: false,
      stop: false,
      kill: false,
    });
    expect(lireServeur({ ...serveur, runtimeState: "offline" }, null).fermes).toEqual({
      start: false,
      restart: true,
      stop: true,
      kill: true,
    });
  });

  it("ferme tout pendant un blocage, et ne prétend rien d'une machine muette", () => {
    const installe = lireServeur({ ...serveur, state: "installing" }, null);
    expect(installe.blocage?.label).toBe("Installation en cours");
    expect(Object.values(installe.fermes).every(Boolean)).toBe(true);

    const muette = lireServeur({ ...serveur, nodeUnreachableSince: "2026-10-02T10:00:00Z" }, null);
    expect(muette.blocage?.label).toBe("Machine injoignable");
    expect(muette.etat).toBeNull();
    expect(Object.values(muette.fermes).every(Boolean)).toBe(true);
  });
});

describe("cibleNotification", () => {
  it("ouvre l'écran du serveur dans l'application, une page du panel sinon", () => {
    expect(cibleNotification(`/server/${serveur.id}/backups`)).toEqual({ serveur: serveur.id });
    expect(cibleNotification("/account/security")).toEqual({ chemin: "/account/security" });
    // Jamais une adresse externe ni un chemin qui sortirait du panel.
    expect(cibleNotification("https://ailleurs.example")).toBeNull();
    expect(cibleNotification("//ailleurs.example/x")).toBeNull();
    expect(cibleNotification(null)).toBeNull();
  });
});
