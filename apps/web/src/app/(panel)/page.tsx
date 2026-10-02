import {
  Button,
  EmptyState,
  formatMb,
  PageHeader,
  PageTemplate,
  StatTile,
} from "@gamedashboard/ui";
import { Gauge, HardDrive, MemoryStick, Plus, Server } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { BillingPanel } from "@/components/billing-panel";
import { BillingSetupNotice } from "@/components/billing-setup-notice";
import { InstatusBanner } from "@/components/instatus-banner";
import { ServerGrid } from "@/components/server-grid";
import { pageTitle } from "@/lib/page-title";
import { CONFIGURATION_ROLES } from "@/lib/roles";
import { toCardServer } from "@/lib/server-view";
import { AutoRefresh } from "@/lib/use-auto-refresh";
import { pendingAppLink } from "@/server/api/app-devices";
import { fetchBilling, fetchNotice } from "@/server/api/billing";
import { fetchMe, fetchMyServers } from "@/server/api/client";

export const generateMetadata = pageTitle("quickAccess", "title");

/**
 * L'accueil du panel.
 *
 * Une seule page, là où il y en avait deux. « Accès rapide » et « Tableau de
 * bord » montraient la même chose à deux adresses : les serveurs et leurs
 * chiffres. Deux entrées de menu pour un même contenu obligent à choisir avant
 * de savoir ce qu'on trouvera derrière, et l'une des deux finit par ne plus
 * être visitée.
 *
 * Elle vit dans `(panel)` sans segment : le groupe de routes ne change pas
 * l'adresse — on reste sur « / » — mais fait passer la page par la coquille.
 */
export default async function HomePage() {
  // Une liaison de l'application mobile attendait la connexion : toutes les
  // voies de connexion mènent ici, et c'est ici qu'on la reprend (ADR 0010).
  if (await pendingAppLink()) redirect("/app-link");

  // Les lectures partent ensemble. Deux interrogent des services tiers ; les
  // enchaîner additionnerait leurs latences sur la page ouverte en premier.
  const [t, servers, billing, notice, me] = await Promise.all([
    getTranslations("quickAccess"),
    fetchMyServers(),
    fetchBilling(),
    fetchNotice(),
    fetchMe(),
  ]);

  /**
   * Les chiffres affichés sont ceux que la base connaît : nombre de serveurs et
   * quotas alloués. Le nombre de joueurs et la consommation réelle viennent du
   * temps réel et n'ont donc pas de tuile ici — plutôt que d'en afficher une à
   * zéro, qui serait lue comme « aucun joueur » et non comme « pas encore
   * mesuré ».
   */
  const memoryQuota = servers.reduce((sum, server) => sum + server.memoryMaxMb, 0);
  const diskQuota = servers.reduce((sum, server) => sum + server.diskMaxMb, 0);
  const owned = servers.filter((server) => server.isOwner).length;

  return (
    <PageTemplate
      header={
        <PageHeader
          icon={<Gauge />}
          title={t("title")}
          subtitle={t("subtitle")}
          actions={
            servers.length > 0 ? (
              <Button asChild>
                <Link href="/servers">{t("allServers")}</Link>
              </Button>
            ) : null
          }
        />
      }
    >
      {/* L'état des serveurs vieillit : sans ce rafraîchissement, une page
          laissée ouverte montre « hors ligne » sur un serveur relancé depuis. */}
      <AutoRefresh />

      <InstatusBanner notice={notice} />

      {/*
        Adressé à qui peut y remédier, et à personne d'autre.

        Pas au client, qui n'a aucune main sur ce réglage : lui annoncer une
        fonction qu'il ne peut pas activer ne fait que du bruit, et lui
        apprend au passage comment la plateforme est configurée. Pas au
        support non plus, qui voit l'administration mais n'y écrit pas — le
        lien le mènerait à un formulaire qu'il ne peut pas enregistrer.
      */}
      <BillingSetupNotice show={!billing.configured && CONFIGURATION_ROLES.has(me.role)} />

      {servers.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-3">
          <StatTile
            icon={<Server />}
            tone="accent"
            label={t("statServers")}
            value={servers.length}
            hint={
              owned === servers.length
                ? t("statAllOwned")
                : t("statShared", { owned, shared: servers.length - owned })
            }
          />
          <StatTile
            icon={<MemoryStick />}
            label={t("statMemory")}
            value={formatMb(memoryQuota, 0)}
            hint={t("statQuotaSum")}
          />
          <StatTile
            icon={<HardDrive />}
            label={t("statDisk")}
            value={formatMb(diskQuota, 0)}
            hint={t("statQuotaSum")}
          />
        </div>
      ) : null}

      {servers.length === 0 ? (
        <EmptyState
          icon={<Server />}
          title={t("noServerTitle")}
          description={t("noServerBody")}
          action={
            <Button asChild>
              <Link href="/servers/new">
                <Plus /> {t("createServer")}
              </Link>
            </Button>
          }
        />
      ) : (
        <ServerGrid servers={servers.map(toCardServer)} />
      )}

      <BillingPanel billing={billing} />
    </PageTemplate>
  );
}
