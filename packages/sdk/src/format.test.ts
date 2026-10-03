import { describe, expect, it } from "vitest";
import { formatBytes, formatMb, formatPercent, formatRelative, formatUptime } from "./format";

describe("formatBytes", () => {
  it("choisit l'unité en fonction de la grandeur", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 ** 2)).toBe("1.0 MB");
    expect(formatBytes(1024 ** 3)).toBe("1.0 GB");
    expect(formatBytes(1024 ** 4)).toBe("1.0 TB");
  });

  it("n'affiche pas de décimale pour les octets", () => {
    expect(formatBytes(999)).toBe("999 B");
  });

  it("renvoie zéro octet pour une entrée nulle, négative ou invalide", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });

  it("plafonne à l'unité la plus grande au lieu de déborder", () => {
    expect(formatBytes(1024 ** 6)).toContain("TB");
  });
});

describe("formatMb", () => {
  it("interprète l'entrée en mébioctets", () => {
    expect(formatMb(1024)).toBe("1.0 GB");
    expect(formatMb(3993, 1)).toBe("3.9 GB");
  });
});

describe("formatPercent", () => {
  it("applique la précision demandée", () => {
    expect(formatPercent(42.185)).toBe("42.19 %");
    expect(formatPercent(42.185, 0)).toBe("42 %");
  });
});

describe("formatUptime", () => {
  it("passe aux jours au-delà de vingt-quatre heures", () => {
    expect(formatUptime(90_000_000)).toBe("1j 1h");
  });

  it("affiche heures et minutes en deçà d'un jour", () => {
    expect(formatUptime(3_900_000)).toBe("1h 5m");
  });

  it("descend à la seconde pour les durées courtes", () => {
    expect(formatUptime(65_000)).toBe("1m 5s");
  });
});

describe("formatRelative", () => {
  const now = new Date("2026-09-15T12:00:00.000Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it("exprime les écarts récents en secondes", () => {
    expect(formatRelative(ago(5_000), now)).toContain("seconde");
  });

  it("bascule en minutes puis en heures", () => {
    expect(formatRelative(ago(300_000), now)).toContain("minute");
    expect(formatRelative(ago(7_200_000), now)).toContain("heure");
  });

  it("préfère les mots usuels aux comptes pour les jours proches", () => {
    // `numeric: "auto"` produit « hier » et « avant-hier » plutôt que
    // « il y a 1 jour ». C'est voulu : plus court et plus naturel à lire.
    expect(formatRelative(ago(86_400_000), now)).toBe("hier");
    expect(formatRelative(ago(172_800_000), now)).toBe("avant-hier");
  });

  it("revient au compte en jours au-delà", () => {
    expect(formatRelative(ago(5 * 86_400_000), now)).toContain("jour");
  });

  it("accepte une date au format ISO", () => {
    expect(formatRelative(ago(60_000).toISOString(), now)).toContain("minute");
  });

  it("gère une date future sans inverser le sens", () => {
    const future = new Date(now.getTime() + 300_000);
    expect(formatRelative(future, now)).not.toContain("il y a");
  });
});
