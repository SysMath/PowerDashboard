"use client";

import {
  AlertBanner,
  Badge,
  Button,
  type ColumnDef,
  ConfirmDialog,
  DataTable,
  Dialog,
  DialogContent,
  DropdownItem,
  DropdownSeparator,
  EmptyState,
  formatBytes,
  Input,
  MetricBar,
  PageHeader,
  PageTemplate,
  RelativeTime,
  RowActions,
} from "@gamedashboard/ui";
import { Archive, Download, Lock, LockOpen, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useMemo, useState, useTransition } from "react";
import {
  type Backup,
  type BackupList,
  backupDownloadUrl,
  createBackup,
  deleteBackup,
  restoreBackup,
  setBackupLock,
} from "@/server/api/backups";
import {
  ServerBlockBanner,
  useBackupDeletionBlocked,
  useServerBlock,
} from "./server-block-context";

/**
 * Sauvegardes d'un serveur.
 *
 * La liste vient du serveur, rendue au chargement de la page ; les actions la
 * rafraîchissent. Rien n'est modifié en mémoire avant confirmation : une
 * sauvegarde qu'on croirait supprimée alors que le daemon a refusé réapparaît
 * au rechargement suivant, et la confiance dans l'écran est perdue.
 */
export function BackupsWorkspace({ serverId, initial }: { serverId: string; initial: BackupList }) {
  const t = useTranslations("backups");
  const tc = useTranslations("common");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [toDelete, setToDelete] = useState<Backup | null>(null);
  const [toRestore, setToRestore] = useState<Backup | null>(null);
  const [pending, startTransition] = useTransition();
  /*
   * Ce que le serveur refuse en ce moment.
   *
   * Toutes les actions ne tombent pas de la même façon, et les mêler serait
   * faux dans les deux sens : fabriquer une sauvegarde et en restaurer une
   * écrivent, donc l'API les refuse ; **supprimer** libère de la place et
   * **télécharger** ne fait que lire. Les interdire enfermerait quelqu'un dont
   * le serveur vient d'être suspendu avec un disque plein et ses archives hors
   * de portée.
   */
  const bloc = useServerBlock();
  const deletionBlocked = useBackupDeletionBlocked();

  const run = useCallback(
    (action: () => Promise<{ error: string | null }>) =>
      startTransition(async () => {
        const result = await action();
        setError(result.error);
        if (!result.error) router.refresh();
      }),
    [router],
  );

  const columns = useMemo<ColumnDef<Backup, unknown>[]>(
    () => [
      {
        accessorKey: "name",
        header: t("columnBackup"),
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="flex items-center gap-2 truncate font-semibold text-fg">
              {row.original.name}
              {row.original.isLocked ? (
                <Lock className="size-3.5 shrink-0 text-warning-ink" aria-label={t("locked")} />
              ) : null}
            </p>
            <p className="text-xs text-muted">
              {/* Une sauvegarde en cours n'a pas encore de taille connue : « — »
                  plutôt que « 0 o », qui décrirait une archive vide. */}
              {row.original.isSuccessful === null ? tc("none") : formatBytes(row.original.bytes)}
            </p>
          </div>
        ),
      },
      {
        accessorKey: "isSuccessful",
        header: t("columnState"),
        cell: ({ row }) =>
          row.original.isSuccessful === null ? (
            /* Le daemon travaille en arrière-plan et ne rapporte qu'à la fin :
               il n'existe aucun pourcentage à afficher, et en inventer un
               ferait croire à une progression mesurée. */
            <Badge variant="info">{t("inProgress")}</Badge>
          ) : row.original.isSuccessful ? (
            <Badge variant="success">{t("done")}</Badge>
          ) : (
            <Badge variant="danger">{t("failed")}</Badge>
          ),
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
          const backup = row.original;
          const busy = backup.isSuccessful === null || pending;
          return (
            <RowActions>
              <DropdownItem
                icon={<RotateCcw />}
                disabled={busy || bloc !== null || backup.isSuccessful !== true}
                onSelect={() => setToRestore(backup)}
              >
                {tc("restore")}
              </DropdownItem>
              {/*
               * L'adresse est demandée au clic, jamais préparée à l'avance :
               * elle ne vaut qu'une fois côté daemon, et un quart d'heure côté
               * compartiment. Une adresse fabriquée à l'affichage de la liste
               * serait périmée au moment où l'on clique.
               */}
              <DropdownItem
                icon={<Download />}
                disabled={busy || backup.isSuccessful !== true}
                onSelect={() =>
                  startTransition(async () => {
                    const result = await backupDownloadUrl(serverId, backup.id);
                    if (result.error || !result.url) {
                      setError(result.error);
                      return;
                    }
                    // Un onglet à part : le téléchargement ne doit pas faire
                    // quitter la page, et l'adresse expire trop vite pour être
                    // gardée dans l'historique de celle-ci.
                    window.open(result.url, "_blank", "noopener,noreferrer");
                  })
                }
              >
                {tc("download")}
              </DropdownItem>
              <DropdownItem
                icon={backup.isLocked ? <LockOpen /> : <Lock />}
                disabled={busy}
                onSelect={() => run(() => setBackupLock(serverId, backup.id, !backup.isLocked))}
              >
                {backup.isLocked ? t("unlock") : t("lock")}
              </DropdownItem>
              <DropdownSeparator />
              <DropdownItem
                icon={<Trash2 />}
                destructive
                disabled={busy || backup.isLocked || deletionBlocked}
                onSelect={() => setToDelete(backup)}
              >
                {tc("delete")}
              </DropdownItem>
            </RowActions>
          );
        },
      },
    ],
    [serverId, pending, bloc, deletionBlocked, run, t, tc],
  );

  const full = initial.used >= initial.limit;

  return (
    <PageTemplate
      notice={<ServerBlockBanner />}
      header={
        <PageHeader
          icon={<Archive />}
          title={t("title")}
          subtitle={t("subtitle")}
          actions={
            <Button disabled={full || pending || bloc !== null} onClick={() => setCreating(true)}>
              <Plus /> {t("create")}
            </Button>
          }
        />
      }
      toolbar={
        <div className="rounded-card border border-border bg-surface px-5 py-4 shadow-card">
          <MetricBar
            label={t("quota")}
            value={initial.used}
            max={initial.limit}
            format={(v) => `${v}`}
          />
        </div>
      }
    >
      {error ? (
        <AlertBanner variant="danger" title={tc("refused")} dismissible>
          {error}
        </AlertBanner>
      ) : null}

      <DataTable
        columns={columns}
        data={initial.items}
        getRowId={(row) => row.id}
        emptyState={
          <EmptyState
            icon={<Archive />}
            title={t("empty")}
            description={t("emptyHint")}
            action={
              <Button disabled={full || bloc !== null} onClick={() => setCreating(true)}>
                <Plus /> {t("create")}
              </Button>
            }
          />
        }
      />

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent
          title={t("newTitle")}
          description={t("newBody")}
          footer={
            <Button
              disabled={name.trim() === "" || pending}
              onClick={() => {
                run(() => createBackup(serverId, name.trim()));
                setCreating(false);
                setName("");
              }}
            >
              {t("start")}
            </Button>
          }
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("namePlaceholder")}
            autoFocus
          />
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={toRestore !== null}
        onOpenChange={(open) => !open && setToRestore(null)}
        title={t("restoreTitle")}
        description={t("restoreBody")}
        confirmLabel={tc("restore")}
        destructive
        onConfirm={() => {
          const target = toRestore;
          setToRestore(null);
          // `truncate` reste faux : effacer tout le volume avant d'extraire est
          // une opération d'un autre ordre, qui mérite sa propre demande
          // explicite plutôt qu'une case à cocher au milieu d'une confirmation.
          if (target) run(() => restoreBackup(serverId, target.id, false));
        }}
      />

      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(open) => !open && setToDelete(null)}
        title={t("deleteTitle")}
        description={t("deleteBody")}
        confirmLabel={tc("delete")}
        destructive
        requireTyped={toDelete?.name}
        onConfirm={() => {
          const target = toDelete;
          setToDelete(null);
          if (target) run(() => deleteBackup(serverId, target.id));
        }}
      />
    </PageTemplate>
  );
}
