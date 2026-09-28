"use client";

import {
  AlertBanner,
  Badge,
  Button,
  Dialog,
  DialogContent,
  EmptyState,
  FormField,
  Input,
  RelativeTime,
} from "@gamedashboard/ui";
import { Check, DownloadCloud, Plus, RefreshCw, Search, SearchX } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useDeferredValue, useMemo, useState, useTransition } from "react";
import type { EggCatalogueEntry, EggCatalogueRead, EggCatalogueSource } from "@/server/api/admin";
import { importEgg, importEggFromCatalogue, syncEggSource } from "@/server/api/admin-actions";

/**
 * Au-delà, on cesse d'afficher des lignes.
 *
 * Le dépôt officiel en compte plus de deux cent cinquante ; les rendre toutes
 * fait une fenêtre qu'on ne parcourt pas. Quarante tiennent à l'écran et
 * suffisent à voir que la recherche a trouvé — au-delà, on précise la requête.
 */
const MAX_RESULTS = 40;

/**
 * Ajout d'un egg : on cherche, on clique, c'est fini.
 *
 * Remplace la gestion de dépôts qui précédait. Ajouter une source puis
 * synchroniser deux cent cinquante recettes est le bon geste une fois par
 * installation, et le mauvais toutes les autres fois : ce qu'on veut
 * d'ordinaire, c'est **un** jeu précis.
 *
 * Le dépôt officiel est posé tout seul à la première ouverture ; la
 * synchronisation complète reste accessible, mais redevient le geste rare
 * qu'elle est.
 */
export function AdminEggImport({
  source,
  entries,
  catalogueError = null,
  catalogueStaleSince = null,
}: {
  source: EggCatalogueSource | null;
  entries: EggCatalogueEntry[];
  /** Le dépôt n'a pas pu être lu : recherche et synchronisation attendent. */
  catalogueError?: EggCatalogueRead["error"];
  /** Liste gardée en mémoire, GitHub ne répondant plus : date de sa lecture. */
  catalogueStaleSince?: string | null;
}) {
  const t = useTranslations("adminEggs");
  const tc = useTranslations("common");
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [searching, setSearching] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [query, setQuery] = useState("");
  const [raw, setRaw] = useState("");
  const [nest, setNest] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Chemin en cours d'import, pour n'animer que la ligne concernée. */
  const [importing, setImporting] = useState<string | null>(null);

  /*
   * `useDeferredValue` : le filtrage porte sur plusieurs centaines de lignes à
   * chaque frappe. Différer le rendu de la liste garde le champ réactif — c'est
   * lui qu'on regarde en tapant, pas les résultats.
   */
  const deferred = useDeferredValue(query);

  const results = useMemo(() => {
    const needle = deferred.trim().toLowerCase();
    const matching = needle
      ? entries.filter(
          (entry) =>
            entry.name.toLowerCase().includes(needle) ||
            entry.group.toLowerCase().includes(needle) ||
            entry.path.toLowerCase().includes(needle),
        )
      : entries;

    // Ce qui n'est pas encore installé d'abord : c'est ce qu'on est venu
    // chercher. Les eggs déjà présents restent visibles, pour qu'on cesse de
    // les chercher.
    return [...matching]
      .sort((a, b) => {
        if (!a.installedId !== !b.installedId) return a.installedId ? 1 : -1;
        return a.name.localeCompare(b.name);
      })
      .slice(0, MAX_RESULTS);
  }, [entries, deferred]);

  const reset = () => {
    setError(null);
    setNotice(null);
  };

  const add = (entry: EggCatalogueEntry) =>
    startTransition(async () => {
      reset();
      setImporting(entry.path);
      const result = await importEggFromCatalogue(source?.id ?? "", entry.path);
      setImporting(null);

      if (result.error) {
        setError(result.error);
        return;
      }
      setNotice(t("importedOne", { name: result.name ?? entry.name }));
      router.refresh();
    });

  const importPasted = () =>
    startTransition(async () => {
      reset();
      try {
        JSON.parse(raw);
      } catch {
        setError(t("invalidJson"));
        return;
      }

      const result = await importEgg(raw, nest);
      if (result.error) {
        setError(result.error);
        return;
      }
      setPasting(false);
      setRaw("");
      setNotice(t("importDone"));
      router.refresh();
    });

  const syncAll = () =>
    startTransition(async () => {
      reset();
      const result = await syncEggSource(source?.id ?? "");
      if (result.error || !result.report) {
        setError(result.error ?? tc("actionRefused"));
        return;
      }
      const { created, updated, skippedLocallyModified, failed } = result.report;
      setNotice(
        t("syncReport", {
          created,
          updated,
          skipped: skippedLocallyModified,
          failed: failed.length,
        }),
      );
      router.refresh();
    });

  return (
    <div className="flex flex-col gap-4">
      {/* `flex-wrap` : sur un téléphone les trois boutons passent à la ligne
          plutôt que de déborder ou de rétrécir jusqu'à l'illisible. */}
      <div className="flex flex-wrap gap-2">
        <Button disabled={!source} onClick={() => setSearching(true)}>
          <Search /> {t("addEgg")}
        </Button>
        <Button variant="secondary" onClick={() => setPasting(true)}>
          <Plus /> {t("import")}
        </Button>
        <Button variant="ghost" disabled={pending || !source} onClick={syncAll}>
          <RefreshCw /> {t("syncAll")}
        </Button>
      </div>

      {catalogueError ? (
        <AlertBanner variant="warning" title={t("catalogueUnavailable")}>
          {catalogueError.reason ?? t("catalogueNoAnswer")} {t("catalogueUnavailableHint")}
        </AlertBanner>
      ) : null}
      {catalogueStaleSince ? (
        <AlertBanner variant="warning" title={t("catalogueStale")}>
          {t.rich("catalogueStaleHint", {
            time: () => <RelativeTime value={catalogueStaleSince} />,
          })}
        </AlertBanner>
      ) : null}
      {error ? (
        <AlertBanner variant="danger" title={tc("actionRefused")} dismissible>
          {error}
        </AlertBanner>
      ) : null}
      {notice ? (
        <AlertBanner variant="success" title={tc("done")} dismissible>
          {notice}
        </AlertBanner>
      ) : null}

      {/* --- Recherche dans le dépôt --- */}
      <Dialog open={searching} onOpenChange={setSearching}>
        <DialogContent
          title={t("addEgg")}
          description={source ? t("searchHint", { repo: source.name }) : undefined}
        >
          <div className="flex flex-col gap-4">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("searchPlaceholder")}
              leadingIcon={<Search />}
            />

            {results.length === 0 ? (
              <EmptyState icon={<SearchX />} title={t("noMatch")} description={t("noMatchHint")} />
            ) : (
              <div className="flex flex-col divide-y divide-border">
                {results.map((entry) => (
                  <div
                    key={entry.path}
                    className="flex flex-wrap items-center gap-3 py-2.5 first:pt-0"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold text-fg text-sm">{entry.name}</p>
                      <p className="truncate text-muted text-xs">{entry.group}</p>
                    </div>

                    {entry.installedId ? (
                      <Badge variant={entry.enabled ? "success" : "neutral"}>
                        {entry.enabled ? t("installedEnabled") : t("installed")}
                      </Badge>
                    ) : null}

                    <Button
                      size="sm"
                      variant={entry.installedId ? "ghost" : "secondary"}
                      disabled={pending}
                      loading={importing === entry.path}
                      onClick={() => add(entry)}
                    >
                      {entry.installedId ? <Check /> : <DownloadCloud />}
                      {entry.installedId ? t("reimport") : t("add")}
                    </Button>
                  </div>
                ))}

                {/* Le nombre total est dit quand la liste est tronquée : sans
                    lui, on croirait que le dépôt ne contient que ces lignes. */}
                {entries.length > results.length ? (
                  <p className="pt-3 text-center text-faint text-xs">
                    {t("truncated", { shown: results.length, total: entries.length })}
                  </p>
                ) : null}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* --- Coller un fichier --- */}
      <Dialog open={pasting} onOpenChange={setPasting}>
        <DialogContent
          title={t("import")}
          description={t("importHint")}
          footer={
            <Button disabled={pending || raw.trim() === ""} onClick={importPasted}>
              <DownloadCloud /> {t("importAction")}
            </Button>
          }
        >
          <div className="flex flex-col gap-4">
            <FormField label={t("nestLabel")} description={t("nestHint")}>
              {(id) => (
                <Input
                  id={id}
                  value={nest}
                  onChange={(e) => setNest(e.target.value)}
                  placeholder="Minecraft"
                />
              )}
            </FormField>

            <FormField label={t("fileLabel")}>
              {(id) => (
                <textarea
                  id={id}
                  value={raw}
                  onChange={(e) => setRaw(e.target.value)}
                  rows={12}
                  spellCheck={false}
                  placeholder='{ "meta": { "version": "PTDL_v2" }, "name": "…", … }'
                  className="gd-mono w-full rounded-field border border-border bg-surface-2 p-3 text-fg text-xs"
                />
              )}
            </FormField>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
