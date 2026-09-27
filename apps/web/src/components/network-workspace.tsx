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
  Input,
  MetricBar,
  PageHeader,
  PageTemplate,
  RowActions,
} from "@gamedashboard/ui";
import { Network, Pencil, Plus, Star, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { type ReactNode, useCallback, useMemo, useState, useTransition } from "react";
import {
  type Allocation,
  type AllocationList,
  claimAllocation,
  releaseAllocation,
  setAllocationNotes,
  setPrimaryAllocation,
} from "@/server/api/network";
import { ServerBlockBanner, useServerBlock } from "./server-block-context";

/**
 * Ports attribués au serveur.
 *
 * Un port n'est pas créé, il est pris dans le stock du node : le bouton
 * « Ajouter » demande donc une attribution, et peut légitimement échouer parce
 * que le node n'a plus rien à donner — ce que le quota du serveur ne dit pas.
 */
export function NetworkWorkspace({
  serverId,
  initial,
  subdomain,
}: {
  serverId: string;
  initial: AllocationList;
  /** La carte du sous-domaine, au-dessus des ports. */
  subdomain?: ReactNode;
}) {
  const t = useTranslations("network");
  const tc = useTranslations("common");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [toRelease, setToRelease] = useState<Allocation | null>(null);
  const [editing, setEditing] = useState<Allocation | null>(null);
  const [notes, setNotes] = useState("");
  const [pending, startTransition] = useTransition();
  /*
   * Seule la réservation est refusée par l'API.
   *
   * Un port retenu l'est sur la machine de l'hébergeur et le reste tant qu'on
   * ne le rend pas : en prendre un pendant une suspension immobilise le bien
   * d'autrui. Renommer, désigner le port principal ou en libérer un ne coûtent
   * rien à personne et restent ouverts.
   */
  const bloc = useServerBlock();

  const run = useCallback(
    (action: () => Promise<{ error: string | null }>) =>
      startTransition(async () => {
        const result = await action();
        setError(result.error);
        if (!result.error) router.refresh();
      }),
    [router],
  );

  const columns = useMemo<ColumnDef<Allocation, unknown>[]>(
    () => [
      {
        accessorKey: "ip",
        header: t("columnAddress"),
        cell: ({ row }) => (
          <div>
            <p className="gd-mono font-semibold text-fg">
              {row.original.alias ?? row.original.ip}:{row.original.port}
            </p>
            {/* L'adresse réelle reste visible sous l'alias : c'est elle qu'il
                faut donner à un outil qui ne résout pas les noms. */}
            {row.original.alias ? (
              <p className="gd-mono text-xs text-muted">
                {row.original.ip}:{row.original.port}
              </p>
            ) : null}
          </div>
        ),
      },
      {
        accessorKey: "notes",
        header: t("columnNotes"),
        cell: ({ getValue }) => (
          <span className="text-muted">{(getValue() as string | null) ?? tc("none")}</span>
        ),
      },
      {
        accessorKey: "isPrimary",
        header: t("columnRole"),
        cell: ({ row }) =>
          row.original.isPrimary ? (
            <Badge variant="accent">{t("primary")}</Badge>
          ) : (
            <Badge>{t("secondary")}</Badge>
          ),
      },
      {
        id: "actions",
        header: "",
        size: 60,
        cell: ({ row }) => {
          const allocation = row.original;
          return (
            <RowActions>
              <DropdownItem
                icon={<Star />}
                disabled={allocation.isPrimary || pending}
                onSelect={() => run(() => setPrimaryAllocation(serverId, allocation.id))}
              >
                {t("makePrimary")}
              </DropdownItem>
              <DropdownItem
                icon={<Pencil />}
                disabled={pending}
                onSelect={() => {
                  setNotes(allocation.notes ?? "");
                  setEditing(allocation);
                }}
              >
                {t("annotate")}
              </DropdownItem>
              <DropdownSeparator />
              <DropdownItem
                icon={<Trash2 />}
                destructive
                // Le port principal n'est pas libérable : le serveur perdrait
                // son adresse, et le daemon ne saurait plus quoi publier.
                disabled={allocation.isPrimary || pending}
                onSelect={() => setToRelease(allocation)}
              >
                {t("release")}
              </DropdownItem>
            </RowActions>
          );
        },
      },
    ],
    [serverId, pending, run, t, tc],
  );

  const full = initial.used >= initial.limit;
  const exhausted = initial.available === 0;

  return (
    <PageTemplate
      notice={<ServerBlockBanner />}
      header={
        <PageHeader
          icon={<Network />}
          title={t("title")}
          subtitle={t("subtitle")}
          actions={
            <Button
              disabled={full || exhausted || pending || bloc !== null}
              onClick={() => run(() => claimAllocation(serverId))}
            >
              <Plus /> {t("add")}
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

      {/* Distinguer les deux causes : le quota se règle avec le support, le
          stock épuisé est un problème du node et n'a rien à voir avec l'offre
          souscrite. Un seul message pour les deux enverrait au mauvais endroit. */}
      {exhausted && !full ? (
        <AlertBanner variant="warning" title={t("exhausted")}>
          {t("exhaustedBody")}
        </AlertBanner>
      ) : null}

      {subdomain}

      <DataTable
        columns={columns}
        data={initial.items}
        getRowId={(row) => row.id}
        emptyState={<EmptyState icon={<Network />} title={t("empty")} />}
      />

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent
          title={t("annotateTitle")}
          description={editing ? `${editing.alias ?? editing.ip}:${editing.port}` : undefined}
          footer={
            <Button
              disabled={pending}
              onClick={() => {
                const target = editing;
                setEditing(null);
                if (target) run(() => setAllocationNotes(serverId, target.id, notes.trim()));
              }}
            >
              {tc("save")}
            </Button>
          }
        >
          <Input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={t("notePlaceholder")}
            autoFocus
          />
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={toRelease !== null}
        onOpenChange={(open) => !open && setToRelease(null)}
        title={t("releaseTitle")}
        description={t("releaseBody")}
        confirmLabel={t("release")}
        destructive
        onConfirm={() => {
          const target = toRelease;
          setToRelease(null);
          if (target) run(() => releaseAllocation(serverId, target.id));
        }}
      />
    </PageTemplate>
  );
}
