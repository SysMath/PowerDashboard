"use client";

import type { ConsoleFilter, ConsoleLevel } from "@gamedashboard/sdk/console-text";
import { Search, X } from "lucide-react";
import { cn } from "../lib/cn";
import type { ConsoleLabels } from "./console";

const SOURCES = ["all", "server", "system"] as const;
const LEVELS: ConsoleLevel[] = ["error", "warn", "info"];

/** Pastille de niveau : le ton qui dit la gravité, sans couleur en dur. */
const LEVEL_TONE: Record<ConsoleLevel, string> = {
  error: "aria-pressed:bg-danger-soft aria-pressed:text-danger-ink aria-pressed:border-danger",
  warn: "aria-pressed:bg-warning-soft aria-pressed:text-warning-ink aria-pressed:border-warning",
  info: "aria-pressed:bg-info-soft aria-pressed:text-info-ink aria-pressed:border-info",
};

export interface ConsoleToolbarProps {
  filter: ConsoleFilter;
  onChange: (filter: ConsoleFilter) => void;
  labels: ConsoleLabels;
  /** Lignes montrées et lignes tenues, pour dire ce que le filtre cache. */
  shown: number;
  total: number;
}

/**
 * Au-dessus de la sortie : la source (Tout / Serveur / Système), les niveaux,
 * la recherche.
 *
 * Les niveaux s'additionnent (erreurs **et** avertissements), la source non :
 * on regarde le jeu ou le panel, rarement les deux moitiés à la fois.
 */
export function ConsoleToolbar({ filter, onChange, labels, shown, total }: ConsoleToolbarProps) {
  const toggle = (level: ConsoleLevel) =>
    onChange({
      ...filter,
      levels: filter.levels.includes(level)
        ? filter.levels.filter((l) => l !== level)
        : [...filter.levels, level],
    });

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-2">
      <fieldset className="flex rounded-field bg-surface-2 p-0.5">
        <legend className="sr-only">{labels.source}</legend>
        {SOURCES.map((source) => (
          <button
            key={source}
            type="button"
            aria-pressed={filter.source === source}
            onClick={() => onChange({ ...filter, source })}
            className="cursor-pointer rounded-xs px-2.5 py-1 font-semibold text-muted text-xs hover:text-fg aria-pressed:bg-surface aria-pressed:text-fg aria-pressed:shadow-card"
          >
            {labels.sources[source]}
          </button>
        ))}
      </fieldset>

      <fieldset className="flex gap-1">
        <legend className="sr-only">{labels.levels}</legend>
        {LEVELS.map((level) => (
          <button
            key={level}
            type="button"
            aria-pressed={filter.levels.includes(level)}
            onClick={() => toggle(level)}
            className={cn(
              "cursor-pointer rounded-full border border-border px-2.5 py-0.5 font-semibold text-muted text-xs hover:text-fg",
              LEVEL_TONE[level],
            )}
          >
            {labels.levelNames[level]}
          </button>
        ))}
      </fieldset>

      <label className="ml-auto flex min-w-40 flex-1 items-center gap-2 rounded-field border border-border bg-surface-2 px-2 py-1 sm:max-w-72">
        <Search className="size-4 shrink-0 text-faint" aria-hidden />
        <input
          type="search"
          value={filter.query}
          onChange={(e) => onChange({ ...filter, query: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Escape") onChange({ ...filter, query: "" });
          }}
          placeholder={labels.search}
          aria-label={labels.search}
          className="min-w-0 flex-1 bg-transparent text-fg text-sm outline-none placeholder:text-faint focus:shadow-none"
        />
        {filter.query ? (
          <button
            type="button"
            onClick={() => onChange({ ...filter, query: "" })}
            aria-label={labels.clearSearch}
            className="cursor-pointer text-faint hover:text-fg"
          >
            <X className="size-4" />
          </button>
        ) : null}
      </label>

      {shown !== total ? (
        <span className="text-faint text-xs" aria-live="polite">
          {labels.shown(shown, total)}
        </span>
      ) : null}
    </div>
  );
}
