"use server";

import { revalidatePath } from "next/cache";
import { apiFetch, apiSend } from "./client";

export interface Backup {
  id: string;
  name: string;
  bytes: number;
  checksum: string | null;
  /** `null` = en cours. Ni réussie, ni ratée : on ne sait pas encore. */
  isSuccessful: boolean | null;
  isLocked: boolean;
  createdAt: string;
  completedAt: string | null;
  /** `snapshot` : archivée par l'agent depuis un instantané, donc cohérente. */
  source?: "wings" | "snapshot";
}

export interface BackupList {
  items: Backup[];
  used: number;
  limit: number;
}

export async function listBackups(serverId: string): Promise<BackupList> {
  const { data, meta } = await apiFetch<{
    data: Backup[];
    meta: { used: number; limit: number };
  }>(`/api/v1/client/servers/${serverId}/backups`);

  return { items: data, used: meta.used, limit: meta.limit };
}

export async function createBackup(
  serverId: string,
  name: string,
): Promise<{ error: string | null }> {
  return act(serverId, () => apiSend(`/api/v1/client/servers/${serverId}/backups`, { name }));
}

export async function setBackupLock(
  serverId: string,
  backupId: string,
  locked: boolean,
): Promise<{ error: string | null }> {
  return act(serverId, () =>
    apiSend(`/api/v1/client/servers/${serverId}/backups/${backupId}/lock`, { locked }),
  );
}

export async function restoreBackup(
  serverId: string,
  backupId: string,
  truncate: boolean,
): Promise<{ error: string | null }> {
  return act(serverId, () =>
    apiSend(`/api/v1/client/servers/${serverId}/backups/${backupId}/restore`, { truncate }),
  );
}

export async function deleteBackup(
  serverId: string,
  backupId: string,
): Promise<{ error: string | null }> {
  return act(serverId, () =>
    apiSend(`/api/v1/client/servers/${serverId}/backups/${backupId}`, undefined, "DELETE"),
  );
}

async function act(serverId: string, call: () => Promise<void>): Promise<{ error: string | null }> {
  try {
    await call();
    revalidatePath(`/server/${serverId}/backups`);
    return { error: null };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Opération refusée." };
  }
}

/**
 * Adresse de téléchargement d'une archive.
 *
 * L'adresse est **rendue au navigateur**, qui va chercher les octets lui-même
 * auprès du compartiment ou du daemon : le panel ne relaie jamais un fichier de
 * plusieurs gigaoctets.
 *
 * Elle est demandée au moment du clic et jamais gardée : côté daemon elle ne
 * vaut qu'une fois, côté compartiment un quart d'heure. Une adresse préparée à
 * l'affichage de la liste serait déjà périmée quand on clique.
 */
export async function backupDownloadUrl(
  serverId: string,
  backupId: string,
): Promise<{ url: string | null; error: string | null }> {
  try {
    const { data } = await apiFetch<{ data: { url: string } }>(
      `/api/v1/client/servers/${serverId}/backups/${backupId}/download`,
    );
    return { url: data.url, error: null };
  } catch (error) {
    return {
      url: null,
      error: error instanceof Error ? error.message : "Téléchargement indisponible.",
    };
  }
}
