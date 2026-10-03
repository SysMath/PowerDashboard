"use server";

import type { PlatformAccess, ResellerOverview } from "@gamedashboard/contracts";
import { revalidatePath } from "next/cache";
import { apiFetch, apiSendFor } from "./client";

export type {
  ResellerClient,
  ResellerNode,
  ResellerOverview,
  ResellerQuotaReport,
  ResellerServer,
} from "@gamedashboard/contracts";

export async function fetchResellerOverview(): Promise<ResellerOverview> {
  const { data } = await apiFetch<{ data: ResellerOverview }>("/api/v1/reseller/overview");
  return data;
}

/**
 * Autorise, ou retire l'autorisation à, l'administration de la plateforme.
 *
 * Aucun identifiant n'est envoyé : la route agit sur le compte de la session.
 * En accepter un ferait de cet appel le moyen, pour l'administration,
 * de s'accorder elle-même la permission qu'elle est censée demander.
 */
export async function setPlatformAccess(level: PlatformAccess): Promise<{ error: string | null }> {
  try {
    await apiSendFor("/api/v1/reseller/platform-provisioning", { level });
    // Toutes les pages de l'espace montrent cet état : c'est le chemin entier
    // qui est périmé, pas une seule page.
    revalidatePath("/reseller", "layout");
    return { error: null };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Opération refusée." };
  }
}
