"use server";

import { revalidatePath } from "next/cache";
import { apiSendFor } from "./client";

/**
 * Les gestes d'un revendeur sur son parc.
 *
 * Suspendre un impayé, le rétablir à la régularisation, rendre un serveur
 * résilié : jusqu'ici, ces trois-là n'existaient que pour sa **boutique**, par
 * clé applicative. Un revendeur sans boutique — celui qui prend une enveloppe
 * et sert quelques clients à la main — pouvait tout voir de son parc et n'y
 * rien faire.
 *
 * Aucune de ces fonctions ne prend d'identifiant de revendeur : le périmètre
 * vient de la session, et l'API refuse « introuvable » pour le serveur d'un
 * confrère.
 */

export async function setResellerServerSuspended(
  serverId: string,
  suspended: boolean,
  reason?: string,
): Promise<{ error: string | null; sessionsNotClosed: number }> {
  try {
    const { data } = await apiSendFor<{ data: { sessionsNotClosed?: number } }>(
      `/api/v1/reseller/servers/${serverId}/suspension`,
      { suspended, reason },
    );
    // Le parc et la vue d'ensemble montrent le même état : c'est l'espace
    // entier qui est périmé, pas une seule page.
    revalidatePath("/reseller", "layout");
    // Comptes dont le node n'a pas confirmé la fermeture des sessions : la
    // suspension est faite quand même, l'écran le signale.
    return { error: null, sessionsNotClosed: data.sessionsNotClosed ?? 0 };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Opération refusée.",
      sessionsNotClosed: 0,
    };
  }
}

/**
 * Supprime un serveur du parc.
 *
 * Irréversible, et l'écran le dit avant : le daemon efface le volume. L'API
 * refuse si la machine ne répond pas — supprimer la ligne laisserait sinon un
 * conteneur tourner sans que rien ne le rattache plus à personne.
 */
export async function deleteResellerServer(serverId: string): Promise<{ error: string | null }> {
  try {
    await apiSendFor(`/api/v1/reseller/servers/${serverId}`, undefined, "DELETE");
    revalidatePath("/reseller", "layout");
    return { error: null };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Suppression refusée." };
  }
}

/**
 * Change les limites d'un serveur du parc — la montée en gamme.
 *
 * Le geste que rien ne permettait : un serveur naissait avec son offre et la
 * gardait. Pour vendre plus de mémoire à un client, il fallait supprimer son
 * serveur et le recréer, donc lui faire perdre son monde.
 *
 * Les sept quantités de l'offre. L'écran n'en proposait que deux — mémoire et
 * disque — parce que sa liste ne transportait que celles-là ; un revendeur
 * devait passer par l'API ou demander à la plateforme pour toucher au reste,
 * alors que fixer une offre est son métier.
 */
export async function setResellerServerLimits(
  serverId: string,
  limits: {
    memoryMb?: number;
    diskMb?: number;
    cpuPct?: number;
    swapMb?: number;
    backups?: number;
    databases?: number;
    allocations?: number;
  },
): Promise<{ error: string | null }> {
  try {
    await apiSendFor(`/api/v1/reseller/servers/${serverId}/limits`, limits);
    revalidatePath("/reseller", "layout");
    return { error: null };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Changement refusé." };
  }
}
