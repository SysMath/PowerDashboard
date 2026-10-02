"use server";

import type { ClientPlayersView, PlayerAction } from "@gamedashboard/contracts";
import { revalidatePath } from "next/cache";
import { apiFetch, apiSend } from "./client";

/** Ce que l'API rend pour la page Joueurs (voir `ServerPlayersService.view`). */
export type PlayersView = ClientPlayersView;

export async function getPlayers(serverId: string): Promise<PlayersView> {
  const { data } = await apiFetch<{ data: PlayersView }>(
    `/api/v1/client/servers/${serverId}/players`,
  );
  return data;
}

/**
 * Une action de modération. Le panel écrit la commande à partir de l'egg :
 * l'écran ne choisit que l'action, le joueur et, au besoin, un motif.
 */
export async function actOnPlayer(
  serverId: string,
  input: { action: PlayerAction; player: string; reason?: string },
): Promise<{ error: string | null }> {
  try {
    await apiSend(`/api/v1/client/servers/${serverId}/players`, input);
    revalidatePath(`/server/${serverId}/players`);
    return { error: null };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Action refusée." };
  }
}
