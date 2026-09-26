"use client";

import {
  AlertBanner,
  Badge,
  Button,
  type ColumnDef,
  DataTable,
  EmptyState,
  Input,
  PageHeader,
  PageTemplate,
  RelativeTime,
  SelectMenu,
  Switch,
} from "@gamedashboard/ui";
import { Egg, Pencil, Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useMemo, useState, useTransition } from "react";
import type {
  AdminEgg,
  EggCatalogueEntry,
  EggCatalogueRead,
  EggCatalogueSource,
} from "@/server/api/admin";
import { setEggEnabled } from "@/server/api/admin-actions";
import { AdminEggExportButton } from "./admin-egg-export-button";
import { AdminEggImport } from "./admin-egg-import";

export function AdminEggs({
  initial,
  source,
  entries,
  catalogueError = null,
  catalogueStaleSince = null,
}: {
  initial: AdminEgg[];
  source: EggCatalogueSource | null;
  entries: EggCatalogueEntry[];
  catalogueError?: EggCatalogueRead["error"];
  catalogueStaleSince?: string | null;
}) {
  const t = useTranslations("adminEggs");
  const tc = useTranslations("common");
  const router = useRouter();
  const eggs = initial;
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const run = useCallback(
    (action: () => Promise<{ error: string | null }>) =>
      startTransition(async () => {
        const result = await action();
        setError(result.error);
        if (!result.error) router.refresh();
      }),
    [router],
  );

  const [query, setQuery] = useState("");
  const [nest, setNest] = useState("all");

  const nests = useMemo(
    () => [...new Set(eggs.map((egg) => egg.nest))].sort((a, b) => a.localeCompare(b)),
    [eggs],
  );

  /**
   * La recherche porte aussi sur la description.
   *
   * Un egg se cherche par le nom du jeu, mais parfois par ce qu'il fait — « mod
   * loader », « proxy ». Le nom seul obligerait à connaître l'intitulé exact
   * choisi par l'auteur du fichier.
   */
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return eggs.filter((egg) => {
      if (nest !== "all" && egg.nest !== nest) return false;
      if (!needle) return true;
      return (
        egg.name.toLowerCase().includes(needle) ||
        egg.nest.toLowerCase().includes(needle) ||
        (egg.description ?? "").toLowerCase().includes(needle)
      );
    });
  }, [eggs, query, nest]);

  const columns = useMemo<ColumnDef<AdminEgg, unknown>[]>(
    () => [
      {
        accessorKey: "name",
        header: t("columnEgg"),
        cell: ({ row }) => (
          /*
           * La largeur est bornée ici, et pas seulement tronquée.
           *
           * `truncate` ne peut rien couper tant que rien ne contraint la
           * cellule : un tableau se dimensionne sur son contenu, et une
           * description de trois lignes élargissait la table bien au-delà de
           * l'écran. Le texte débordait alors à droite, sur toutes les tailles.
           *
           * La borne suit la place disponible plutôt qu'une valeur fixe :
           * large sur un écran de bureau, étroite sur un téléphone, sans
           * jamais pousser la table hors du cadre.
           */
          <div className="min-w-0 max-w-[min(32rem,55vw)]">
            <p className="font-semibold text-fg">{row.original.name}</p>
            <p className="truncate text-xs text-muted">{row.original.description}</p>
          </div>
        ),
      },
      {
        accessorKey: "image",
        header: t("columnImage"),
        cell: ({ getValue }) => (
          <span className="gd-mono text-xs text-muted">{getValue() as string}</span>
        ),
      },
      {
        accessorKey: "servers",
        header: t("columnServers"),
        cell: ({ getValue }) => <Badge variant="accent">{getValue() as number}</Badge>,
      },
      {
        accessorKey: "updatedAt",
        header: t("columnUpdated"),
        cell: ({ getValue }) => (
          <RelativeTime className="text-muted" value={getValue() as string} />
        ),
      },
      {
        id: "enabled",
        header: t("columnEnabled"),
        size: 140,
        cell: ({ row }) => (
          <Switch
            checked={row.original.enabled}
            disabled={pending}
            aria-label={t("enableLabel", { name: row.original.name })}
            onCheckedChange={(next) => run(() => setEggEnabled(row.original.id, next))}
          />
        ),
      },
      {
        id: "actions",
        header: t("columnActions"),
        cell: ({ row }) => (
          // Des actions nommées plutôt que des icônes seules : « Modifier » et
          // « Exporter » se lisent sans survoler quoi que ce soit.
          <div className="flex flex-wrap justify-end gap-2">
            <Button asChild size="sm" variant="secondary">
              <Link href={`/admin/eggs/${row.original.id}`}>
                <Pencil /> {t("edit")}
              </Link>
            </Button>
            <AdminEggExportButton eggId={row.original.id} size="sm" variant="ghost" />
          </div>
        ),
      },
    ],
    [pending, run, t],
  );

  return (
    <PageTemplate
      header={<PageHeader icon={<Egg />} title={t("title")} subtitle={t("subtitle")} />}
      toolbar={
        <AdminEggImport
          source={source}
          entries={entries}
          catalogueError={catalogueError}
          catalogueStaleSince={catalogueStaleSince}
        />
      }
    >
      {error ? (
        <AlertBanner variant="danger" title={tc("actionRefused")} dismissible>
          {error}
        </AlertBanner>
      ) : null}

      {/*
       * Une recherche et un filtre, et non une barre d'onglets.
       *
       * Le dépôt officiel produit cent soixante-neuf familles : autant
       * d'onglets ne tiennent sur aucun écran, débordent en une bande qu'on
       * fait glisser sans rien y lire, et rendent introuvable la famille qu'on
       * cherche. Un champ de recherche répond à la question réelle — « où est
       * Palworld » — en une frappe.
       */}
      <div className="flex flex-wrap gap-3">
        <Input
          className="min-w-56 flex-1"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("filterPlaceholder")}
          leadingIcon={<Search />}
        />
        <SelectMenu
          className="w-full sm:w-64"
          value={nest}
          onValueChange={setNest}
          aria-label={t("filterFamily")}
          options={[
            { value: "all", label: t("allFamilies", { count: eggs.length }) },
            ...nests.map((name) => ({
              value: name,
              label: name,
              description: t("familyCount", {
                count: eggs.filter((egg) => egg.nest === name).length,
              }),
            })),
          ]}
        />
      </div>

      <DataTable
        columns={columns}
        data={filtered}
        getRowId={(row) => row.id}
        emptyState={
          <EmptyState icon={<Egg />} title={eggs.length === 0 ? t("empty") : t("emptyFiltered")} />
        }
      />
    </PageTemplate>
  );
}
