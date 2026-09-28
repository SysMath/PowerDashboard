"use server";

import { revalidatePath } from "next/cache";
import { apiFetch, apiSend } from "./client";

export interface StartupVariable {
  envVariable: string;
  name: string;
  description: string | null;
  value: string;
  defaultValue: string;
  isEditable: boolean;
  rules: string;
}

export interface ServerSettings {
  id: string;
  shortId: string;
  name: string;
  description: string | null;
  eggName: string;
  dockerImage: string;
  nodeName: string;
  memoryMb: number;
  diskMb: number;
  cpuPct: number;
  swapMb: number;
  /** Images déclarées par l'egg : le client choisit dedans, jamais librement. */
  eggImages: Record<string, string>;
  address: string;
  sftpHost: string;
  sftpPort: number;
  sftpUsername: string;
  /** Faux tant que l'authentification SFTP n'est pas servie par le panel. */
  sftpIsOpen: boolean;
  /** Faux quand l'annuaire est obligatoire : clés SSH seulement. */
  sftpPasswordAccepted: boolean;
  variables: StartupVariable[];
}

export async function setDockerImage(
  serverId: string,
  image: string,
): Promise<{ error: string | null }> {
  return act(serverId, () =>
    apiSend(`/api/v1/client/servers/${serverId}/settings/docker-image`, { image }),
  );
}

export async function fetchSettings(serverId: string): Promise<ServerSettings> {
  const { data } = await apiFetch<{ data: ServerSettings }>(
    `/api/v1/client/servers/${serverId}/settings`,
  );
  return data;
}

export async function renameServer(
  serverId: string,
  name: string,
  description: string,
): Promise<{ error: string | null }> {
  return act(serverId, () =>
    apiSend(`/api/v1/client/servers/${serverId}/settings/rename`, { name, description }),
  );
}

export async function saveVariables(
  serverId: string,
  values: Record<string, string>,
): Promise<{ error: string | null }> {
  return act(serverId, () =>
    apiSend(`/api/v1/client/servers/${serverId}/settings/variables`, { values }),
  );
}

export async function reinstallServer(serverId: string): Promise<{ error: string | null }> {
  return act(serverId, () => apiSend(`/api/v1/client/servers/${serverId}/settings/reinstall`, {}));
}

async function act(serverId: string, call: () => Promise<void>): Promise<{ error: string | null }> {
  try {
    await call();
    revalidatePath(`/server/${serverId}/settings`);
    return { error: null };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Opération refusée." };
  }
}
