"use server";

import {
  BACKUP_RESTORE_TIMEOUT_MS,
  type ClientBackupList,
  type ClientBackupView,
} from "@gamedashboard/contracts";
import { revalidatePath } from "next/cache";
import { apiFetch, apiSend } from "./client";

/** Définies avec l'application mobile, qui lit la même route (ADR 0010). */
export type Backup = ClientBackupView;
export type BackupList = ClientBackupList;

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
    // L'API attend d'abord l'instantané de sûreté de l'agent, s'il y en a un.
    apiSend(
      `/api/v1/client/servers/${serverId}/backups/${backupId}/restore`,
      { truncate },
      "POST",
      { delaiMs: BACKUP_RESTORE_TIMEOUT_MS },
    ),
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
