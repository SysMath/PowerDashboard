import { NetworkWorkspace } from "@/components/network-workspace";
import { SubdomainCard } from "@/components/subdomain-card";
import { pageTitle } from "@/lib/page-title";
import { getSubdomain, listAllocations } from "@/server/api/network";

export const generateMetadata = pageTitle("network", "title");

export default async function NetworkPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [allocations, subdomain] = await Promise.all([listAllocations(id), getSubdomain(id)]);
  return (
    <NetworkWorkspace
      serverId={id}
      initial={allocations}
      subdomain={subdomain ? <SubdomainCard serverId={id} state={subdomain} /> : null}
    />
  );
}
