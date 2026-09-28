import { relayDownload } from "@/server/download-relay";

/** Consommation de toute la plateforme ; l'API la réserve aux administrateurs. */
export function GET(request: Request): Promise<Response> {
  return relayDownload(request, "/api/v1/admin/consumption/export");
}
