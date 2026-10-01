"use client";

import { SNAPSHOT_BOUNDS, SnapshotPolicy } from "@gamedashboard/contracts";
import { Button, FormField, Input, SettingToggle } from "@gamedashboard/ui";
import { Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";

type NumberKey =
  | "maxAgeDays"
  | "manualCooldownMinutes"
  | "coalesceSeconds"
  | "freeSpaceThresholdPct"
  | "defaultPinLimit";

const NUMBERS: readonly NumberKey[] = [
  "maxAgeDays",
  "freeSpaceThresholdPct",
  "defaultPinLimit",
  "manualCooldownMinutes",
  "coalesceSeconds",
];

const toInt = (raw: string) => {
  // Un champ vidé vaut zéro, pas `NaN` : la validation dit alors la borne.
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Les réglages passent la règle partagée avec l'API et l'agent. */
export function isSnapshotPolicyValid(policy: SnapshotPolicy): boolean {
  return SnapshotPolicy.safeParse(policy).success;
}

/**
 * Premier défaut, pour le dire sous le formulaire : le message de la règle
 * quand il est écrit pour l'écran (rétention d'un niveau), sinon le champ
 * hors de ses bornes.
 */
function firstIssue(policy: SnapshotPolicy): { custom: string } | { field: string } | null {
  const parsed = SnapshotPolicy.safeParse(policy);
  const issue = parsed.success ? undefined : parsed.error.issues[0];
  if (!issue) return null;
  if (issue.code === "custom") return { custom: issue.message };
  const field = issue.path.at(-1);
  return { field: typeof field === "string" ? field : "levels" };
}

/**
 * Réglages des instantanés (ADR 0009, « Tout se règle dans l'interface »),
 * les mêmes champs pour les valeurs par défaut et pour un node.
 *
 * Les niveaux sont des paliers de rétention : un instantané toutes les
 * heures gardé un jour, un par jour gardé une semaine… L'agent applique les
 * mêmes bornes : l'écran n'en est que le confort.
 */
export function SnapshotPolicyForm({
  value,
  onChange,
  disabled,
}: {
  value: SnapshotPolicy;
  onChange: (next: SnapshotPolicy) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("snapshotPolicy");
  const set = <K extends keyof SnapshotPolicy>(key: K, next: SnapshotPolicy[K]) =>
    onChange({ ...value, [key]: next });
  const setLevel = (index: number, patch: Partial<SnapshotPolicy["levels"][number]>) =>
    set(
      "levels",
      value.levels.map((level, i) => (i === index ? { ...level, ...patch } : level)),
    );

  const issue = firstIssue(value);
  const fieldLabel = (field: string) =>
    field === "intervalMinutes"
      ? t("interval")
      : field === "retentionHours"
        ? t("retention")
        : (NUMBERS as readonly string[]).includes(field)
          ? t(field as NumberKey)
          : t("levels");

  return (
    <div className="flex flex-col gap-4">
      <div className="divide-y divide-border">
        <SettingToggle
          label={t("enabled")}
          description={t("enabledHint")}
          checked={value.enabled}
          onCheckedChange={(checked) => set("enabled", checked)}
          disabled={disabled}
        />
        <SettingToggle
          label={t("manualAllowed")}
          description={t("manualAllowedHint")}
          checked={value.manualAllowed}
          onCheckedChange={(checked) => set("manualAllowed", checked)}
          disabled={disabled}
        />
        <SettingToggle
          label={t("s3FromSnapshot")}
          description={t("s3FromSnapshotHint")}
          checked={value.s3FromSnapshot}
          onCheckedChange={(checked) => set("s3FromSnapshot", checked)}
          disabled={disabled}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {NUMBERS.map((key) => (
          <FormField key={key} label={t(key)} description={t(`${key}Hint`)}>
            {(id) => (
              <Input
                id={id}
                type="number"
                min={0}
                value={value[key]}
                disabled={disabled}
                onChange={(e) => set(key, toInt(e.target.value))}
              />
            )}
          </FormField>
        ))}
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="font-semibold text-fg text-sm">{t("levels")}</p>
            <p className="text-muted text-xs">{t("levelsHint")}</p>
          </div>
          <Button
            size="sm"
            variant="secondary"
            disabled={disabled || value.levels.length >= SNAPSHOT_BOUNDS.levelsMax}
            onClick={() =>
              set("levels", [
                ...value.levels,
                { intervalMinutes: 60, retentionHours: 24, enabled: true },
              ])
            }
          >
            <Plus /> {t("addLevel")}
          </Button>
        </div>
        {value.levels.map((level, index) => (
          <div
            // Les niveaux n'ont pas d'identité propre : leur rang en tient lieu.
            // biome-ignore lint/suspicious/noArrayIndexKey: rang = identité
            key={index}
            className="grid items-end gap-3 rounded-field border border-border p-3 sm:grid-cols-[1fr_1fr_auto_auto]"
          >
            <FormField label={t("interval")}>
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  min={SNAPSHOT_BOUNDS.intervalMinutesMin}
                  value={level.intervalMinutes}
                  disabled={disabled}
                  onChange={(e) => setLevel(index, { intervalMinutes: toInt(e.target.value) })}
                />
              )}
            </FormField>
            <FormField label={t("retention")}>
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  min={1}
                  value={level.retentionHours}
                  disabled={disabled}
                  onChange={(e) => setLevel(index, { retentionHours: toInt(e.target.value) })}
                />
              )}
            </FormField>
            <SettingToggle
              label={t("levelEnabled")}
              checked={level.enabled}
              onCheckedChange={(checked) => setLevel(index, { enabled: checked })}
              disabled={disabled}
            />
            <Button
              size="sm"
              variant="ghost"
              aria-label={t("removeLevel")}
              disabled={disabled}
              onClick={() =>
                set(
                  "levels",
                  value.levels.filter((_, i) => i !== index),
                )
              }
            >
              <Trash2 />
            </Button>
          </div>
        ))}
      </div>

      {issue ? (
        <p className="text-danger-ink text-sm" role="alert">
          {"custom" in issue ? issue.custom : t("outOfBounds", { field: fieldLabel(issue.field) })}
        </p>
      ) : null}
    </div>
  );
}
