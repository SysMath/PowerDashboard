"use client";

import type { AnsiSegment } from "@gamedashboard/sdk/ansi";
import {
  type ConsoleFilter,
  type ConsoleLevel,
  isFiltering,
  matchesFilter,
  NO_FILTER,
  pushHistory,
} from "@gamedashboard/sdk/console-text";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../lib/cn";
import { ConsoleInput } from "./console-input";
import { ConsoleLineView } from "./console-output";
import { ConsoleToolbar } from "./console-toolbar";

export interface ConsoleLine {
  id: string | number;
  /** Le texte nu, sans séquence d'échappement : c'est lui qu'on cherche et qu'on filtre. */
  text: string;
  /** Le même texte découpé par couleur (`parseAnsi`). Absent : `text` sans style. */
  segments?: AnsiSegment[];
  /** Niveau lu dans la ligne (`consoleLevel`). Absent : lu à la demande. */
  level?: ConsoleLevel | null;
  source?: "system" | "server";
  /**
   * Qui parle, pour les lignes qui ne viennent pas du jeu.
   *
   * Le daemon préfixe les siennes ; le panel remplace ce préfixe par un libellé
   * qui nomme la machine, et le passe ici plutôt que de le laisser dans le
   * texte : une étiquette séparée se met en valeur, un préfixe collé au texte
   * se confond avec la sortie du jeu.
   */
  label?: string;
}

/** Les textes de la console, pour les applications traduites. */
export interface ConsoleLabels {
  command: string;
  upload: string;
  send: string;
  waiting: string;
  noMatch: string;
  source: string;
  sources: Record<ConsoleFilter["source"], string>;
  levels: string;
  levelNames: Record<ConsoleLevel, string>;
  search: string;
  clearSearch: string;
  suggestions: string;
  fromHistory: string;
  fromEgg: string;
  shown: (shown: number, total: number) => string;
}

const DEFAULT_LABELS: ConsoleLabels = {
  command: "Commande",
  upload: "Téléverser",
  send: "Envoyer",
  waiting: "En attente de sortie…",
  noMatch: "Aucune ligne ne correspond au filtre.",
  source: "Source",
  sources: { all: "Tout", server: "Serveur", system: "Système" },
  levels: "Niveaux",
  levelNames: { error: "Erreurs", warn: "Avertissements", info: "Infos" },
  search: "Rechercher",
  clearSearch: "Effacer la recherche",
  suggestions: "Commandes proposées",
  fromHistory: "Déjà tapée",
  fromEgg: "Commande du jeu",
  shown: (shown, total) => `${shown} / ${total} lignes`,
};

export interface ConsoleViewProps {
  lines: ConsoleLine[];
  onSend?: (command: string) => void;
  onUpload?: () => void;
  disabled?: boolean;
  placeholder?: string;
  labels?: Partial<ConsoleLabels>;
  /**
   * Commandes déjà tapées, la plus récente en tête. Fourni avec
   * `onHistoryChange`, l'appelant le conserve (d'une visite à l'autre) ; sinon
   * la console en tient un en mémoire.
   */
  history?: string[];
  onHistoryChange?: (history: string[]) => void;
  /** Modèles de commandes du jeu, pour l'autocomplétion (`say <message>`). */
  commands?: string[];
  /** Masque la barre de filtres : une sortie d'installation n'a ni niveaux ni source. */
  hideToolbar?: boolean;
  className?: string;
  /** Hauteur de la zone de sortie. */
  height?: number | string;
}

/**
 * Console : barre de filtres, zone de sortie sombre monospace accrochée au bas,
 * champ de commande « $ » avec historique et autocomplétion.
 *
 * Rendue en texte HTML et non dans un terminal peint (xterm) : filtrer, chercher
 * et surligner reviennent ici à choisir quelles lignes rendre, les liens sont de
 * vrais liens, un lecteur d'écran lit la sortie, et la CSP à nonce n'a pas à
 * admettre de styles injectés.
 */
export function ConsoleView({
  lines,
  onSend,
  onUpload,
  disabled,
  placeholder = "Tapez une commande…",
  labels: given,
  history: givenHistory,
  onHistoryChange,
  commands = [],
  hideToolbar,
  className,
  height = 480,
}: ConsoleViewProps) {
  const labels = { ...DEFAULT_LABELS, ...given };
  const [ownHistory, setOwnHistory] = useState<string[]>([]);
  const history = givenHistory ?? ownHistory;
  const send = (command: string) => {
    onSend?.(command);
    const next = pushHistory(history, command);
    if (givenHistory === undefined) setOwnHistory(next);
    onHistoryChange?.(next);
  };
  const [filter, setFilter] = useState<ConsoleFilter>(NO_FILTER);
  // La frappe dans la recherche reste fluide : le filtrage de deux mille
  // lignes suit, un cran derrière, plutôt que de bloquer chaque touche.
  const deferred = useDeferredValue(filter);
  const outRef = useRef<HTMLDivElement>(null);

  const visible = useMemo(
    () => (isFiltering(deferred) ? lines.filter((l) => matchesFilter(l, deferred)) : lines),
    [lines, deferred],
  );
  const query = deferred.query.trim();

  /*
   * La console est **accrochée au bas** tant qu'on ne l'a pas remontée.
   *
   * L'ancienne règle — « ne suivre que si l'on est déjà près du bas » — se
   * retournait contre elle-même à l'ouverture : l'historique arrive d'un coup,
   * la zone était en haut, donc loin du bas, donc on ne descendait pas.
   *
   * L'accroche ne se défait que par un geste : remonter le texte. Elle se
   * reprend dès qu'on redescend au bas. Changer de filtre la reprend aussi :
   * on filtre pour voir ce qui se passe, pas pour relire le début.
   */
  const pinned = useRef(true);

  // biome-ignore lint/correctness/useExhaustiveDependencies: réaccroche à chaque changement de filtre
  useEffect(() => {
    pinned.current = true;
  }, [deferred]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll sur chaque nouvelle ligne
  useEffect(() => {
    const el = outRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [visible.length, lines.at(-1)?.id]);

  return (
    <div
      className={cn(
        "overflow-hidden rounded-card border border-border bg-surface shadow-card",
        className,
      )}
    >
      {hideToolbar ? null : (
        <ConsoleToolbar
          filter={filter}
          onChange={setFilter}
          labels={labels}
          shown={visible.length}
          total={lines.length}
        />
      )}
      <div
        ref={outRef}
        className="gd-mono overflow-y-auto bg-console-bg px-4 py-3 text-[13px] text-console-fg leading-6"
        style={{ height }}
        role="log"
        aria-live="polite"
        onScroll={(e) => {
          // Une marge de quelques pixels : le défilement fluide et les
          // arrondis de hauteur font rarement tomber sur le bas exact, et sans
          // cette marge la console se décrocherait toute seule.
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {lines.length === 0 ? (
          <p className="text-faint">{labels.waiting}</p>
        ) : visible.length === 0 ? (
          <p className="text-faint">{labels.noMatch}</p>
        ) : (
          visible.map((l) => <ConsoleLineView key={l.id} line={l} query={query} />)
        )}
      </div>
      <ConsoleInput
        onSend={onSend ? send : undefined}
        onUpload={onUpload}
        disabled={disabled}
        placeholder={placeholder}
        labels={labels}
        history={history}
        commands={commands}
      />
    </div>
  );
}
