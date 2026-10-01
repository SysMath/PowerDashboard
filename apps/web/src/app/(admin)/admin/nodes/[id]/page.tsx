import { notFound } from "next/navigation";
import { AdminNodeSheet } from "@/components/admin-node-sheet";
import type { ResellerOption } from "@/components/admin-nodes";
import { toNodeRow } from "@/lib/admin-view";
import { pageTitle } from "@/lib/page-title";
import {
  fetchAdminNodes,
  fetchAdminUsers,
  fetchLocations,
  fetchNodeTaxonomy,
} from "@/server/api/admin";
import { fetchAdminNodeDetail, fetchNodeAllocations } from "@/server/api/admin-node";
import { fetchNodeAgent, fetchNodeSnapshots } from "@/server/api/admin-snapshots";

export const generateMetadata = pageTitle("nodeAdmin", "sheetMetaTitle");

/**
 * Fiche d'une machine : tout ce qu'on fait d'un node, rangé par section.
 *
 * La ligne de la liste accompagne la fiche : elle porte ce que la fiche seule
 * ne dit pas — l'exploitant nommé, la consommation relevée.
 */
export default async function AdminNodeSheetPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ section?: string }>;
}) {
  const [{ id }, { section }] = await Promise.all([params, searchParams]);
  const [detail, allocations, nodes, users, taxonomy, locations, agent, snapshots] =
    await Promise.all([
      fetchAdminNodeDetail(id),
      fetchNodeAllocations(id),
      fetchAdminNodes(),
      fetchAdminUsers(),
      fetchNodeTaxonomy(),
      fetchLocations(),
      fetchNodeAgent(id),
      fetchNodeSnapshots(id),
    ]);

  const row = nodes.find((node) => node.id === id);
  if (!row) notFound();

  const resellers: ResellerOption[] = users
    .filter((user) => user.role === "reseller")
    .map((user) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      platformAccess: user.platformAccess,
    }));

  return (
    <AdminNodeSheet
      detail={detail}
      row={toNodeRow(row)}
      allocations={allocations}
      resellers={resellers}
      taxonomy={taxonomy}
      locations={locations}
      initialSection={section}
      agent={agent}
      // Fonction coupée pour la plateforme : rien à régler ici.
      snapshots={snapshots?.capability.state === "platform_disabled" ? null : snapshots}
      // Lue sur le serveur, jamais reconstruite depuis le navigateur : la
      // commande affichée écrira cette adresse dans la configuration du daemon.
      panelOrigin={process.env.PANEL_ORIGIN ?? "http://localhost:3000"}
    />
  );
}
