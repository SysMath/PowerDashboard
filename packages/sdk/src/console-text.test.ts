import { describe, expect, it } from "vitest";
import {
  consoleLevel,
  cycleSuggestion,
  linkify,
  matchesFilter,
  NO_FILTER,
  pushHistory,
  splitMatches,
  suggestCommands,
  templateValue,
} from "./console-text";

describe("niveau d'une ligne", () => {
  it("lit le niveau de log4j (Minecraft)", () => {
    expect(consoleLevel("[12:00:01 INFO]: Done (3.2s)!")).toBe("info");
    expect(consoleLevel("[12:00:01 WARN]: Can't keep up!")).toBe("warn");
    expect(consoleLevel("[Server thread/ERROR]: Encountered an unexpected exception")).toBe(
      "error",
    );
  });

  it("range au plus grave une ligne qui porte deux niveaux", () => {
    expect(consoleLevel("[INFO] plugin ERROR while loading")).toBe("error");
  });

  it("ne prend pas un mot ordinaire pour un niveau", () => {
    expect(consoleLevel("no errors found")).toBeNull();
    expect(consoleLevel("INFORMATION du jour")).toBeNull();
  });

  it("rattache la trace d'une exception à l'erreur", () => {
    expect(consoleLevel("\tat net.minecraft.server.Main.main(Main.java:42)")).toBe("error");
    expect(consoleLevel("Caused by: java.io.IOException")).toBe("error");
    expect(consoleLevel("\t... 12 more")).toBe("error");
  });
});

describe("liens", () => {
  it("rend une adresse cliquable sans la ponctuation qui la suit", () => {
    expect(linkify("Voir https://exemple.fr/doc.")).toEqual([
      { text: "Voir " },
      { text: "https://exemple.fr/doc", href: "https://exemple.fr/doc" },
      { text: "." },
    ]);
  });

  it("garde une parenthèse qui appartient à l'adresse", () => {
    const parts = linkify("(https://fr.wikipedia.org/wiki/Java_(langage))");
    expect(parts[1]).toEqual({
      text: "https://fr.wikipedia.org/wiki/Java_(langage)",
      href: "https://fr.wikipedia.org/wiki/Java_(langage)",
    });
    expect(parts[2]).toEqual({ text: ")" });
  });

  it("retire ponctuation et parenthèses mêlées en fin d'adresse", () => {
    expect(linkify("(voir https://exemple.fr/a).)")[1]).toEqual({
      text: "https://exemple.fr/a",
      href: "https://exemple.fr/a",
    });
  });

  // Non-régression (CodeQL js/polynomial-redos) : le retrait de la ponctuation
  // finale était quadratique, et une telle ligne figeait l'onglet.
  it("traite en temps linéaire une adresse suivie de cent mille « ! » ou « ) »", () => {
    for (const queue of ["!".repeat(100_000), ")".repeat(100_000), ".)".repeat(50_000)]) {
      const debut = performance.now();
      const parts = linkify(`https://exemple.fr${queue}`);
      expect(performance.now() - debut).toBeLessThan(500);
      expect(parts[0]).toEqual({ text: "https://exemple.fr", href: "https://exemple.fr/" });
    }
  });

  it("ne fait jamais un lien d'un autre protocole", () => {
    expect(linkify("javascript:alert(1) ftp://x.fr")).toEqual([
      { text: "javascript:alert(1) ftp://x.fr" },
    ]);
  });

  it("laisse un texte sans adresse d'un seul morceau", () => {
    expect(linkify("rien ici")).toEqual([{ text: "rien ici" }]);
  });
});

describe("recherche", () => {
  it("marque chaque occurrence, sans tenir compte de la casse", () => {
    expect(splitMatches("Steve a rejoint, steve part", "STEVE")).toEqual([
      { text: "Steve", match: true },
      { text: " a rejoint, " },
      { text: "steve", match: true },
      { text: " part" },
    ]);
  });

  it("cherche littéralement, sans expression régulière", () => {
    expect(splitMatches("a.*b (x", ".*")).toEqual([
      { text: "a" },
      { text: ".*", match: true },
      { text: "b (x" },
    ]);
    expect(splitMatches("a (x", "(")).toHaveLength(3);
  });
});

describe("filtre", () => {
  const jeu = { text: "[12:00 WARN]: Can't keep up!" };
  const panel = { text: "Serveur démarré", source: "system" as const };

  it("tient une ligne sans source pour une ligne du jeu", () => {
    expect(matchesFilter(jeu, { ...NO_FILTER, source: "server" })).toBe(true);
    expect(matchesFilter(jeu, { ...NO_FILTER, source: "system" })).toBe(false);
    expect(matchesFilter(panel, { ...NO_FILTER, source: "system" })).toBe(true);
  });

  it("écarte les lignes sans niveau dès qu'un niveau est choisi", () => {
    expect(matchesFilter(jeu, { ...NO_FILTER, levels: ["warn"] })).toBe(true);
    expect(matchesFilter(panel, { ...NO_FILTER, levels: ["warn"] })).toBe(false);
  });

  it("combine source, niveau et recherche", () => {
    const filtre = { source: "server" as const, levels: ["warn" as const], query: "keep" };
    expect(matchesFilter(jeu, filtre)).toBe(true);
    expect(matchesFilter(jeu, { ...filtre, query: "absent" })).toBe(false);
  });
});

describe("historique des commandes", () => {
  it("fait remonter une commande déjà tapée au lieu de la répéter", () => {
    expect(pushHistory(["list", "say bonjour"], "say bonjour")).toEqual(["say bonjour", "list"]);
  });

  it("garde cent entrées au plus", () => {
    const plein = Array.from({ length: 100 }, (_, i) => `c${i}`);
    const suivant = pushHistory(plein, "nouvelle");
    expect(suivant).toHaveLength(100);
    expect(suivant[0]).toBe("nouvelle");
    expect(suivant).not.toContain("c99");
  });
});

describe("autocomplétion", () => {
  const sources = {
    history: ["whitelist add Steve", "say bonjour"],
    declared: ["say <message>", "whitelist add <joueur>", "whitelist list", "stop"],
  };

  it("ne propose rien tant que rien n'est tapé", () => {
    expect(suggestCommands("", sources)).toEqual([]);
    expect(suggestCommands("  ", sources)).toEqual([]);
  });

  it("propose l'historique d'abord, puis les commandes de l'egg", () => {
    expect(suggestCommands("wh", sources)).toEqual([
      { label: "whitelist add Steve", value: "whitelist add Steve", from: "history" },
      { label: "whitelist add <joueur>", value: "whitelist add ", from: "egg" },
      { label: "whitelist list", value: "whitelist list", from: "egg" },
    ]);
  });

  it("ignore la barre oblique qu'on tape par habitude", () => {
    expect(suggestCommands("/sto", sources).map((s) => s.value)).toEqual(["stop"]);
  });

  it("ne propose pas ce qui est déjà tapé", () => {
    expect(suggestCommands("stop", sources)).toEqual([]);
  });

  it("s'arrête au premier argument d'un modèle", () => {
    expect(templateValue("ban <joueur> [raison]")).toBe("ban ");
    expect(templateValue("list")).toBe("list");
  });
});

describe("sélection d'une proposition", () => {
  it("fait le tour en passant par « aucune »", () => {
    expect(cycleSuggestion(-1, 1, 3)).toBe(0);
    expect(cycleSuggestion(2, 1, 3)).toBe(-1);
    expect(cycleSuggestion(-1, -1, 3)).toBe(2);
    expect(cycleSuggestion(0, -1, 3)).toBe(-1);
  });
});
