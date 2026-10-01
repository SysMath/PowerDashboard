"use client";

import { type SnapshotPolicy, settingsAnchor } from "@gamedashboard/contracts";
import { AlertBanner, Button, SettingsSection } from "@gamedashboard/ui";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { saveSnapshotDefaults } from "@/server/api/admin-snapshots";
import { isSnapshotPolicyValid, SnapshotPolicyForm } from "./snapshot-policy-form";

/**
 * Valeurs par défaut des instantanés (Administration › Paramètres) : ce que
 * suit tout node qui n'a pas ses propres réglages. Un changement vaut au
 * relevé suivant de chaque agent, sans rien toucher sur les machines.
 */
export function AdminSnapshotDefaults({
  initial,
  canEdit,
}: {
  initial: SnapshotPolicy;
  canEdit: boolean;
}) {
  const t = useTranslations("snapshotPolicy");
  const tc = useTranslations("common");
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  const save = () =>
    startTransition(async () => {
      const result = await saveSnapshotDefaults(draft);
      setError(result.error);
      setSaved(!result.error);
      if (result.policy) setDraft(result.policy);
    });

  return (
    <SettingsSection
      id={settingsAnchor("instantanes")}
      title={t("defaultsTitle")}
      description={t("defaultsDescription")}
      footer={
        canEdit ? (
          <Button disabled={pending || !isSnapshotPolicyValid(draft)} onClick={save}>
            {tc("save")}
          </Button>
        ) : null
      }
    >
      <div className="flex flex-col gap-4">
        {error ? (
          <AlertBanner variant="danger" title={tc("refused")} dismissible>
            {error}
          </AlertBanner>
        ) : null}
        {saved ? (
          <AlertBanner variant="success" title={t("saved")}>
            {t("savedBody")}
          </AlertBanner>
        ) : null}
        <SnapshotPolicyForm
          value={draft}
          onChange={(next) => {
            setSaved(false);
            setDraft(next);
          }}
          disabled={!canEdit || pending}
        />
      </div>
    </SettingsSection>
  );
}
