"use client";

import {
  AlertBanner,
  Badge,
  Button,
  type ColumnDef,
  ConfirmDialog,
  DataTable,
  DropdownItem,
  DropdownSeparator,
  EmptyState,
  formatMb,
  Input,
  PageHeader,
  PageTemplate,
  RelativeTime,
  RowActions,
  SERVER_STATE_META,
  SelectMenu,
  type ServerCardState,
  StatusDot,
} from "@gamedashboard/ui";
import { ExternalLink, Pause, Play, Plus, Search, Server, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useMemo, useState, useTransition } from "react";
import { toCardState } from "@/lib/server-view";
import { useAutoRefresh } from "@/lib/use-auto-refresh";
import type { AdminServer } from "@/server/api/admin";
import { deleteServer, setServerSuspended } from "@/server/api/admin-actions";

/**
 * Les états affichables ici sont **ceux de tout le panel**.
 *
 * Ce fichier tenait sa propre table — cinq états de gestion, et un « inconnu »
 * pour tout le reste — avec ce commentaire : « l’état réel du conteneur
 * appartient à Wings, que le panel ne relaie pas encore ». Il le relaie
 * pourtant, et depuis longtemps : la liste client compose déjà l’état de
 * gestion et le dernier relevé. Seule cette liste-ci ne l’avait pas reçu, et
 * affichait donc « État inconnu » sur des serveurs mesurés chaque minute.
 *
 * Le vocabulaire est donc celui du reste du panel : même composition, mêmes
 * couleurs, mêmes libellés. Une seconde table aurait recommencé à diverger.
 */
const FILTRABLES: ServerCardState[] = [
  "running",
  "offline",
  "starting",
  "stopping",
  "installing",
  "install_failed",
  "suspended",
  "restoring",
  "transferring",
  // Filtrable comme les autres : quand une machine tombe, la première question
  // d'un exploitant est « lesquels sont touchés ? ».
  "unknown",
];

export function AdminServers({ initial }: { initial: AdminServer[] }) {
  const t = useTranslations("adminServers");
  const tc = useTranslations("common");
  // Les libellés d'état viennent du catalogue commun : les redéclarer ici les
  // ferait diverger de ceux que le client voit sur la même machine.
  const tState = useTranslations("serverState");
  const router = useRouter();

  // L'état d'un serveur vient de la base, que le relevé met à jour à la minute.
  // Sans cela, la liste reste figée sur l'instant où la page a été ouverte.
  useAutoRefresh();
  const servers = initial;
  const [error, setError] = useState<string | null>(null);
  // Comptes dont le node n'a pas confirmé la fermeture des sessions à la
  // suspension : la suspension est faite, mais une session SFTP a pu rester.
  const [sessionsLeft, setSessionsLeft] = useState(0);
  const [pending, startTransition] = useTransition();

  const run = useCallback(
    (action: () => Promise<{ error: string | null; sessionsNotClosed?: number }>) =>
      startTransition(async () => {
        const result = await action();
        setSessionsLeft(result.sessionsNotClosed ?? 0);
        setError(result.error);
        if (!result.error) router.refresh();
      }),
    [router],
  );
  const [query, setQuery] = useState("");
  const [node, setNode] = useState("all");
  const [state, setState] = useState("all");
  const [toDelete, setToDelete] = useState<AdminServer | null>(null);

  /**
   * Les nodes proposés au filtre sont ceux qui hébergent réellement un
   * serveur de la liste. Une liste figée montrerait des nodes disparus et
   * manquerait ceux ajoutés depuis.
   */
  const nodeOptions = useMemo(
    () =>
      [...new Set(servers.map((s) => s.node))]
        .sort()
        .map((name) => ({ value: name, label: name, group: t("nodes") })),
    [servers, t],
  );

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return servers.filter(
      (s) =>
        (node === "all" || s.node === node) &&
        (state === "all" || toCardState(s.state, s.runtimeState) === state) &&
        (!q ||
          s.name.toLowerCase().includes(q) ||
          s.id.includes(q) ||
          s.owner.toLowerCase().includes(q) ||
          s.ownerEmail.toLowerCase().includes(q)),
    );
  }, [servers, query, node, state]);

  const columns = useMemo<ColumnDef<AdminServer, unknown>[]>(
    () => [
      {
        accessorKey: "name",
        header: t("columnServer"),
        cell: ({ row }) => {
          const s = row.original;
          const display = toCardState(s.state, s.runtimeState);
          return (
            <div className="flex items-start gap-3">
              <StatusDot
                className="mt-1.5"
                tone={SERVER_STATE_META[display].tone}
                pulse={SERVER_STATE_META[display].pulse}
              />
              <div className="min-w-0">
                {/* Vers la fiche d'administration, et non vers l'espace
                    client : depuis cette liste on vient régler le serveur, pas
                    l'utiliser. La vue client reste à un clic de là. */}
                <Link
                  href={`/admin/servers/${s.id}`}
                  className="truncate font-semibold text-fg hover:text-accent"
                >
                  {s.name}
                </Link>
                <p className="gd-mono text-xs text-muted">{s.id}</p>
              </div>
            </div>
          );
        },
      },
      {
        accessorKey: "owner",
        header: t("columnOwner"),
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="truncate text-fg">{row.original.owner}</p>
            <p className="truncate text-xs text-muted">{row.original.ownerEmail}</p>
          </div>
        ),
      },
      {
        accessorKey: "node",
        header: t("columnNode"),
        cell: ({ row }) => (
          <div>
            <p className="text-muted">{row.original.node}</p>
            <p className="text-xs text-faint">{row.original.egg}</p>
          </div>
        ),
      },
      {
        accessorKey: "memoryMb",
        header: t("columnMemory"),
        cell: ({ getValue }) => (
          <span className="gd-mono text-muted">{formatMb(getValue() as number, 0)}</span>
        ),
      },
      {
        accessorKey: "state",
        header: t("columnState"),
        cell: ({ row }) => {
          const display = toCardState(row.original.state, row.original.runtimeState);
          return <Badge variant={SERVER_STATE_META[display].tone}>{tState(display)}</Badge>;
        },
      },
      {
        accessorKey: "createdAt",
        header: t("columnCreated"),
        cell: ({ getValue }) => (
          <RelativeTime className="text-muted" value={getValue() as string} />
        ),
      },
      {
        id: "actions",
        header: "",
        size: 60,
        cell: ({ row }) => {
          const s = row.original;
          return (
            <RowActions>
              <DropdownItem icon={<ExternalLink />} onSelect={() => router.push(`/server/${s.id}`)}>
                {t("open")}
              </DropdownItem>
              {/* Suspendre ne coupe pas le conteneur : le daemon refuse
                  démarrage et console pour un serveur suspendu, celui qui
                  tourne continue jusqu'à son prochain arrêt. */}
              <DropdownItem
                icon={s.state === "suspended" ? <Play /> : <Pause />}
                disabled={pending}
                onSelect={() => run(() => setServerSuspended(s.id, s.state !== "suspended"))}
              >
                {s.state === "suspended" ? t("resume") : t("suspend")}
              </DropdownItem>
              <DropdownSeparator />
              <DropdownItem icon={<Trash2 />} destructive onSelect={() => setToDelete(s)}>
                {tc("delete")}
              </DropdownItem>
            </RowActions>
          );
        },
      },
    ],
    [pending, run, router, t, tc, tState],
  );

  return (
    <PageTemplate
      header={
        <PageHeader
          icon={<Server />}
          title={t("title")}
          subtitle={t("subtitle", { shown: filtered.length, total: servers.length })}
          actions={
            <Button asChild>
              <Link href="/servers/new">
                <Plus /> {t("create")}
              </Link>
            </Button>
          }
        />
      }
      toolbar={
        <div className="flex flex-wrap gap-3">
          <Input
            className="min-w-64 flex-1"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("searchPlaceholder")}
            leadingIcon={<Search />}
          />
          <SelectMenu
            className="w-56"
            value={node}
            onValueChange={setNode}
            aria-label={t("filterNode")}
            options={[{ value: "all", label: t("allNodes") }, ...nodeOptions]}
          />
          <SelectMenu
            className="w-48"
            value={state}
            onValueChange={setState}
            aria-label={t("filterState")}
            options={[
              { value: "all", label: t("allStates") },
              ...FILTRABLES.map((value) => ({ value, label: tState(value) })),
            ]}
          />
        </div>
      }
    >
      {error ? (
        <AlertBanner variant="danger" title={tc("actionRefused")} dismissible>
          {error}
        </AlertBanner>
      ) : null}
      {sessionsLeft > 0 ? (
        <AlertBanner
          variant="warning"
          title={t("sessionsLeftTitle")}
          dismissible
          onDismiss={() => setSessionsLeft(0)}
        >
          {t("sessionsLeftBody", { count: sessionsLeft })}
        </AlertBanner>
      ) : null}

      <DataTable
        columns={columns}
        data={filtered}
        getRowId={(row) => row.id}
        emptyState={
          <EmptyState icon={<Search />} title={t("empty")} description={tc("adjustFilters")} />
        }
      />

      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(o) => !o && setToDelete(null)}
        title={t("deleteTitle")}
        description={t("deleteBody")}
        confirmLabel={tc("delete")}
        destructive
        requireTyped={toDelete?.id}
        onConfirm={() => {
          const target = toDelete;
          setToDelete(null);
          if (target) run(() => deleteServer(target.id));
        }}
      />
    </PageTemplate>
  );
}
