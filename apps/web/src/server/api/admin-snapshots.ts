"use server";

import type {
  AdminNodeAgentView,
  NodeCapability,
  NodeSnapshotStatus,
  SnapshotCause,
  SnapshotPolicy,
} from "@gamedashboard/contracts";
import { revalidatePath } from "next/cache";
import { ApiError, apiFetch, apiSend, apiSendFor } from "./client";

/**
 * Agent de node et instantanés, côté administration (ADR 0008, ADR 0009).
 *
 * Lectures et actions dans un même fichier `"use server"` : tout y est
 * fonction asynchrone, et la fiche du node est le seul écran qui s'en sert.
 */

/** Un instantané du registre d'un node. */
export interface AdminNodeSnapshot {
  name: string;
  takenAt: string;
  cause: SnapshotCause;
  bytes: number | null;
  serverCount: number;
  pins: number;
}

export interface AdminNodeSnapshotsData {
  policy: SnapshotPolicy;
  /** Réglages propres au node ; faux : il suit les valeurs par défaut. */
  custom: boolean;
  status: NodeSnapshotStatus;
  capability: NodeCapability;
  snapshots: AdminNodeSnapshot[];
}

const nodePath = (nodeId: string) => `/api/v1/admin/nodes/${nodeId}`;

/** `null` sur un 404 : le node a disparu entre la liste et la fiche. */
async function read<T>(path: string): Promise<T | null> {
  try {
    return (await apiFetch<{ data: T }>(path)).data;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export async function fetchNodeAgent(nodeId: string): Promise<AdminNodeAgentView | null> {
  return read(`${nodePath(nodeId)}/agent`);
}

export async function fetchNodeSnapshots(nodeId: string): Promise<AdminNodeSnapshotsData | null> {
  return read(`${nodePath(nodeId)}/snapshots`);
}

export async function fetchSnapshotDefaults(): Promise<SnapshotPolicy> {
  return (await apiFetch<{ data: SnapshotPolicy }>("/api/v1/admin/snapshots/defaults")).data;
}

export async function revokeNodeAgent(nodeId: string): Promise<{ error: string | null }> {
  return act(nodeId, () => apiSend(`${nodePath(nodeId)}/agent`, undefined, "DELETE"));
}

/** `null` rend le node aux valeurs par défaut. */
export async function saveNodeSnapshotPolicy(
  nodeId: string,
  policy: SnapshotPolicy | null,
): Promise<{ error: string | null }> {
  return act(nodeId, () => apiSend(`${nodePath(nodeId)}/snapshots/policy`, { policy }));
}

export async function destroyNodeSnapshot(
  nodeId: string,
  name: string,
): Promise<{ error: string | null }> {
  return act(nodeId, () =>
    apiSend(`${nodePath(nodeId)}/snapshots/${encodeURIComponent(name)}`, undefined, "DELETE"),
  );
}

export async function saveSnapshotDefaults(
  policy: SnapshotPolicy,
): Promise<{ error: string | null; policy: SnapshotPolicy | null }> {
  try {
    const { data } = await apiSendFor<{ data: SnapshotPolicy }>(
      "/api/v1/admin/snapshots/defaults",
      policy,
    );
    revalidatePath("/admin/settings");
    return { error: null, policy: data };
  } catch (error) {
    return { error: message(error), policy: null };
  }
}

async function act(nodeId: string, call: () => Promise<void>): Promise<{ error: string | null }> {
  try {
    await call();
    revalidatePath(`/admin/nodes/${nodeId}`);
    return { error: null };
  } catch (error) {
    return { error: message(error) };
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Opération refusée.";
}
