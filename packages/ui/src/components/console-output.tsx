"use client";

import type { AnsiColor, AnsiSegment } from "@gamedashboard/sdk/ansi";
import { linkify, splitMatches } from "@gamedashboard/sdk/console-text";
import { memo } from "react";
import { cn } from "../lib/cn";
import type { ConsoleLine } from "./console";

/**
 * Classe de chaque couleur, écrite en entier : Tailwind ne génère que les
 * classes qu'il lit dans le source, et c'est aussi ce qui garantit qu'aucune
 * valeur venue du flux n'atteint l'attribut `class`.
 */
const COLOR_CLASS: Record<AnsiColor, string> = {
  black: "text-ansi-black",
  red: "text-ansi-red",
  green: "text-ansi-green",
  yellow: "text-ansi-yellow",
  blue: "text-ansi-blue",
  magenta: "text-ansi-magenta",
  cyan: "text-ansi-cyan",
  white: "text-ansi-white",
  "bright-black": "text-ansi-bright-black",
  "bright-red": "text-ansi-bright-red",
  "bright-green": "text-ansi-bright-green",
  "bright-yellow": "text-ansi-bright-yellow",
  "bright-blue": "text-ansi-bright-blue",
  "bright-magenta": "text-ansi-bright-magenta",
  "bright-cyan": "text-ansi-bright-cyan",
  "bright-white": "text-ansi-bright-white",
};

function segmentClass(segment: AnsiSegment): string | undefined {
  const classes = cn(
    segment.color && COLOR_CLASS[segment.color],
    segment.bold && "font-bold",
    segment.dim && "opacity-70",
    segment.italic && "italic",
    segment.underline && "underline",
  );
  return classes === "" ? undefined : classes;
}

/** Le texte d'un morceau, avec ses occurrences de recherche surlignées. */
function Matches({ text, query }: { text: string; query: string }) {
  return (
    <>
      {splitMatches(text, query).map((part, index) =>
        part.match ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: morceaux figés d'un texte qui ne change pas
          <mark key={index} className="rounded-xs bg-console-match text-console-match-fg">
            {part.text}
          </mark>
        ) : (
          part.text
        ),
      )}
    </>
  );
}

/**
 * Un morceau stylé : ses liens, puis ses occurrences.
 *
 * Un lien s'ouvre dans un nouvel onglet, sans `opener` ni référent : il vient
 * de la sortie d'un jeu, donc potentiellement d'un joueur, et la page qu'il
 * ouvre n'a rien à savoir du panel.
 */
function Segment({ segment, query }: { segment: AnsiSegment; query: string }) {
  return (
    <span className={segmentClass(segment)}>
      {linkify(segment.text).map((part, index) =>
        part.href ? (
          <a
            // biome-ignore lint/suspicious/noArrayIndexKey: morceaux figés d'un texte qui ne change pas
            key={index}
            href={part.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="underline decoration-dotted underline-offset-2 hover:decoration-solid"
          >
            <Matches text={part.text} query={query} />
          </a>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: morceaux figés d'un texte qui ne change pas
          <Matches key={index} text={part.text} query={query} />
        ),
      )}
    </span>
  );
}

/**
 * Une ligne de console.
 *
 * Mémorisée : la console en tient deux mille, et une ligne arrivée ne doit pas
 * faire redécouper les mille neuf cent quatre-vingt-dix-neuf autres.
 */
export const ConsoleLineView = memo(function ConsoleLineView({
  line,
  query,
}: {
  line: ConsoleLine;
  query: string;
}) {
  const segments = line.segments ?? [{ text: line.text }];
  return (
    /*
     * Les messages du panel et du daemon sont **surlignés**, pas seulement
     * colorés : ils se perdaient au milieu de la sortie du jeu, qui défile vite
     * et porte déjà ses propres couleurs. Un fond et un filet à gauche les
     * détachent du flux, comme un trait de surligneur sur une page imprimée.
     */
    <div
      className={cn(
        "whitespace-pre-wrap break-all",
        line.source === "system" &&
          "-mx-2 my-0.5 rounded-field border-warning border-l-2 bg-warning/12 px-2 py-0.5 text-warning-ink",
      )}
    >
      {line.source === "system" ? (
        <span className="mr-2 font-semibold text-warning-ink/80">[{line.label ?? "System"}]</span>
      ) : null}
      {segments.map((segment, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: morceaux figés d'une ligne qui ne change pas
        <Segment key={index} segment={segment} query={query} />
      ))}
    </div>
  );
});
