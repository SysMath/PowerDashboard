import { describe, expect, it } from "vitest";
import { parseAnsi, stripAnsi } from "./ansi";

/** Écrit en `` et jamais en caractère brut : un test doit rester lisible. */
const ESC = "";

describe("nettoyage du flux de console", () => {
  it("retire l'interrogation de position du curseur", () => {
    // Cas observé en conditions réelles : le terminal du conteneur demande la
    // position du curseur, personne ne répond, et « [6n » s'affiche en clair
    // devant la commande qu'on vient d'envoyer.
    expect(stripAnsi(`${ESC}[6nsay Redemarrage dans 5s`)).toBe("say Redemarrage dans 5s");
  });

  it("retire les couleurs sans toucher au texte", () => {
    expect(stripAnsi(`${ESC}[32mINFO${ESC}[0m: démarré`)).toBe("INFO: démarré");
  });

  it("retire un effacement d'écran et un retour au coin", () => {
    expect(stripAnsi(`${ESC}[2J${ESC}[Hbonjour`)).toBe("bonjour");
  });

  it("retire un titre de fenêtre terminé par BEL", () => {
    expect(stripAnsi(`${ESC}]0;mon serveurprêt`)).toBe("prêt");
  });

  it("retire un titre de fenêtre terminé par ESC backslash", () => {
    expect(stripAnsi(`${ESC}]0;mon serveur${ESC}\\prêt`)).toBe("prêt");
  });

  it("retire un jeu de caractères", () => {
    expect(stripAnsi(`${ESC}(Btexte`)).toBe("texte");
  });

  it("retire le retour chariot d'une barre de progression", () => {
    // Le conserver ferait s'empiler les états successifs sur une même ligne.
    expect(stripAnsi("50%\r75%\r100%")).toBe("50%75%100%");
  });

  it("préserve les tabulations", () => {
    // Ce sont des espacements, pas des commandes : les retirer collerait les
    // colonnes d'une sortie tabulée.
    expect(stripAnsi("nom\tvaleur")).toBe("nom\tvaleur");
  });

  it("retire les caractères de contrôle résiduels", () => {
    expect(stripAnsi("alerteici")).toBe("alerteici");
  });

  it("laisse un texte ordinaire intact", () => {
    expect(stripAnsi("Serveur démarré sur 0.0.0.0:25565")).toBe(
      "Serveur démarré sur 0.0.0.0:25565",
    );
  });

  it("ne casse pas sur une chaîne vide", () => {
    expect(stripAnsi("")).toBe("");
  });
});

describe("couleurs de la console", () => {
  it("découpe une ligne colorée en morceaux de classes closes", () => {
    expect(parseAnsi(`${ESC}[32mINFO${ESC}[0m: démarré`)).toEqual([
      { text: "INFO", color: "green" },
      { text: ": démarré" },
    ]);
  });

  it("lit l'emphase et les couleurs vives", () => {
    expect(parseAnsi(`${ESC}[1;91mALERTE${ESC}[22m suite`)).toEqual([
      { text: "ALERTE", color: "bright-red", bold: true },
      { text: " suite", color: "bright-red" },
    ]);
  });

  it("garde les seize premières des 256 teintes et jamais une couleur 24 bits", () => {
    expect(parseAnsi(`${ESC}[38;5;3mA${ESC}[38;5;200mB${ESC}[38;2;1;2;3mC`)).toEqual([
      { text: "A", color: "yellow" },
      { text: "BC" },
    ]);
  });

  it("ne relit pas les paramètres d'une couleur comme des codes", () => {
    // `38;2;1;4;…` : le 1 et le 4 sont des composantes, pas le gras et le souligné.
    expect(parseAnsi(`${ESC}[38;2;1;4;9mX`)).toEqual([{ text: "X" }]);
  });

  it("retire tout le reste, comme stripAnsi", () => {
    const brut = `${ESC}]0;titre\u0007${ESC}(B${ESC}[2J${ESC}[33mjaune\r`;
    expect(
      parseAnsi(brut)
        .map((s) => s.text)
        .join(""),
    ).toBe(stripAnsi(brut));
    expect(parseAnsi(brut)).toEqual([{ text: "jaune", color: "yellow" }]);
  });
});
