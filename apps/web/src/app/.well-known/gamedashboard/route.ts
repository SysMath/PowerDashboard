import type { InstanceDescriptor, InstanceIdentity } from "@gamedashboard/contracts";
import { getBranding } from "@/server/api/branding";

const API_URL = process.env.API_URL ?? "http://127.0.0.1:3201";

/**
 * Descripteur d'instance (ADR 0010) : ce que l'application mobile lit avant
 * toute connexion pour savoir qu'elle parle à un panel GameDashboard, et
 * lequel. Servi par Next, donc présent sur chaque domaine de revendeur, avec
 * le nom de sa marque. Rien de secret.
 */
export async function GET(): Promise<Response> {
  try {
    const response = await fetch(`${API_URL}/api/v1/instance`, {
      cache: "no-store",
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { data } = (await response.json()) as { data: InstanceIdentity };
    const { name } = await getBranding();
    const descriptor: InstanceDescriptor = { ...data, nom: name };
    return Response.json(descriptor, { headers: { "cache-control": "no-store" } });
  } catch {
    // 503 et non 404 : l'adresse est bien un panel, momentanément muet.
    return Response.json({ message: "Panel momentanément indisponible." }, { status: 503 });
  }
}

export const dynamic = "force-dynamic";
