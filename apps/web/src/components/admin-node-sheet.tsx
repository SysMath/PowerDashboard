"use client";

import type { AdminNodeAgentView } from "@gamedashboard/contracts";
import {
  PageHeader,
  PageTemplate,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@gamedashboard/ui";
import { HardDrive } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import type { NodeRow } from "@/lib/admin-view";
import { useAutoRefresh } from "@/lib/use-auto-refresh";
import type { AdminLocation, AdminNodeTaxonomy } from "@/server/api/admin";
import type { AdminNodeAllocation, AdminNodeDetail } from "@/server/api/admin-node";
import type { AdminNodeSnapshotsData } from "@/server/api/admin-snapshots";
import { AdminNodeAgent } from "./admin-node-agent";
import { AdminNodeDanger } from "./admin-node-danger";
import { AdminNodeInstall } from "./admin-node-install";
import { AdminNodeOverview } from "./admin-node-overview";
import { AdminNodePorts } from "./admin-node-ports";
import { AdminNodeResellers } from "./admin-node-resellers";
import { AdminNodeSettings } from "./admin-node-settings";
import { AdminNodeSnapshots } from "./admin-node-snapshots";
import type { ResellerOption } from "./admin-nodes";
import { NodeStatusLine } from "./node-status-line";

/** Les sections de la fiche, dans l'ordre où on les parcourt. */
const SECTIONS = [
  "overview",
  "settings",
  "ports",
  "install",
  "agent",
  "resellers",
  "danger",
] as const;
type Section = (typeof SECTIONS)[number];

/**
 * Fiche d'une machine.
 *
 * Sept sections nommées plutôt qu'un menu de douze entrées : chaque geste y a
 * la place de dire ce qu'il touche — le panel seul, ou aussi le `config.yml`
 * de la machine — et ce qu'il risque. La section ouverte suit l'adresse
 * (`?section=ports`), pour qu'un lien depuis la liste dépose au bon endroit.
 */
export function AdminNodeSheet(props: {
  detail: AdminNodeDetail;
  row: NodeRow;
  allocations: AdminNodeAllocation[];
  resellers: ResellerOption[];
  taxonomy: AdminNodeTaxonomy;
  locations: AdminLocation[];
  initialSection?: string;
  panelOrigin: string;
  /** Agent de node (ADR 0008) ; `null` si la lecture a été refusée. */
  agent: AdminNodeAgentView | null;
  /** Instantanés ; `null` quand la fonction est coupée pour la plateforme. */
  snapshots: AdminNodeSnapshotsData | null;
}) {
  const t = useTranslations("nodeAdmin");
  const { detail, row } = props;
  const initial = SECTIONS.includes(props.initialSection as Section)
    ? (props.initialSection as Section)
    : "overview";
  const [section, setSection] = useState<Section>(initial);

  // L'état vieillit entre deux rafraîchissements : on relit la fiche, et
  // l'horloge de la page recalcule « depuis quand ».
  useAutoRefresh();
  const [now, setNow] = useState<number | undefined>(undefined);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);

  const choose = (next: string) => {
    setSection(next as Section);
    window.history.replaceState(null, "", `?section=${next}`);
  };

  return (
    <PageTemplate
      header={
        <PageHeader
          icon={<HardDrive />}
          title={detail.name}
          subtitle={<span className="gd-mono">{detail.fqdn}</span>}
          breadcrumbs={[{ label: t("title"), href: "/admin/nodes" }, { label: detail.name }]}
          LinkComponent={Link}
          breadcrumbsLabel={t("breadcrumbs")}
        />
      }
      // L'état sous le titre, sur toutes les sections : c'est la première
      // chose qu'on vient vérifier, quelle que soit la raison de la visite.
      toolbar={<NodeStatusLine node={detail} now={now} detailed />}
    >
      <Tabs value={section} defaultValue={initial} onValueChange={choose}>
        <TabsList className="flex-wrap">
          {SECTIONS.map((key) => (
            <TabsTrigger
              key={key}
              value={key}
              count={key === "ports" ? props.allocations.length : undefined}
            >
              {t(`section.${key}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        <div className="pt-6">
          <TabsContent value="overview">
            <AdminNodeOverview detail={detail} row={row} now={now} />
          </TabsContent>
          <TabsContent value="settings">
            <AdminNodeSettings
              detail={detail}
              taxonomy={props.taxonomy}
              locations={props.locations}
            />
          </TabsContent>
          <TabsContent value="ports">
            <AdminNodePorts node={detail} allocations={props.allocations} />
          </TabsContent>
          <TabsContent value="install">
            <AdminNodeInstall node={detail} panelOrigin={props.panelOrigin} />
          </TabsContent>
          <TabsContent value="agent">
            <div className="flex flex-col gap-6">
              {props.agent ? (
                <AdminNodeAgent
                  nodeId={detail.id}
                  agent={props.agent}
                  panelOrigin={props.panelOrigin}
                />
              ) : null}
              {props.snapshots ? (
                <AdminNodeSnapshots nodeId={detail.id} initial={props.snapshots} />
              ) : null}
            </div>
          </TabsContent>
          <TabsContent value="resellers">
            <AdminNodeResellers node={detail} resellers={props.resellers} />
          </TabsContent>
          <TabsContent value="danger">
            <AdminNodeDanger node={detail} />
          </TabsContent>
        </div>
      </Tabs>
    </PageTemplate>
  );
}
