"use client";

import {
  type AdminNodeAgentView,
  NODE_AGENT_FUNCTION_NAMES,
  NODE_AGENT_FUNCTIONS,
  type NodeAgentStatus,
  type NodeCapabilityState,
  nodeAgentConfigureCommand,
} from "@gamedashboard/contracts";
import {
  AlertBanner,
  Badge,
  Button,
  ConfirmDialog,
  KeyValueGrid,
  RelativeTime,
  SettingsSection,
} from "@gamedashboard/ui";
import { KeyRound, Unplug } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { issueNodeConfigureToken } from "@/server/api/admin-actions";
import { revokeNodeAgent } from "@/server/api/admin-snapshots";

const STATUS_VARIANT: Record<NodeAgentStatus, "neutral" | "success" | "warning"> = {
  none: "neutral",
  online: "success",
  silent: "warning",
};

const CAPABILITY_VARIANT: Record<NodeCapabilityState, "success" | "warning" | "neutral"> = {
  active: "success",
  silent: "warning",
  absent: "neutral",
  node_disabled: "neutral",
  platform_disabled: "neutral",
};

/**
 * L'agent de node (ADR 0008) sur la fiche d'une machine : s'il parle, ce
 * qu'il sert, comment l'installer, et comment lui retirer son jeton.
 *
 * L'agent est facultatif : sans lui, la section le dit et donne la commande,
 * rien d'autre de la fiche ne change.
 *
 * La commande porte la même clé d'amorçage que `wings configure`, mais
 * émise à la demande et non à l'ouverture : on vient ici surtout pour lire
 * l'état, et une clé ne se crée qu'au moment de s'en servir.
 */
export function AdminNodeAgent({
  nodeId,
  agent,
  panelOrigin,
}: {
  nodeId: string;
  agent: AdminNodeAgentView;
  panelOrigin: string;
}) {
  const t = useTranslations("nodeAgent");
  const ta = useTranslations("adminNodes");
  const tc = useTranslations("common");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const issue = () =>
    startTransition(async () => {
      const result = await issueNodeConfigureToken(nodeId);
      setError(result.error);
      setToken(result.token);
    });

  const revoke = () =>
    startTransition(async () => {
      setConfirming(false);
      const result = await revokeNodeAgent(nodeId);
      setError(result.error);
      if (!result.error) router.refresh();
    });

  const command = nodeAgentConfigureCommand({
    panelOrigin,
    nodeId,
    token: token ?? undefined,
    activer: "instantanes",
  });

  return (
    <SettingsSection
      title={t("title")}
      description={t("description")}
      actions={<Badge variant={STATUS_VARIANT[agent.status]}>{t(`status.${agent.status}`)}</Badge>}
      footer={
        agent.status === "none" ? null : (
          <Button variant="danger" disabled={pending} onClick={() => setConfirming(true)}>
            <Unplug /> {t("revoke")}
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-5">
        {error ? (
          <AlertBanner variant="danger" title={tc("actionRefused")} dismissible>
            {error}
          </AlertBanner>
        ) : null}

        {agent.status === "none" ? (
          <p className="text-muted text-sm">{t("none")}</p>
        ) : (
          <KeyValueGrid
            items={[
              { label: t("version"), value: agent.version ?? "—" },
              {
                label: t("lastSeen"),
                value: agent.lastSeenAt ? <RelativeTime value={agent.lastSeenAt} /> : "—",
              },
            ]}
          />
        )}

        <ul className="flex flex-col gap-2">
          {NODE_AGENT_FUNCTION_NAMES.map((name) => {
            const capability = agent.capabilities[name];
            return (
              <li key={name} className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold text-fg text-sm">
                    {NODE_AGENT_FUNCTIONS[name].label}
                  </p>
                  {capability.reason ? (
                    <p className="text-muted text-xs">{capability.reason}</p>
                  ) : null}
                </div>
                <Badge variant={CAPABILITY_VARIANT[capability.state]}>
                  {t(`capability.${capability.state}`)}
                </Badge>
              </li>
            );
          })}
        </ul>

        <div className="flex flex-col gap-2 border-border border-t pt-4">
          <p className="font-semibold text-fg text-sm">{t("installTitle")}</p>
          <p className="text-muted text-xs">{t("installHint")}</p>
          <code className="gd-mono select-all break-all rounded-field border border-border bg-surface-2 p-3 text-fg text-xs">
            {command}
          </code>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="neutral">{ta("configureTokenScope")}</Badge>
            <Button size="sm" variant="secondary" disabled={pending} onClick={issue}>
              <KeyRound /> {token ? ta("configureReissue") : t("issue")}
            </Button>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("revokeTitle")}
        description={t("revokeBody")}
        confirmLabel={t("revoke")}
        destructive
        onConfirm={revoke}
      />
    </SettingsSection>
  );
}
