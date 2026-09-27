"use client";

import type { SubdomainState } from "@gamedashboard/contracts";
import {
  AlertBanner,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  CopyButton,
  Input,
} from "@gamedashboard/ui";
import { Globe } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { chooseSubdomain, removeSubdomain } from "@/server/api/network";
import { useServerBlock } from "./server-block-context";

const STATUS_VARIANT = { active: "success", pending: "warning", error: "danger" } as const;

/**
 * Le sous-domaine du serveur (PLAN §10.3).
 *
 * Absente tant que l'administration n'a pas réglé de zone : proposer un champ
 * qui ne peut que refuser n'apprendrait rien au client.
 */
export function SubdomainCard({ serverId, state }: { serverId: string; state: SubdomainState }) {
  const t = useTranslations("network");
  const tc = useTranslations("common");
  const router = useRouter();
  const current = state.subdomain;
  const [label, setLabel] = useState(current?.label ?? "");
  const [editing, setEditing] = useState(current === null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // Choisir un nom est refusé pendant une suspension ; le retirer reste ouvert.
  const bloc = useServerBlock();

  if (!state.available || !state.domain) return null;

  const run = (action: () => Promise<{ error: string | null }>, done?: () => void) =>
    startTransition(async () => {
      const result = await action();
      setError(result.error);
      if (!result.error) {
        done?.();
        router.refresh();
      }
    });

  return (
    <Card>
      <CardHeader
        icon={<Globe />}
        title={t("subdomainTitle")}
        description={t("subdomainHint", { domain: state.domain })}
      />
      <CardBody className="space-y-4">
        {error ? (
          <AlertBanner variant="danger" title={tc("refused")} dismissible>
            {error}
          </AlertBanner>
        ) : null}

        {current && !editing ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="gd-mono font-semibold text-fg">{current.address}</span>
            <CopyButton value={current.address} label={tc("copy")} copiedLabel={tc("copied")} />
            <Badge variant={STATUS_VARIANT[current.status]}>
              {t(`subdomainStatus.${current.status}`)}
            </Badge>
            <div className="ms-auto flex gap-2">
              <Button variant="secondary" disabled={pending} onClick={() => setEditing(true)}>
                {t("subdomainChange")}
              </Button>
              <Button
                variant="danger-ghost"
                disabled={pending}
                onClick={() => setConfirmRemove(true)}
              >
                {t("subdomainRemove")}
              </Button>
            </div>
          </div>
        ) : (
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              run(
                () => chooseSubdomain(serverId, label),
                () => setEditing(false),
              );
            }}
          >
            <Input
              className="min-w-64 flex-1"
              value={label}
              onChange={(event) => setLabel(event.target.value.toLowerCase())}
              placeholder={t("subdomainPlaceholder")}
              trailing={<span className="gd-mono">.{state.domain}</span>}
              aria-label={t("subdomainTitle")}
              maxLength={63}
            />
            <Button type="submit" disabled={pending || bloc !== null || label.trim() === ""}>
              {tc("save")}
            </Button>
            {current ? (
              <Button
                type="button"
                variant="ghost"
                disabled={pending}
                onClick={() => setEditing(false)}
              >
                {tc("cancel")}
              </Button>
            ) : null}
          </form>
        )}

        {current?.status === "error" && current.error ? (
          <p className="text-sm text-danger-ink">{current.error}</p>
        ) : null}
        {current ? (
          <p className="text-sm text-muted">
            {current.srv ? t("subdomainSrv") : t("subdomainWithPort")}
          </p>
        ) : null}
      </CardBody>

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={t("subdomainRemoveTitle")}
        description={t("subdomainRemoveBody")}
        confirmLabel={t("subdomainRemove")}
        destructive
        onConfirm={() => {
          setConfirmRemove(false);
          run(
            () => removeSubdomain(serverId),
            () => setLabel(""),
          );
        }}
      />
    </Card>
  );
}
