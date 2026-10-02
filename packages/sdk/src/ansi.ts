/**
 * Nettoyage des séquences d'échappement d'un flux de console.
 *
 * Un serveur de jeu n'écrit pas du texte : il écrit un flux destiné à un
 * terminal, mêlé de séquences de contrôle. Affichées telles quelles, elles
 * apparaissent en clair au milieu de la ligne — c'est ainsi qu'un `ESC[6n`
 * finit par se lire « [6n » devant la commande qu'on vient d'envoyer.
 *
 * Le parti pris est de **retirer** plutôt que d'interpréter. Convertir les
 * couleurs ANSI en balises demanderait de produire du HTML à partir de la
 * sortie d'un serveur de jeu — c'est-à-dire de laisser des joueurs choisir le
 * balisage d'une page du panel. Le jour où la console sera colorée, elle le
 * sera par un analyseur n'émettant que des classes closes, jamais par de
 * l'injection de balises.
 *
 * Les motifs sont écrits avec `` et jamais avec le caractère brut : un
 * octet d'échappement littéral rend le fichier binaire aux yeux des outils, et
 * survit mal aux copies, aux fusions et aux éditeurs.
 */

const ESC = "\\u001B";

/**
 * Séquences CSI : `ESC [ … lettre`.
 *
 * Couvre les couleurs (`ESC[32m`), les déplacements de curseur (`ESC[2J`) et
 * les interrogations comme `ESC[6n`, que le terminal d'un conteneur émet pour
 * demander la position du curseur — sans réponse possible ici, puisque
 * personne n'écoute de l'autre côté.
 */
const CSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g");

/** Séquences OSC : `ESC ] … BEL` ou `ESC ] … ESC \`. Titre de fenêtre, surtout. */
const OSC = new RegExp(`${ESC}\\][^\\u0007\\u001B]*(?:\\u0007|${ESC}\\\\)`, "g");

/**
 * Les autres séquences d'échappement : `ESC (B`, `ESC =`, `ESC >`, `ESC c`…
 *
 * L'octet final couvre `0` à `~`, et non `0` à `?` : la seconde plage laissait
 * passer `ESC (B` — le sélecteur de jeu de caractères, que tout terminal émet
 * au démarrage — parce que son `B` tombe au-delà. Il s'affichait alors en clair.
 *
 * Appliquée **après** CSI et OSC : sa plage engloberait leur `[` et leur `]`,
 * et elle les tronquerait en n'en retirant que les deux premiers caractères.
 */
const SHORT = new RegExp(`${ESC}[ -/]*[0-~]`, "g");

/**
 * Caractères de contrôle restants.
 *
 * Les tabulations et sauts de ligne sont **préservés** : ce sont des
 * espacements, pas des commandes, et les retirer collerait les colonnes d'une
 * sortie tabulée.
 */
// biome-ignore-start lint/suspicious/noControlCharactersInRegex: ces caractères sont précisément ce que la fonction retire.
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/g;
// biome-ignore-end lint/suspicious/noControlCharactersInRegex: fin du nettoyeur.

/**
 * Retour chariot, traité à part.
 *
 * Un serveur qui redessine une barre de progression renvoie le curseur en
 * début de ligne à chaque rafraîchissement. Le conserver ferait s'empiler les
 * états successifs sur une même ligne.
 */
const CARRIAGE_RETURN = /\r/g;

export function stripAnsi(text: string): string {
  return text
    .replace(OSC, "")
    .replace(CSI, "")
    .replace(SHORT, "")
    .replace(CARRIAGE_RETURN, "")
    .replace(CONTROL, "");
}

/**
 * Les seize couleurs du terminal, et elles seules.
 *
 * C'est la « classe close » annoncée plus haut : une ligne de console ne peut
 * produire qu'un de ces noms, que l'interface traduit en une classe écrite à
 * l'avance. Aucune valeur venue du flux n'atteint jamais le balisage — ni une
 * couleur `38;2;r;g;b`, ni un nom de classe.
 */
export const ANSI_COLORS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "bright-black",
  "bright-red",
  "bright-green",
  "bright-yellow",
  "bright-blue",
  "bright-magenta",
  "bright-cyan",
  "bright-white",
] as const;
export type AnsiColor = (typeof ANSI_COLORS)[number];

/** Un morceau de ligne d'un seul style. */
export interface AnsiSegment {
  text: string;
  color?: AnsiColor;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

type AnsiStyle = Omit<AnsiSegment, "text">;

/** Une séquence CSI entière, capturée pour en lire les paramètres et la lettre finale. */
const CSI_CAPTURE = new RegExp(`${ESC}\\[([0-9;?]*)[ -/]*([@-~])`, "g");

/**
 * Applique un `ESC[…m` au style courant.
 *
 * Les couleurs à 256 teintes ne sont gardées que dans leurs seize premières
 * (qui sont les couleurs de base), les couleurs 24 bits jamais : les
 * rapprocher d'une teinte de base demanderait une table pour un gain
 * minime, et les laisser passer rouvrirait la porte fermée plus haut.
 */
function applySgr(style: AnsiStyle, params: string): AnsiStyle {
  const codes = params === "" ? [0] : params.split(";").map((p) => Number(p || 0));
  let next: AnsiStyle = { ...style };
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i] as number;
    if (code === 0) next = {};
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 22) {
      next.bold = undefined;
      next.dim = undefined;
    } else if (code === 23) next.italic = undefined;
    else if (code === 24) next.underline = undefined;
    else if (code >= 30 && code <= 37) next.color = ANSI_COLORS[code - 30];
    else if (code >= 90 && code <= 97) next.color = ANSI_COLORS[code - 90 + 8];
    else if (code === 39) next.color = undefined;
    else if (code === 38) {
      // `38;5;n` ou `38;2;r;g;b` : on consomme les paramètres dans tous les cas,
      // pour qu'ils ne soient pas relus comme des codes à part entière.
      if (codes[i + 1] === 5) {
        const n = codes[i + 2] ?? -1;
        next.color = n >= 0 && n < 16 ? ANSI_COLORS[n] : undefined;
        i += 2;
      } else if (codes[i + 1] === 2) {
        next.color = undefined;
        i += 4;
      }
    } else if (code === 48) {
      // Fond : ignoré, la console garde le sien. Mêmes paramètres à consommer.
      if (codes[i + 1] === 5) i += 2;
      else if (codes[i + 1] === 2) i += 4;
    }
  }
  return next;
}

/**
 * Découpe une ligne en morceaux stylés.
 *
 * Seules les séquences de couleur et d'emphase (`ESC[…m`) sont interprétées ;
 * tout le reste est retiré comme le fait `stripAnsi`, dont le texte concaténé
 * des morceaux est toujours l'égal.
 */
export function parseAnsi(text: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  let style: AnsiStyle = {};
  let last = 0;
  const push = (raw: string) => {
    const clean = stripAnsi(raw);
    if (clean === "") return;
    const previous = segments.at(-1);
    if (previous && sameStyle(previous, style)) previous.text += clean;
    else segments.push({ text: clean, ...style });
  };
  for (const match of text.matchAll(CSI_CAPTURE)) {
    push(text.slice(last, match.index));
    if (match[2] === "m") style = applySgr(style, match[1] ?? "");
    last = (match.index ?? 0) + match[0].length;
  }
  push(text.slice(last));
  return segments;
}

function sameStyle(a: AnsiStyle, b: AnsiStyle): boolean {
  return (
    a.color === b.color &&
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.underline === b.underline
  );
}
