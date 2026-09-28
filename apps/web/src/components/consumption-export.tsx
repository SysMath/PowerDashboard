"use client";

import {
  CONSUMPTION_MAX_SPAN_DAYS,
  type ConsumptionExportFormat,
  consumptionPeriod,
  utcDay,
} from "@gamedashboard/contracts";
import { Button, FormField, Input, SettingsSection } from "@gamedashboard/ui";
import { Download } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

const FORMATS: readonly ConsumptionExportFormat[] = ["csv", "jsonl"];

/**
 * Télécharger la consommation journalière d'une période (PLAN §10.3).
 *
 * Le même formulaire pour l'administration, l'espace revendeur et la page
 * d'un serveur : seule change l'adresse du relais, qui porte le périmètre.
 * Le lien est un vrai lien : le navigateur télécharge en flux, sans que la
 * page tienne le fichier en mémoire.
 *
 * La période est vérifiée ici avec la règle de l'API (`consumptionPeriod`),
 * pour dire tout de suite ce que l'API refuserait — et non ouvrir un onglet
 * sur un message d'erreur brut.
 */
export function ConsumptionExport({
  endpoint,
  audience,
}: {
  /** Relais de téléchargement, sans paramètres : `/api/admin/consumption-export`. */
  endpoint: string;
  /** Qui télécharge : décide de la phrase qui dit ce que contient le fichier. */
  audience: "admin" | "reseller" | "server";
}) {
  const t = useTranslations("consumption");
  const [to, setTo] = useState(() => utcDay(new Date()));
  const [from, setFrom] = useState(() => `${to.slice(0, 8)}01`);
  const checked = from && to ? consumptionPeriod({ from, to }) : null;
  const error =
    checked === null
      ? t("missingDates")
      : "error" in checked
        ? from > to
          ? t("reversed")
          : t("tooLong", { max: CONSUMPTION_MAX_SPAN_DAYS })
        : undefined;
  const href = (format: ConsumptionExportFormat) =>
    `${endpoint}?${new URLSearchParams({ from, to, format })}`;

  return (
    <SettingsSection
      title={t("title")}
      description={t(`${audience}Description`)}
      footer={FORMATS.map((format) =>
        error ? (
          <Button key={format} variant="secondary" disabled>
            <Download /> {t(format)}
          </Button>
        ) : (
          <Button key={format} asChild variant="secondary">
            <a href={href(format)} download>
              <Download /> {t(format)}
            </a>
          </Button>
        ),
      )}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label={t("from")} error={error}>
          {(id) => (
            <Input id={id} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          )}
        </FormField>
        <FormField label={t("to")}>
          {(id) => <Input id={id} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}
        </FormField>
      </div>
      <p className="mt-4 text-xs text-muted">{t("hint")}</p>
    </SettingsSection>
  );
}
