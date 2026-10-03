import { stripAnsi } from "@gamedashboard/sdk/ansi";
import {
  type ConsoleFilter,
  type ConsoleLevel,
  consoleLevel,
  matchesFilter,
} from "@gamedashboard/sdk/console-text";

/**
 * La console d'un serveur, côté application : les lignes gardées, leur
 * niveau, et les relevés que le daemon envoie chaque seconde.
 *
 * Mêmes règles que la console web (`@gamedashboard/sdk/console-text`) : un
 * niveau en capitales et en mot entier, la suite d'une trace Java rangée avec
 * son erreur. Les couleurs du terminal sont retirées : un téléphone affiche
 * une ligne lisible, pas un terminal.
 */

export interface LigneConsole {
  id: number;
  texte: string;
  niveau: ConsoleLevel | null;
  source: "system" | "server";
}

/**
 * Lignes gardées en mémoire. Au-delà, les plus anciennes tombent : une console
 * de jeu peut écrire des milliers de lignes par minute, et rien de la console
 * n'est gardé hors de la mémoire (ADR 0010, « Données sur le téléphone »).
 */
export const LIGNES_MAX = 500;

/** Le préfixe que Wings colle à ses propres messages, retiré à l'affichage. */
const PREFIXE_DAEMON = /^\[Pterodactyl Daemon\]:?\s*/;

let suivant = 0;

export function ajouterLignes(
  lignes: readonly LigneConsole[],
  brutes: readonly string[],
): LigneConsole[] {
  const nouvelles = brutes.map((brute): LigneConsole => {
    const propre = stripAnsi(brute);
    const daemon = PREFIXE_DAEMON.test(propre);
    const texte = daemon ? propre.replace(PREFIXE_DAEMON, "") : propre;
    suivant += 1;
    return {
      id: suivant,
      texte,
      niveau: consoleLevel(texte),
      source: daemon ? "system" : "server",
    };
  });
  const toutes = [...lignes, ...nouvelles];
  return toutes.length > LIGNES_MAX ? toutes.slice(toutes.length - LIGNES_MAX) : toutes;
}

export function filtrerLignes(
  lignes: readonly LigneConsole[],
  filtre: ConsoleFilter,
): LigneConsole[] {
  return lignes.filter((ligne) =>
    matchesFilter({ text: ligne.texte, source: ligne.source, level: ligne.niveau }, filtre),
  );
}

export interface Releve {
  cpuPct: number;
  memoireOctets: number;
  memoireLimiteOctets: number;
  disqueOctets: number;
  dureeMs: number;
}

/** Le relevé `stats` du daemon ; `null` s'il est illisible, jamais une exception. */
export function lireReleve(brut: string): Releve | null {
  try {
    const s = JSON.parse(brut) as Record<string, unknown>;
    const nombre = (cle: string) => (typeof s[cle] === "number" ? (s[cle] as number) : null);
    const cpu = nombre("cpu_absolute");
    const memoire = nombre("memory_bytes");
    if (cpu === null || memoire === null) return null;
    return {
      cpuPct: cpu,
      memoireOctets: memoire,
      memoireLimiteOctets: nombre("memory_limit_bytes") ?? 0,
      disqueOctets: nombre("disk_bytes") ?? 0,
      dureeMs: nombre("uptime") ?? 0,
    };
  } catch {
    return null;
  }
}
