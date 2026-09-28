import { PageHeader, PageTemplate } from "@gamedashboard/ui";
import { ChartColumn } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { ConsumptionExport } from "@/components/consumption-export";
import { pageTitle } from "@/lib/page-title";

export const generateMetadata = pageTitle("consumption", "metaTitle");

/** Consommation du parc du revendeur (PLAN §10.3), pour facturer ses clients à l'usage. */
export default async function ResellerConsumptionPage() {
  const t = await getTranslations("consumption");

  return (
    <PageTemplate
      width="readable"
      header={
        <PageHeader
          icon={<ChartColumn />}
          title={t("pageTitle")}
          subtitle={t("resellerSubtitle")}
        />
      }
    >
      <ConsumptionExport endpoint="/api/reseller/consumption-export" audience="reseller" />
    </PageTemplate>
  );
}
