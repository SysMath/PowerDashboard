"use server";

import type { RolePresets } from "@gamedashboard/contracts";
import { revalidatePath } from "next/cache";
import { apiFetch, apiSend, apiSendFor } from "./client";

export interface Subuser {
  id: string;
  userId: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  permissions: string[];
  /** `null` tant que la personne n'a pas accepté : elle n'a alors aucun droit. */
  acceptedAt: string | null;
  createdAt: string;
}

export async function listSubusers(serverId: string): Promise<Subuser[]> {
  const { data } = await apiFetch<{ data: Subuser[] }>(
    `/api/v1/client/servers/${serverId}/subusers`,
  );
  return data;
}

/**
 * Presets proposés à l'invitation, lus dans l'API.
 *
 * Et non dans `contracts` : l'administration peut les redéfinir, et le
 * formulaire doit pré-cocher ce qu'elle a décidé, pas ce que le code disait.
 */
export async function listSubuserPresets(serverId: string): Promise<RolePresets> {
  const { data } = await apiFetch<{ data: RolePresets }>(
    `/api/v1/client/servers/${serverId}/subusers/presets`,
  );
  return data;
}

export async function inviteSubuser(
  serverId: string,
  email: string,
  permissions: string[],
): Promise<{ error: string | null }> {
  return act(serverId, () =>
    apiSend(`/api/v1/client/servers/${serverId}/subusers`, { email, permissions }),
  );
}

/** Invitation partie par courriel vers une adresse qui n'a pas encore de compte. */
export interface ServerInvite {
  id: string;
  email: string;
  permissions: string[];
  expiresAt: string;
  createdAt: string;
  invitedBy: string;
}

/**
 * Invitations en cours.
 *
 * Lues séparément des sous-utilisateurs, et affichées séparément : elles ne
 * donnent aucun accès et ne désignent aucun compte. Les fondre dans la même
 * liste ferait apparaître des personnes qui n'existent pas encore, avec des
 * boutons — « modifier les permissions », « retirer l'accès » — qui n'auraient
 * rien sur quoi agir.
 */
export async function listServerInvites(serverId: string): Promise<ServerInvite[]> {
  const { data } = await apiFetch<{ data: ServerInvite[] }>(
    `/api/v1/client/servers/${serverId}/subusers/invites`,
  );
  return data;
}

export async function revokeServerInvite(
  serverId: string,
  inviteId: string,
): Promise<{ error: string | null }> {
  return act(serverId, () =>
    apiSend(`/api/v1/client/servers/${serverId}/subusers/invites/${inviteId}`, undefined, "DELETE"),
  );
}

export async function updateSubuser(
  serverId: string,
  subuserId: string,
  permissions: string[],
): Promise<{ error: string | null }> {
  return act(serverId, () =>
    apiSend(`/api/v1/client/servers/${serverId}/subusers/${subuserId}`, { permissions }),
  );
}

/**
 * Retire un accès. `sessionsNotClosed` vaut 1 quand le node n'a pas confirmé
 * la fermeture de la session SFTP de la personne : l'accès est retiré quand
 * même, l'écran le signale.
 */
export async function removeSubuser(
  serverId: string,
  subuserId: string,
): Promise<{ error: string | null; sessionsNotClosed: number }> {
  let sessionsNotClosed = 0;
  const result = await act(serverId, async () => {
    const { data } = await apiSendFor<{ data: { sessionClosed?: boolean } }>(
      `/api/v1/client/servers/${serverId}/subusers/${subuserId}`,
      undefined,
      "DELETE",
    );
    sessionsNotClosed = data.sessionClosed === false ? 1 : 0;
  });
  return { ...result, sessionsNotClosed };
}

async function act(serverId: string, call: () => Promise<void>): Promise<{ error: string | null }> {
  try {
    await call();
    revalidatePath(`/server/${serverId}/users`);
    return { error: null };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Opération refusée." };
  }
}

/** Invitation reçue, pas encore tranchée. */
export interface PendingInvitation {
  serverId: string;
  serverName: string;
  permissions: string[];
  invitedAt: string;
  /** Adresse de qui a invité. Vide si ce compte a été supprimé depuis. */
  invitedBy: string;
}

/**
 * Invitations en attente pour le compte connecté.
 *
 * L'échec rend une liste vide : c'est un supplément sur la page des serveurs,
 * et faire échouer celle-ci parce qu'on n'a pas pu lire les invitations serait
 * hors de proportion.
 */
export const fetchInvitations = async (): Promise<PendingInvitation[]> => {
  try {
    const { data } = await apiFetch<{ data: PendingInvitation[] }>("/api/v1/client/invitations");
    return data;
  } catch {
    return [];
  }
};

export async function acceptInvitation(serverId: string): Promise<{ error: string | null }> {
  return decide(serverId, "accept");
}

export async function declineInvitation(serverId: string): Promise<{ error: string | null }> {
  return decide(serverId, "decline");
}

async function decide(serverId: string, verb: string): Promise<{ error: string | null }> {
  try {
    await apiSend(`/api/v1/client/invitations/${serverId}/${verb}`, {});
    // La liste des serveurs change aussi : accepter en fait apparaître un.
    revalidatePath("/", "layout");
    return { error: null };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Opération refusée." };
  }
}
