import { relayDownload } from "@/server/download-relay";

/**
 * Consommation d'un serveur. L'identifiant est encodé : il désigne un
 * serveur, jamais un autre chemin de l'API.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return relayDownload(
    request,
    `/api/v1/client/servers/${encodeURIComponent(id)}/consumption/export`,
  );
}
