"use server";

import type { SubdomainState } from "@gamedashboard/contracts";
import { revalidatePath } from "next/cache";
import { apiFetch, apiReadFor, apiSend } from "./client";

export interface Allocation {
  id: string;
  ip: string;
  alias: string | null;
  port: number;
  notes: string | null;
  isPrimary: boolean;
}

export interface AllocationList {
  items: Allocation[];
  used: number;
  limit: number;
  /** Ports encore libres sur le node : le quota du serveur ne suffit pas à en obtenir un. */
  available: number;
}

export async function listAllocations(serverId: string): Promise<AllocationList> {
  const { data, meta } = await apiFetch<{
    data: Allocation[];
    meta: { used: number; limit: number; available: number };
  }>(`/api/v1/client/servers/${serverId}/allocations`);

  return { items: data, ...meta };
}

export async function claimAllocation(serverId: string): Promise<{ error: string | null }> {
  return act(serverId, () => apiSend(`/api/v1/client/servers/${serverId}/allocations`, {}));
}

export async function setPrimaryAllocation(
  serverId: string,
  allocationId: string,
): Promise<{ error: string | null }> {
  return act(serverId, () =>
    apiSend(`/api/v1/client/servers/${serverId}/allocations/${allocationId}/primary`, {}),
  );
}

export async function setAllocationNotes(
  serverId: string,
  allocationId: string,
  notes: string,
): Promise<{ error: string | null }> {
  return act(serverId, () =>
    apiSend(`/api/v1/client/servers/${serverId}/allocations/${allocationId}/notes`, { notes }),
  );
}

export async function releaseAllocation(
  serverId: string,
  allocationId: string,
): Promise<{ error: string | null }> {
  return act(serverId, () =>
    apiSend(`/api/v1/client/servers/${serverId}/allocations/${allocationId}`, undefined, "DELETE"),
  );
}

/**
 * Le sous-domaine du serveur, ou `null` si l'API ne répond pas : l'écran
 * réseau doit rester lisible sans lui.
 */
export async function getSubdomain(serverId: string): Promise<SubdomainState | null> {
  try {
    // Lecture d'appoint : un refus (sous-utilisateur sans `allocations.read`)
    // masque la carte, il ne renvoie pas vers la connexion.
    const { data } = await apiReadFor<{ data: SubdomainState }>(
      `/api/v1/client/servers/${serverId}/subdomain`,
    );
    return data;
  } catch {
    return null;
  }
}

export async function chooseSubdomain(
  serverId: string,
  label: string,
): Promise<{ error: string | null }> {
  return act(serverId, () => apiSend(`/api/v1/client/servers/${serverId}/subdomain`, { label }));
}

export async function removeSubdomain(serverId: string): Promise<{ error: string | null }> {
  return act(serverId, () =>
    apiSend(`/api/v1/client/servers/${serverId}/subdomain`, undefined, "DELETE"),
  );
}

async function act(serverId: string, call: () => Promise<void>): Promise<{ error: string | null }> {
  try {
    await call();
    revalidatePath(`/server/${serverId}/network`);
    return { error: null };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Opération refusée." };
  }
}
