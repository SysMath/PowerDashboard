import { relayDownload } from "@/server/download-relay";

/** Consommation du parc du revendeur connecté : l'API borne au revendeur de la session. */
export function GET(request: Request): Promise<Response> {
  return relayDownload(request, "/api/v1/reseller/consumption/export");
}
