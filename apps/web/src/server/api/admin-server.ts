"use server";

import { revalidatePath } from "next/cache";
import { apiFetch, apiSend } from "./client";

export interface AdminServerVariable {
  name: string;
  envVariable: string;
  description: string | null;
  value: string;
  defaultValue: string;
  rules: string | null;
  userViewable: boolean;
  userEditable: boolean;
}

export interface AdminServerDetail {
  id: string;
  shortId: string;
  name: string;
  description: string | null;
  state: string | null;
  owner: { id: string; name: string; email: string };
  node: { id: string; name: string; fqdn: string };
  egg: { id: string; name: string; images: Record<string, string> };
  dockerImage: string;
  startup: string;
  /** L'invocation gabarits remplacés : ce que le conteneur lancera vraiment. */
  resolvedStartup: string;
  /** Gabarits qu'aucune variable ne renseigne — la commande partira amputée. */
  unresolvedPlaceholders: string[];
  resources: {
    memoryMb: number;
    swapMb: number;
    diskMb: number;
    cpuPct: number;
    ioWeight: number;
    threads: string | null;
    oomKiller: boolean;
  };
  limits: { backups: number; databases: number; allocations: number };
  variables: AdminServerVariable[];
  ports: { id: string; ip: string; port: number; isDefault: boolean }[];
  /**
   * Ce que le dernier changement de propriétaire n'a pas pu nettoyer, lu dans
   * le journal : nul quand tout a été fait. Qu'il vienne de cet écran ou de la
   * facturation, il reste signalé tant qu'une base garde son ancien mot de
   * passe.
   */
  ownerChange: OwnerChangeLeftovers | null;
}

export interface OwnerChangeLeftovers {
  /** Date du changement. */
  at: string;
  databasesNotRotated: string[];
  sessionsNotClosed: number;
}

export async function fetchAdminServer(serverId: string): Promise<AdminServerDetail> {
  const { data } = await apiFetch<{ data: AdminServerDetail }>(`/api/v1/admin/servers/${serverId}`);
  return data;
}

export async function setServerRuntime(
  serverId: string,
  input: { dockerImage?: string; startup?: string; oomKiller?: boolean },
): Promise<{ error: string | null }> {
  return act(serverId, () => apiSend(`/api/v1/admin/servers/${serverId}/runtime`, input));
}

export async function setServerVariable(
  serverId: string,
  envVariable: string,
  value: string,
): Promise<{ error: string | null }> {
  return act(serverId, () =>
    apiSend(`/api/v1/admin/servers/${serverId}/variables`, { envVariable, value }),
  );
}

/**
 * Change le jeu d'un serveur.
 *
 * `reinstall` est passé explicitement et jamais deviné : c'est lui qui fait
 * réexécuter le script d'installation du nouveau jeu sur les fichiers du
 * client. Sans lui, le serveur porte le nom d'un jeu dont rien n'est installé
 * — état légitime le temps d'une réparation de fiche, mais qui doit être
 * choisi.
 */
export async function setServerEgg(
  serverId: string,
  eggId: string,
  reinstall: boolean,
): Promise<{ error: string | null }> {
  return act(serverId, () =>
    apiSend(`/api/v1/admin/servers/${serverId}/egg`, { eggId, reinstall }),
  );
}

async function act(serverId: string, call: () => Promise<void>): Promise<{ error: string | null }> {
  try {
    await call();
    revalidatePath(`/admin/servers/${serverId}`);
    return { error: null };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Opération refusée." };
  }
}

/**
 * Déplace un serveur vers un autre node.
 *
 * L'appel rend la main dès que le node de départ a pris l'ordre, pas à la fin
 * du déménagement : celui-ci dure le temps d'une archive et d'un transfert de
 * fichiers, et tenir la page ouverte pendant ce temps n'apprendrait rien de
 * plus. L'issue arrive par la cloche, que le daemon déclenche en rapportant au
 * panel.
 */
export async function transferServer(
  serverId: string,
  nodeId: string,
): Promise<{ error: string | null }> {
  return act(serverId, () => apiSend(`/api/v1/admin/servers/${serverId}/transfer`, { nodeId }));
}
