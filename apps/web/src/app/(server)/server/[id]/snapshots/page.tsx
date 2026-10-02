import { notFound } from "next/navigation";
import { SnapshotsWorkspace } from "@/components/snapshots-workspace";
import { pageTitle } from "@/lib/page-title";
import { listSnapshots } from "@/server/api/snapshots";

export const generateMetadata = pageTitle("snapshots", "title");

export default async function SnapshotsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Pas d'agent qui les offre sur cette machine : l'onglet n'existe pas.
  const initial = await listSnapshots(id);
  if (!initial) notFound();
  return <SnapshotsWorkspace serverId={id} initial={initial} />;
}
