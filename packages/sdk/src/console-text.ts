/**
 * Ce que la console avancée lit dans une ligne : son niveau, ses liens, ce qui
 * répond à une recherche. Et ce qu'elle propose à la saisie.
 *
 * Tout est ici en fonctions pures, sans React : c'est la partie qui se trompe
 * sur des cas réels (un point final collé à une adresse, un `WARN` au milieu
 * d'un mot), donc celle qui doit être testée ligne à ligne.
 */

/** Le niveau d'une ligne, quand elle en annonce un. */
export type ConsoleLevel = "error" | "warn" | "info";

/**
 * Niveaux reconnus, du plus grave au moins grave : une ligne qui porte les
 * deux mots (« INFO … ERROR ») est rangée au plus grave.
 *
 * En **majuscules seulement**, et en mot entier : « error » en minuscules
 * apparaît dans une phrase ordinaire (« no errors found »), et « INFORMATION »
 * n'est pas un niveau. Les journaux des jeux (log4j de Minecraft, Source,
 * FiveM) écrivent leur niveau en capitales.
 */
const LEVELS: [ConsoleLevel, RegExp][] = [
  ["error", /\b(?:ERROR|SEVERE|FATAL|CRITICAL)\b/],
  ["warn", /\b(?:WARN|WARNING)\b/],
  ["info", /\b(?:INFO)\b/],
];

/**
 * La suite d'une exception Java : `\tat …`, `Caused by: …`, `... 12 more`.
 *
 * Ces lignes ne portent pas de niveau, mais elles appartiennent à l'erreur
 * qui les précède. Les laisser « sans niveau » faisait qu'un filtre sur les
 * erreurs montrait l'en-tête d'une trace et perdait sa cause.
 */
const STACK = /^(?:\s+at\s|Caused by:|\s*\.\.\. \d+ more)/;

export function consoleLevel(text: string): ConsoleLevel | null {
  if (STACK.test(text)) return "error";
  for (const [level, pattern] of LEVELS) if (pattern.test(text)) return level;
  return null;
}

/** Un morceau de texte, ou un lien. */
export type LinkPart = { text: string; href?: string };

/**
 * Adresses reconnues : `http` et `https` seulement.
 *
 * Aucun autre protocole : un `javascript:` écrit par un joueur dans le chat
 * deviendrait sinon un lien du panel. L'adresse est de plus relue par `URL`,
 * qui écarte ce qui n'en est pas une.
 */
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/g;

/**
 * La ponctuation qui termine une phrase n'appartient pas à l'adresse :
 * « voir https://exemple.fr. » ne doit pas mener à `exemple.fr.`. Une
 * parenthèse fermante n'est retirée que si l'adresse n'en ouvre aucune —
 * celles de Wikipédia en portent.
 */
function trimUrl(raw: string): string {
  // Tout se fait par indices, en un seul passage : une expression ancrée en
  // fin de chaîne et un décompte refait à chaque parenthèse coûtaient un temps
  // quadratique, et une ligne de console de cent mille « ! » ou « ) » figeait
  // l'onglet de quiconque la regardait.
  const ouvrantes = count(raw, "(");
  let fermantes = count(raw, ")");
  let fin = sansPonctuationFinale(raw, raw.length);
  while (fin > 0 && raw[fin - 1] === ")" && ouvrantes < fermantes) {
    fermantes -= 1;
    fin = sansPonctuationFinale(raw, fin - 1);
  }
  return raw.slice(0, fin);
}

const PONCTUATION_FINALE = ".,;:!?'\"";

/** L'indice où s'arrête `texte.slice(0, fin)` une fois sa ponctuation finale retirée. */
function sansPonctuationFinale(texte: string, fin: number): number {
  let indice = fin;
  while (indice > 0 && PONCTUATION_FINALE.includes(texte.charAt(indice - 1))) indice -= 1;
  return indice;
}

function count(text: string, char: string): number {
  return text.split(char).length - 1;
}

export function linkify(text: string): LinkPart[] {
  const parts: LinkPart[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = trimUrl(match[0]);
    const start = match.index ?? 0;
    let href: string | undefined;
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") href = parsed.href;
    } catch {
      href = undefined;
    }
    if (!href) continue;
    if (start > last) parts.push({ text: text.slice(last, start) });
    parts.push({ text: url, href });
    last = start + url.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

/** Un morceau de texte, marqué quand il répond à la recherche. */
export type MatchPart = { text: string; match?: boolean };

/**
 * Découpe un texte autour des occurrences de `query`, sans tenir compte de la
 * casse. La recherche est **littérale** : taper `[INFO]` ou `.*` cherche ces
 * caractères, pas une expression — un champ de recherche n'est pas un éditeur
 * d'expressions, et une parenthèse oubliée ne doit rien casser.
 */
export function splitMatches(text: string, query: string): MatchPart[] {
  if (query === "") return [{ text }];
  const haystack = text.toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();
  const parts: MatchPart[] = [];
  let last = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    if (index > last) parts.push({ text: text.slice(last, index) });
    parts.push({ text: text.slice(index, index + needle.length), match: true });
    last = index + needle.length;
    index = haystack.indexOf(needle, last);
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

/** Ce qu'on montre : une source, des niveaux, une recherche. */
export interface ConsoleFilter {
  source: "all" | "system" | "server";
  /** Niveaux retenus ; vide = tous, y compris les lignes sans niveau. */
  levels: ConsoleLevel[];
  query: string;
}

export const NO_FILTER: ConsoleFilter = { source: "all", levels: [], query: "" };

export function isFiltering(filter: ConsoleFilter): boolean {
  return filter.source !== "all" || filter.levels.length > 0 || filter.query.trim() !== "";
}

/**
 * La ligne passe-t-elle le filtre ?
 *
 * Une ligne sans source est une ligne du jeu : c'est ce qu'envoie Wings pour
 * la sortie du conteneur, et seules les lignes du panel et du daemon sont
 * marquées `system`.
 */
export function matchesFilter(
  line: { text: string; source?: "system" | "server"; level?: ConsoleLevel | null },
  filter: ConsoleFilter,
): boolean {
  const source = line.source ?? "server";
  if (filter.source !== "all" && source !== filter.source) return false;
  if (filter.levels.length > 0) {
    const level = line.level === undefined ? consoleLevel(line.text) : line.level;
    if (level === null || !filter.levels.includes(level)) return false;
  }
  const query = filter.query.trim().toLocaleLowerCase();
  return query === "" || line.text.toLocaleLowerCase().includes(query);
}

/** Nombre d'entrées de l'historique des commandes. */
export const COMMAND_HISTORY_SIZE = 100;

/**
 * Ajoute une commande en tête de l'historique.
 *
 * Une commande déjà présente **remonte** au lieu d'être répétée : taper dix
 * fois `list` ne doit pas pousser hors de l'historique les commandes qu'on
 * tape rarement, qui sont justement celles qu'on ne retient pas.
 */
export function pushHistory(history: string[], command: string): string[] {
  return [command, ...history.filter((entry) => entry !== command)].slice(0, COMMAND_HISTORY_SIZE);
}

/** Une proposition d'autocomplétion. */
export interface CommandSuggestion {
  /** Ce qui s'affiche : la commande, avec ses `<arguments>` quand elle vient de l'egg. */
  label: string;
  /** Ce que la saisie devient si on la retient. */
  value: string;
  from: "history" | "egg";
}

/**
 * Ce que devient la saisie quand on retient un modèle de l'egg : tout jusqu'au
 * premier argument, `whitelist add <joueur>` donnant `whitelist add `. Le
 * curseur se pose ainsi là où il faut taper, et l'on ne risque pas d'envoyer
 * `<joueur>` tel quel.
 */
export function templateValue(template: string): string {
  const index = template.search(/[<[]/);
  return index === -1 ? template : template.slice(0, index);
}

/**
 * Propositions pour une saisie, **par préfixe** et sans tenir compte de la
 * casse ; les commandes déjà tapées d'abord (les plus récentes en tête), puis
 * celles de l'egg. Rien tant que la saisie est vide : une liste qui s'ouvre
 * sans qu'on ait rien tapé masque la sortie qu'on était en train de lire.
 *
 * Une barre oblique en tête est ignorée des deux côtés : les joueurs de
 * Minecraft tapent `/say` par habitude, la console attend `say`, et les deux
 * doivent trouver la même commande.
 */
export function suggestCommands(
  input: string,
  sources: { history: string[]; declared: string[] },
  limit = 8,
): CommandSuggestion[] {
  const needle = input.replace(/^\//, "").toLocaleLowerCase();
  if (needle.trim() === "") return [];
  const hit = (candidate: string) =>
    candidate.replace(/^\//, "").toLocaleLowerCase().startsWith(needle);
  const seen = new Set<string>([input]);
  const out: CommandSuggestion[] = [];
  const add = (suggestion: CommandSuggestion) => {
    if (out.length >= limit || seen.has(suggestion.value)) return;
    seen.add(suggestion.value);
    out.push(suggestion);
  };
  for (const entry of sources.history) {
    if (hit(entry)) add({ label: entry, value: entry, from: "history" });
  }
  for (const template of sources.declared) {
    const value = templateValue(template);
    // `ban ` ne répond pas à la saisie `ban x` ; on compare donc le modèle
    // entier, pas seulement la part qui sera insérée.
    if (hit(template)) add({ label: template, value, from: "egg" });
  }
  return out;
}

/**
 * Déplace la sélection dans les propositions, en boucle, **en passant par
 * « aucune »** (-1) : revenir au texte qu'on tapait, sans rien retenir, doit
 * rester possible au clavier.
 */
export function cycleSuggestion(active: number, step: 1 | -1, count: number): number {
  const slots = count + 1;
  return ((((active + 1 + step) % slots) + slots) % slots) - 1;
}
