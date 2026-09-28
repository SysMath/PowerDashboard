import { AlertBanner, PageHeader, PageTemplate } from "@gamedashboard/ui";
import { ChartColumn } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { ConsumptionExport } from "@/components/consumption-export";
import { pageTitle } from "@/lib/page-title";
import { CONFIGURATION_ROLES } from "@/lib/roles";
import { fetchMe } from "@/server/api/client";

export const generateMetadata = pageTitle("consumption", "metaTitle");

/**
 * Consommation de toute la plateforme (PLAN §10.3).
 *
 * Le support voit la page mais pas le formulaire : l'API réserve l'export aux
 * administrateurs, puisqu'il nomme chaque client. Le lui proposer mènerait à
 * un refus au moment du clic.
 */
export default async function AdminConsumptionPage() {
  const [t, me] = await Promise.all([getTranslations("consumption"), fetchMe()]);

  return (
    <PageTemplate
      width="readable"
      header={
        <PageHeader icon={<ChartColumn />} title={t("pageTitle")} subtitle={t("adminSubtitle")} />
      }
    >
      {CONFIGURATION_ROLES.has(me.role) ? (
        <ConsumptionExport endpoint="/api/admin/consumption-export" audience="admin" />
      ) : (
        <AlertBanner variant="info">{t("adminOnly")}</AlertBanner>
      )}
    </PageTemplate>
  );
}
