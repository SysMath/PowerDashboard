"use server";

import type { ServerSnapshotsMeta, ServerSnapshotView } from "@gamedashboard/contracts";
import { revalidatePath } from "next/cache";
import { ApiError, apiFetch, apiSend } from "./client";

export interface SnapshotList {
  items: ServerSnapshotView[];
  meta: ServerSnapshotsMeta;
}

/** `null` quand la machine n'offre pas les instantanés (404 de l'API). */
export async function listSnapshots(serverId: string): Promise<SnapshotList | null> {
  try {
    const { data, meta } = await apiFetch<{
      data: ServerSnapshotView[];
      meta: ServerSnapshotsMeta;
    }>(`/api/v1/client/servers/${serverId}/snapshots`);
    return { items: data, meta };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

const base = (serverId: string) => `/api/v1/client/servers/${serverId}/snapshots`;
const one = (serverId: string, name: string, action: string) =>
  `${base(serverId)}/${encodeURIComponent(name)}/${action}`;

export async function takeSnapshot(serverId: string): Promise<{ error: string | null }> {
  return act(serverId, () => apiSend(base(serverId), {}));
}

export async function pinSnapshot(
  serverId: string,
  name: string,
  label: string,
): Promise<{ error: string | null }> {
  return act(serverId, () =>
    apiSend(one(serverId, name, "pin"), label.trim() ? { label: label.trim() } : {}),
  );
}

export async function unpinSnapshot(
  serverId: string,
  name: string,
): Promise<{ error: string | null }> {
  return act(serverId, () => apiSend(one(serverId, name, "pin"), undefined, "DELETE"));
}

export async function restoreSnapshot(
  serverId: string,
  name: string,
): Promise<{ error: string | null }> {
  return act(serverId, () => apiSend(one(serverId, name, "restore"), {}));
}

async function act(serverId: string, call: () => Promise<void>): Promise<{ error: string | null }> {
  try {
    await call();
    revalidatePath(`/server/${serverId}/snapshots`);
    return { error: null };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Opération refusée." };
  }
}
