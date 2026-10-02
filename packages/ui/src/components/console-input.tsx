"use client";

import { cycleSuggestion, suggestCommands } from "@gamedashboard/sdk/console-text";
import { History, SendHorizontal, Terminal, Upload } from "lucide-react";
import { type FormEvent, useId, useRef, useState } from "react";
import { cn } from "../lib/cn";
import type { ConsoleLabels } from "./console";

export interface ConsoleInputProps {
  onSend?: (command: string) => void;
  onUpload?: () => void;
  disabled?: boolean;
  placeholder: string;
  labels: ConsoleLabels;
  /** Commandes déjà tapées, la plus récente en tête. */
  history: string[];
  /** Modèles de commandes déclarés par l'egg (`whitelist add <joueur>`). */
  commands: string[];
}

/**
 * La ligne de commande : `$`, saisie, dépôt, envoi.
 *
 * Deux listes se partagent les flèches, et la règle est simple : **tant que
 * des propositions sont ouvertes, les flèches s'y promènent** ; sinon, elles
 * remontent l'historique comme dans un terminal. Les propositions ne s'ouvrent
 * que sur une frappe — pas quand la flèche vient d'écrire une commande de
 * l'historique dans le champ, sans quoi la seconde flèche tomberait dans la
 * liste au lieu de remonter encore.
 */
export function ConsoleInput({
  onSend,
  onUpload,
  disabled,
  placeholder,
  labels,
  history,
  commands,
}: ConsoleInputProps) {
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(-1);
  const [typed, setTyped] = useState(false);
  const [active, setActive] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const suggestions =
    typed && !disabled ? suggestCommands(value, { history, declared: commands }) : [];
  const open = suggestions.length > 0;

  const accept = (next: string) => {
    setValue(next);
    setTyped(false);
    setActive(-1);
    inputRef.current?.focus();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const cmd = value.trim();
    if (!cmd || disabled) return;
    onSend?.(cmd);
    setCursor(-1);
    setTyped(false);
    setActive(-1);
    setValue("");
  };

  const browse = (step: 1 | -1) => {
    const next = Math.max(-1, Math.min(cursor + step, history.length - 1));
    setCursor(next);
    setValue(next === -1 ? "" : (history[next] ?? ""));
  };

  return (
    <form onSubmit={submit} className="relative border-t border-border bg-surface px-4 py-3">
      {open ? (
        <div
          id={listId}
          role="listbox"
          tabIndex={-1}
          aria-label={labels.suggestions}
          className="gd-mono absolute right-4 bottom-full left-4 mb-1 max-h-64 overflow-y-auto rounded-field border border-border bg-surface p-1 text-sm shadow-lg"
        >
          {suggestions.map((s, index) => (
            <div
              key={`${s.from}-${s.label}`}
              tabIndex={-1}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              // `mousedown` et non `click` : le clic ferait d'abord perdre le
              // focus au champ, et la liste disparaîtrait avant d'être lue.
              onMouseDown={(e) => {
                e.preventDefault();
                accept(s.value);
              }}
              className="flex cursor-pointer items-center gap-2 rounded-xs px-2 py-1 text-fg aria-selected:bg-accent-soft"
            >
              {s.from === "history" ? (
                <History className="size-3.5 shrink-0 text-faint" aria-label={labels.fromHistory} />
              ) : (
                <Terminal className="size-3.5 shrink-0 text-faint" aria-label={labels.fromEgg} />
              )}
              <span className="truncate">{s.label}</span>
            </div>
          ))}
        </div>
      ) : null}
      <div className="flex items-center gap-3">
        <span className="gd-mono font-bold text-accent text-base">$</span>
        <input
          ref={inputRef}
          value={value}
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setValue(e.target.value);
            setTyped(true);
            setActive(-1);
            setCursor(-1);
          }}
          onBlur={() => setTyped(false)}
          onKeyDown={(e) => {
            if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
              e.preventDefault();
              const step = e.key === "ArrowDown" ? 1 : -1;
              setActive((a) => cycleSuggestion(a, step, suggestions.length));
            } else if (open && e.key === "Tab") {
              e.preventDefault();
              accept(suggestions[Math.max(active, 0)]?.value ?? value);
            } else if (open && e.key === "Enter" && active >= 0) {
              e.preventDefault();
              accept(suggestions[active]?.value ?? value);
            } else if (open && e.key === "Escape") {
              e.preventDefault();
              setTyped(false);
              setActive(-1);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              browse(1);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              browse(-1);
            }
          }}
          disabled={disabled}
          placeholder={placeholder}
          className="gd-mono min-w-0 flex-1 bg-transparent text-fg text-sm outline-none placeholder:text-faint focus:shadow-none"
          aria-label={labels.command}
        />
        {onUpload ? (
          <button
            type="button"
            onClick={onUpload}
            className="cursor-pointer text-muted hover:text-fg"
            aria-label={labels.upload}
          >
            <Upload className="size-5" />
          </button>
        ) : null}
        <button
          type="submit"
          disabled={disabled}
          className={cn("cursor-pointer text-muted hover:text-accent disabled:opacity-40")}
          aria-label={labels.send}
        >
          <SendHorizontal className="size-5" />
        </button>
      </div>
    </form>
  );
}
