"use client";

import type { ServerSnapshotView, SnapshotCause } from "@gamedashboard/contracts";
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
  EmptyState,
  formatBytes,
  Input,
  MetricBar,
  PageHeader,
  PageTemplate,
  RelativeTime,
  RowActions,
} from "@gamedashboard/ui";
import { Camera, Layers, Pin, PinOff, RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useMemo, useState, useTransition } from "react";
import {
  pinSnapshot,
  restoreSnapshot,
  type SnapshotList,
  takeSnapshot,
  unpinSnapshot,
} from "@/server/api/snapshots";
import { ServerBlockBanner, useServerBlock } from "./server-block-context";

const CAUSE_VARIANT: Record<SnapshotCause, "neutral" | "info" | "warning"> = {
  auto: "neutral",
  manual: "info",
  safety: "warning",
};

/**
 * Instantanés d'un serveur (ADR 0009) : pris par l'agent de la machine, sur
 * le même disque. L'onglet le dit d'entrée, parce qu'un instantané ne
 * remplace pas une sauvegarde.
 *
 * Comme les sauvegardes, rien ne change en mémoire avant la réponse de l'API :
 * la liste est relue après chaque action.
 */
export function SnapshotsWorkspace({
  serverId,
  initial,
}: {
  serverId: string;
  initial: SnapshotList;
}) {
  const t = useTranslations("snapshots");
  const tc = useTranslations("common");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [toRestore, setToRestore] = useState<ServerSnapshotView | null>(null);
  const [toPin, setToPin] = useState<ServerSnapshotView | null>(null);
  const [label, setLabel] = useState("");
  const [pending, startTransition] = useTransition();
  const bloc = useServerBlock();
  const { meta } = initial;

  const run = useCallback(
    (action: () => Promise<{ error: string | null }>) =>
      startTransition(async () => {
        const result = await action();
        setError(result.error);
        if (!result.error) router.refresh();
      }),
    [router],
  );

  // Pourquoi rien ne s'écrit en ce moment, dans l'ordre où l'agent le dirait.
  const unavailable = meta.status.suspended
    ? t("suspended")
    : !meta.status.filesystem
      ? (meta.status.reason ?? t("unavailable"))
      : !meta.writable
        ? t("silent")
        : null;
  const canWrite = meta.writable && bloc === null && !pending;
  const pinsFull = meta.pinned >= meta.pinLimit;

  const columns = useMemo<ColumnDef<ServerSnapshotView, unknown>[]>(
    () => [
      {
        accessorKey: "takenAt",
        header: t("columnSnapshot"),
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="flex items-center gap-2 font-semibold text-fg">
              <RelativeTime value={row.original.takenAt} />
              {row.original.pinned ? (
                <Pin className="size-3.5 shrink-0 text-accent" aria-label={t("pinned")} />
              ) : null}
            </p>
            <p className="truncate text-xs text-muted">
              {row.original.pinLabel ?? row.original.name}
              {row.original.bytes === null ? null : ` · ${formatBytes(row.original.bytes)}`}
            </p>
          </div>
        ),
      },
      {
        accessorKey: "cause",
        header: t("columnCause"),
        cell: ({ row }) => (
          <Badge variant={CAUSE_VARIANT[row.original.cause]}>
            {t(`cause.${row.original.cause}`)}
          </Badge>
        ),
      },
      {
        accessorKey: "expiresAt",
        header: t("columnExpires"),
        cell: ({ getValue }) => (
          <RelativeTime className="text-muted" value={getValue() as string} />
        ),
      },
      {
        id: "actions",
        header: "",
        size: 60,
        cell: ({ row }) => {
          const snapshot = row.original;
          return (
            <RowActions>
              <DropdownItem
                icon={<RotateCcw />}
                disabled={!canWrite || meta.status.suspended}
                onSelect={() => setToRestore(snapshot)}
              >
                {tc("restore")}
              </DropdownItem>
              {snapshot.pinned ? (
                <DropdownItem
                  icon={<PinOff />}
                  disabled={pending || bloc !== null}
                  onSelect={() => run(() => unpinSnapshot(serverId, snapshot.name))}
                >
                  {t("unpin")}
                </DropdownItem>
              ) : (
                <DropdownItem
                  icon={<Pin />}
                  disabled={pending || pinsFull || bloc !== null}
                  onSelect={() => setToPin(snapshot)}
                >
                  {t("pin")}
                </DropdownItem>
              )}
            </RowActions>
          );
        },
      },
    ],
    [serverId, pending, canWrite, pinsFull, bloc, meta.status.suspended, run, t, tc],
  );

  const takeDisabled = !canWrite || !meta.manualAllowed || meta.pending || !!meta.nextManualAt;

  return (
    <PageTemplate
      notice={<ServerBlockBanner />}
      header={
        <PageHeader
          icon={<Layers />}
          title={t("title")}
          subtitle={t("subtitle")}
          actions={
            <Button disabled={takeDisabled} onClick={() => run(() => takeSnapshot(serverId))}>
              <Camera /> {t("take")}
            </Button>
          }
        />
      }
      toolbar={
        <div className="rounded-card border border-border bg-surface px-5 py-4 shadow-card">
          <MetricBar
            label={t("pins")}
            value={meta.pinned}
            max={meta.pinLimit}
            format={(v) => `${v}`}
          />
        </div>
      }
    >
      <AlertBanner variant="info" title={t("warningTitle")}>
        {t("warning")}
      </AlertBanner>
      {unavailable ? (
        <AlertBanner variant="warning" title={t("unavailableTitle")}>
          {unavailable}
        </AlertBanner>
      ) : null}
      {meta.pending ? (
        <AlertBanner variant="info" title={t("pendingTitle")}>
          {t("pendingBody")}
        </AlertBanner>
      ) : null}
      {error ? (
        <AlertBanner variant="danger" title={tc("refused")} dismissible>
          {error}
        </AlertBanner>
      ) : null}

      <DataTable
        columns={columns}
        data={initial.items}
        getRowId={(row) => row.name}
        emptyState={
          <EmptyState icon={<Layers />} title={t("empty")} description={t("emptyHint")} />
        }
      />

      <Dialog open={toPin !== null} onOpenChange={(open) => !open && setToPin(null)}>
        <DialogContent
          title={t("pinTitle")}
          description={t("pinBody")}
          footer={
            <Button
              disabled={pending}
              onClick={() => {
                const target = toPin;
                setToPin(null);
                setLabel("");
                if (target) run(() => pinSnapshot(serverId, target.name, label));
              }}
            >
              {t("pin")}
            </Button>
          }
        >
          <Input
            value={label}
            maxLength={80}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t("labelPlaceholder")}
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
          if (target) run(() => restoreSnapshot(serverId, target.name));
        }}
      />
    </PageTemplate>
  );
}
