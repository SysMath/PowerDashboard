"use client";

import { formatBytes } from "@gamedashboard/sdk/format";
import { ChevronRight, File, FileArchive, FileCode, FileText, Folder, Home } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/cn";
import { EmptyState } from "./empty-state";
import { RelativeTime } from "./relative-time";
import { Skeleton } from "./skeleton";

export interface FileEntry {
  name: string;
  isDirectory: boolean;
  size: number;
  mode: string;
  modifiedAt: string;
}

const CODE_EXT = new Set(["js", "ts", "json", "yml", "yaml", "toml", "sh", "java", "lua", "cfg"]);
const ARCHIVE_EXT = new Set(["zip", "tar", "gz", "zst", "rar", "7z", "jar"]);
const TEXT_EXT = new Set(["txt", "md", "log", "properties"]);

function iconFor(entry: FileEntry) {
  if (entry.isDirectory) return <Folder className="text-accent" />;
  const ext = entry.name.split(".").pop()?.toLowerCase() ?? "";
  if (CODE_EXT.has(ext)) return <FileCode className="text-info-ink" />;
  if (ARCHIVE_EXT.has(ext)) return <FileArchive className="text-warning-ink" />;
  if (TEXT_EXT.has(ext)) return <FileText className="text-muted" />;
  return <File className="text-muted" />;
}

export interface FileBrowserProps {
  path: string;
  entries: FileEntry[] | undefined;
  isLoading?: boolean;
  onNavigate: (path: string) => void;
  onOpenFile?: (entry: FileEntry, path: string) => void;
  rowActions?: (entry: FileEntry) => ReactNode;
  emptyState?: ReactNode;
  /** Libellés du dossier vide, pour les applications traduites. */
  /** Libellé accessible du fil d'Ariane, pour les applications traduites. */
  pathLabel?: string;
  emptyTitle?: string;
  emptyDescription?: string;
  className?: string;
}

/**
 * Navigateur de fichiers : fil d'Ariane cliquable, dossiers d'abord, icône par type.
 * L'upload et le glisser-déposer viendront en phase 2 avec le daemon.
 */
export function FileBrowser({
  path,
  entries,
  isLoading,
  onNavigate,
  onOpenFile,
  rowActions,
  emptyState,
  pathLabel = "Chemin",
  emptyTitle = "Dossier vide",
  emptyDescription = "Aucun fichier dans ce répertoire.",
  className,
}: FileBrowserProps) {
  const segments = path.split("/").filter(Boolean);
  const sorted = entries
    ? [...entries].sort((a, b) =>
        a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1,
      )
    : undefined;

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <nav aria-label={pathLabel} className="flex flex-wrap items-center gap-1 text-sm">
        <button
          type="button"
          onClick={() => onNavigate("/")}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-xs px-2 py-1 font-semibold text-muted transition-colors hover:bg-surface-2 hover:text-fg"
        >
          <Home className="size-4" />
          container
        </button>
        {segments.map((seg, i) => {
          const target = `/${segments.slice(0, i + 1).join("/")}`;
          const last = i === segments.length - 1;
          return (
            <span key={target} className="flex items-center gap-1">
              <ChevronRight className="size-3.5 text-faint" />
              <button
                type="button"
                onClick={() => onNavigate(target)}
                className={cn(
                  "cursor-pointer rounded-xs px-2 py-1 transition-colors hover:bg-surface-2",
                  last ? "font-semibold text-fg" : "text-muted hover:text-fg",
                )}
              >
                {seg}
              </button>
            </span>
          );
        })}
      </nav>

      <div className="overflow-x-auto rounded-card border border-border bg-surface shadow-card">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <thead className="bg-surface-2/60">
            <tr>
              <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-muted">
                Nom
              </th>
              <th className="w-28 px-5 py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-muted">
                Taille
              </th>
              <th className="w-24 px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-muted">
                Droits
              </th>
              <th className="w-44 px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-muted">
                Modifié
              </th>
              {rowActions ? <th className="w-14 px-5 py-3" /> : null}
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              Array.from({ length: 6 }).map((_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: squelette
                <tr key={i} className="border-t border-border">
                  <td className="px-5 py-3.5" colSpan={rowActions ? 5 : 4}>
                    <Skeleton className="h-4 w-1/3" />
                  </td>
                </tr>
              ))
            ) : !sorted?.length ? (
              <tr>
                <td colSpan={rowActions ? 5 : 4}>
                  {emptyState ?? (
                    <EmptyState
                      icon={<Folder />}
                      title={emptyTitle}
                      description={emptyDescription}
                    />
                  )}
                </td>
              </tr>
            ) : (
              sorted.map((entry) => (
                <tr
                  key={entry.name}
                  className="border-t border-border transition-colors hover:bg-surface-2/60"
                >
                  <td className="px-5 py-3.5">
                    <button
                      type="button"
                      onClick={() =>
                        entry.isDirectory
                          ? onNavigate(`${path === "/" ? "" : path}/${entry.name}`)
                          : onOpenFile?.(entry, path)
                      }
                      className="flex cursor-pointer items-center gap-2.5 text-left [&_svg]:size-[18px] [&_svg]:shrink-0"
                    >
                      {iconFor(entry)}
                      <span
                        className={cn(
                          "truncate",
                          entry.isDirectory ? "font-semibold text-fg" : "text-fg",
                        )}
                      >
                        {entry.name}
                      </span>
                    </button>
                  </td>
                  <td className="px-5 py-3.5 text-right text-muted">
                    {entry.isDirectory ? "—" : formatBytes(entry.size)}
                  </td>
                  <td className="gd-mono px-5 py-3.5 text-xs text-muted">{entry.mode}</td>
                  <td className="px-5 py-3.5">
                    <RelativeTime className="text-muted" value={entry.modifiedAt} />
                  </td>
                  {rowActions ? <td className="px-5 py-3.5">{rowActions(entry)}</td> : null}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
