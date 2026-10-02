"use client";

import { closedSignals } from "@gamedashboard/contracts";
import { cn } from "../lib/cn";
import type { ServerCardState } from "./server-card";

/** La règle vit dans les contrats, partagée avec l'application mobile. */
export { closedSignals };

export type PowerSignal = "start" | "stop" | "restart" | "kill";

export interface PowerControlsProps {
  state: ServerCardState;
  onSignal: (signal: PowerSignal) => void;
  disabled?: boolean;
  /**
   * Un état de gestion du panel ferme tout : installation, restauration,
   * transfert, suspension. Distinct de `disabled`, qui dit « pas maintenant »
   * (socket fermée, ordre en vol) ; celui-ci dit « pas dans cet état ».
   */
  blocked?: boolean;
  /** Libellé accessible du groupe, pour les applications traduites. */
  label?: string;
  className?: string;
}

/** Groupe Start / Restart / Stop / Kill, l'action pertinente est mise en avant selon l'état. */

export function PowerControls({
  state,
  onSignal,
  disabled,
  blocked = false,
  label = "Alimentation",
  className,
}: PowerControlsProps) {
  const off = state === "offline" || state === "crash_loop";
  const closed = closedSignals(state, { disabled, blocked });
  const btn =
    "h-9 cursor-pointer px-4 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40";
  return (
    <div
      className={cn(
        "inline-flex overflow-hidden rounded-field border border-border bg-surface shadow-card",
        className,
      )}
      role="toolbar"
      aria-label={label}
    >
      <button
        type="button"
        disabled={closed.start}
        onClick={() => onSignal("start")}
        className={cn(
          btn,
          off ? "bg-accent text-accent-fg hover:bg-accent-600" : "text-muted hover:bg-surface-2",
        )}
      >
        Start
      </button>
      <button
        type="button"
        disabled={closed.restart}
        onClick={() => onSignal("restart")}
        className={cn(btn, "border-l border-border text-muted hover:bg-surface-2 hover:text-fg")}
      >
        Restart
      </button>
      <button
        type="button"
        disabled={closed.stop}
        onClick={() => onSignal("stop")}
        className={cn(btn, "border-l border-border text-muted hover:bg-surface-2 hover:text-fg")}
      >
        Stop
      </button>
      <button
        type="button"
        /*
         * `blocked` est écrit ici aussi, et pas déduit de `off`.
         *
         * Il l'était : `off` valait faux pendant un blocage, et « Kill » se
         * lisant `disabled || off` devenait donc **actif** — le seul des quatre
         * que le correctif avait ouvert au lieu de fermer. Une condition
         * exprimée par la négation d'une autre finit toujours par se retourner.
         */
        disabled={closed.kill}
        onClick={() => onSignal("kill")}
        className={cn(
          btn,
          "border-l border-border text-muted hover:bg-danger-soft hover:text-danger-ink",
        )}
      >
        Kill
      </button>
    </div>
  );
}
