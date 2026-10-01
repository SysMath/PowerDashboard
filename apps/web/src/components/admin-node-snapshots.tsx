"use client";

import type { SnapshotCause, SnapshotPolicy } from "@gamedashboard/contracts";
import {
  AlertBanner,
  Badge,
  Button,
  type ColumnDef,
  ConfirmDialog,
  DataTable,
  DropdownItem,
  EmptyState,
  formatBytes,
  KeyValueGrid,
  RelativeTime,
  RowActions,
  SettingsSection,
  SettingToggle,
} from "@gamedashboard/ui";
import { Layers, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useMemo, useState, useTransition } from "react";
import {
  type AdminNodeSnapshot,
  type AdminNodeSnapshotsData,
  destroyNodeSnapshot,
  saveNodeSnapshotPolicy,
} from "@/server/api/admin-snapshots";
import { isSnapshotPolicyValid, SnapshotPolicyForm } from "./snapshot-policy-form";

const CAUSE_VARIANT: Record<SnapshotCause, "neutral" | "info" | "warning"> = {
  auto: "neutral",
  manual: "info",
  safety: "warning",
};

/**
 * Instantanés d'un node (ADR 0009) : l'état que l'agent rapporte, les
 * réglages (propres au node ou les valeurs par défaut), et le registre, d'où
 * l'on peut faire détruire un instantané.
 *
 * Les réglages suivent les valeurs par défaut tant qu'on ne coche pas
 * « réglages propres » ; décocher y revient, sans rien garder de côté.
 */
export function AdminNodeSnapshots({
  nodeId,
  initial,
}: {
  nodeId: string;
  initial: AdminNodeSnapshotsData;
}) {
  const t = useTranslations("nodeSnapshots");
  const ts = useTranslations("snapshots");
  const tc = useTranslations("common");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [custom, setCustom] = useState(initial.custom);
  const [draft, setDraft] = useState<SnapshotPolicy>(initial.policy);
  const [toDestroy, setToDestroy] = useState<AdminNodeSnapshot | null>(null);
  const { status } = initial;

  const run = (action: () => Promise<{ error: string | null }>) =>
    startTransition(async () => {
      const result = await action();
      setError(result.error);
      if (!result.error) router.refresh();
    });

  const columns = useMemo<ColumnDef<AdminNodeSnapshot, unknown>[]>(
    () => [
      {
        accessorKey: "takenAt",
        header: ts("columnSnapshot"),
        cell: ({ row }) => (
          <div className="min-w-0">
            <RelativeTime className="font-semibold text-fg" value={row.original.takenAt} />
            <p className="gd-mono truncate text-muted text-xs">{row.original.name}</p>
          </div>
        ),
      },
      {
        accessorKey: "cause",
        header: ts("columnCause"),
        cell: ({ row }) => (
          <Badge variant={CAUSE_VARIANT[row.original.cause]}>
            {ts(`cause.${row.original.cause}`)}
          </Badge>
        ),
      },
      {
        id: "contents",
        header: t("columnContents"),
        cell: ({ row }) => (
          <span className="text-muted text-sm">
            {t("contents", { servers: row.original.serverCount, pins: row.original.pins })}
            {row.original.bytes === null ? null : ` · ${formatBytes(row.original.bytes)}`}
          </span>
        ),
      },
      {
        id: "actions",
        header: "",
        size: 60,
        cell: ({ row }) => (
          <RowActions>
            <DropdownItem
              icon={<Trash2 />}
              disabled={pending}
              onSelect={() => setToDestroy(row.original)}
            >
              {t("destroy")}
            </DropdownItem>
          </RowActions>
        ),
      },
    ],
    [pending, t, ts],
  );

  const free =
    status.freeBytes !== null && status.totalBytes
      ? `${formatBytes(status.freeBytes)} / ${formatBytes(status.totalBytes)}`
      : "—";

  return (
    <SettingsSection
      title={t("title")}
      description={t("description")}
      footer={
        <Button
          disabled={pending || (custom && !isSnapshotPolicyValid(draft))}
          onClick={() => run(() => saveNodeSnapshotPolicy(nodeId, custom ? draft : null))}
        >
          {tc("save")}
        </Button>
      }
    >
      <div className="flex flex-col gap-5">
        {error ? (
          <AlertBanner variant="danger" title={tc("actionRefused")} dismissible>
            {error}
          </AlertBanner>
        ) : null}
        {initial.capability.reason ? (
          <AlertBanner variant="warning" title={t("unavailableTitle")}>
            {initial.capability.reason}
          </AlertBanner>
        ) : null}
        {status.reason ? (
          <AlertBanner variant="warning" title={t("filesystemTitle")}>
            {status.reason}
          </AlertBanner>
        ) : null}
        {status.suspended ? (
          <AlertBanner variant="warning" title={t("suspendedTitle")}>
            {ts("suspended")}
          </AlertBanner>
        ) : null}

        <KeyValueGrid
          items={[
            { label: t("filesystem"), value: status.filesystem ?? "—" },
            { label: t("freeSpace"), value: free },
            {
              label: t("reportedAt"),
              value: status.reportedAt ? <RelativeTime value={status.reportedAt} /> : "—",
            },
            { label: t("count"), value: initial.snapshots.length },
          ]}
        />

        <div className="flex flex-col gap-3 border-border border-t pt-4">
          <SettingToggle
            label={t("custom")}
            description={t("customHint")}
            checked={custom}
            onCheckedChange={setCustom}
            disabled={pending}
          />
          <SnapshotPolicyForm value={draft} onChange={setDraft} disabled={!custom || pending} />
        </div>

        <DataTable
          columns={columns}
          data={initial.snapshots}
          getRowId={(row) => row.name}
          emptyState={<EmptyState icon={<Layers />} title={ts("empty")} />}
        />
      </div>

      <ConfirmDialog
        open={toDestroy !== null}
        onOpenChange={(open) => !open && setToDestroy(null)}
        title={t("destroyTitle")}
        description={t("destroyBody", { pins: toDestroy?.pins ?? 0 })}
        confirmLabel={t("destroy")}
        destructive
        onConfirm={() => {
          const target = toDestroy;
          setToDestroy(null);
          if (target) run(() => destroyNodeSnapshot(nodeId, target.name));
        }}
      />
    </SettingsSection>
  );
}
