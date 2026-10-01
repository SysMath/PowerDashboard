"use client";

import {
  checkQuota,
  type QuotaDimension,
  RESOURCE_BOUNDS,
  type ResourceKey,
  type ResourceRequest,
} from "@gamedashboard/contracts";
import { AlertBanner, FormField, formatMb, Input } from "@gamedashboard/ui";
import { useTranslations } from "next-intl";
import type { CatalogueNode } from "@/server/api/catalogue";
import type { ResellerQuotaReport } from "@/server/api/reseller";

/**
 * Ce qu'il reste sur une dimension de l'enveloppe.
 *
 * Sans plafond, on rend « ∞ » plutôt qu'un nombre : soustraire d'un maximum
 * inexistant donnerait un reste inventé. Un dépassement rend zéro et non un
 * négatif — il ne reste jamais « moins que rien », et le message qui
 * l'accompagne dit déjà que l'enveloppe est pleine.
 */
function remainingLabel(
  limit: number | null,
  used: number,
  format: (value: number) => string,
): string {
  if (limit === null) return "∞";
  return format(Math.max(limit - used, 0));
}

/**
 * Saisie des quantités de ressources.
 *
 * Partagée par le mode assisté et le mode avancé : ce sont les mêmes champs,
 * seule la façon d'y arriver diffère — le revendeur part d'un gabarit,
 * l'administrateur part de rien. Deux formulaires auraient fini par diverger
 * sur les bornes, qui sont précisément ce qu'il ne faut pas laisser diverger.
 *
 * Les bornes viennent de `@gamedashboard/contracts`, les mêmes que celles dont l'API
 * se sert pour refuser. Cet écran n'est qu'un confort : il évite un
 * aller-retour, il n'autorise rien.
 */
export function ResourceFields({
  value,
  onChange,
  node,
  quota,
  disabled,
}: {
  value: ResourceRequest;
  onChange: (next: ResourceRequest) => void;
  /** Node retenu, pour confronter la saisie à ce qu'il reste réellement. */
  node: CatalogueNode | null;
  /**
   * Enveloppe du revendeur, ou `null` quand la notion ne s'applique pas.
   *
   * Contrôle distinct de celui du node, et pas redondant : le node dit ce que
   * le matériel porte, l'enveloppe ce qu'on a le droit d'en vendre. Un
   * revendeur peut donc avoir de la place sur sa machine et plus d'enveloppe.
   */
  quota?: ResellerQuotaReport | null;
  disabled?: boolean;
}) {
  const t = useTranslations("createServer");

  const set = (key: keyof ResourceRequest, raw: string) => {
    // Un champ vidé vaut zéro et non `NaN` : `NaN` se propagerait dans le
    // récapitulatif et s'afficherait tel quel.
    const parsed = Number.parseInt(raw, 10);
    onChange({ ...value, [key]: Number.isFinite(parsed) ? parsed : 0 });
  };

  /**
   * Dépassements de capacité, dits maintenant plutôt qu'au clic sur « Créer ».
   *
   * L'API revérifie de toute façon, et c'est elle qui tranche : entre
   * l'affichage et l'envoi, quelqu'un d'autre a pu remplir le node.
   */
  const overMemory = node !== null && value.memoryMb > node.freeMemoryMb;
  const overDisk = node !== null && value.diskMb > node.freeDiskMb;
  const overPorts = node !== null && value.allocations > node.freePorts;

  /**
   * Dépassements d'enveloppe, calculés par la même fonction que l'API.
   *
   * Importer `checkQuota` plutôt que réécrire trois comparaisons : l'écran qui
   * annonce « ça passe » et la route qui refuse doivent tomber d'accord, et
   * deux implémentations finissent toujours par diverger sur le cas limite —
   * ici, la demande qui remplit l'enveloppe au mégaoctet près.
   */
  const quotaProblems = quota ? checkQuota(quota.quota, quota.usage, value) : [];
  const overQuota = (dimension: QuotaDimension) =>
    quotaProblems.some((problem) => problem.dimension === dimension);

  // Les ressources bornées de la machine ; la limite d'instantanés se règle ailleurs.
  const field = (key: ResourceKey, label: string, hint: string, error?: string) => (
    <FormField label={label} description={hint} error={error}>
      {(id) => (
        <Input
          id={id}
          type="number"
          className="gd-mono"
          inputMode="numeric"
          min={RESOURCE_BOUNDS[key].min}
          max={RESOURCE_BOUNDS[key].max}
          step={RESOURCE_BOUNDS[key].step}
          value={value[key]}
          disabled={disabled}
          onChange={(e) => set(key, e.target.value)}
        />
      )}
    </FormField>
  );

  return (
    <div className="flex flex-col gap-4">
      {node ? (
        <AlertBanner variant={overMemory || overDisk || overPorts ? "danger" : "info"}>
          {t("nodeRemaining", {
            node: node.name,
            memory: formatMb(node.freeMemoryMb, 0),
            disk: formatMb(node.freeDiskMb, 0),
            ports: node.freePorts,
          })}
        </AlertBanner>
      ) : null}

      {/* L'enveloppe est annoncée avant la saisie, pas après l'envoi : un
          formulaire refusé pour un plafond qu'on ne voyait nulle part se
          relit comme une panne. */}
      {quota ? (
        <AlertBanner variant={quotaProblems.length > 0 ? "danger" : "info"}>
          {t("quotaRemaining", {
            memory: remainingLabel(quota.quota.memoryMb, quota.usage.memoryMb, (v) =>
              formatMb(v, 0),
            ),
            disk: remainingLabel(quota.quota.diskMb, quota.usage.diskMb, (v) => formatMb(v, 0)),
            servers: remainingLabel(quota.quota.serversMax, quota.usage.servers, String),
          })}
        </AlertBanner>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        {field(
          "memoryMb",
          t("fieldMemory"),
          t("fieldMemoryHint"),
          overMemory ? t("overCapacity") : overQuota("memoryMb") ? t("overQuota") : undefined,
        )}
        {field(
          "diskMb",
          t("fieldDisk"),
          t("fieldDiskHint"),
          overDisk ? t("overCapacity") : overQuota("diskMb") ? t("overQuota") : undefined,
        )}
        {/* Zéro signifie « sans limite » dans Wings, pas « aucun processeur ».
            Le dire ici évite qu'on le lise comme une erreur de saisie. */}
        {field("cpuPct", t("fieldCpu"), t("fieldCpuHint"))}
        {field("swapMb", t("fieldSwap"), t("fieldSwapHint"))}
        {field(
          "allocations",
          t("fieldAllocations"),
          t("fieldAllocationsHint"),
          overPorts ? t("overPorts") : undefined,
        )}
        {field("backups", t("fieldBackups"), t("fieldBackupsHint"))}
        {field("databases", t("fieldDatabases"), t("fieldDatabasesHint"))}
      </div>
    </div>
  );
}
