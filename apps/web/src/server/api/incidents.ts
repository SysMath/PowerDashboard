"use server";

import type { AdminIncident, IncidentImpact, IncidentState } from "@gamedashboard/contracts";
import { revalidatePath } from "next/cache";
import { apiFetch, apiSendFor } from "./client";

export type { AdminIncident, AdminIncidentUpdate } from "@gamedashboard/contracts";

export async function fetchIncidents(): Promise<AdminIncident[]> {
  const { data } = await apiFetch<{ data: AdminIncident[] }>("/api/v1/admin/incidents");
  return data;
}

/**
 * Ouvre un incident — donc le publie.
 *
 * Il n'y a pas de brouillon : ce qui est créé est immédiatement lisible sur la
 * page publique. Un état intermédiaire « rédigé mais non publié » serait le
 * meilleur moyen d'oublier de publier au moment où cela compte.
 */
export async function openIncident(input: {
  title: string;
  impact: IncidentImpact;
  nodeIds: string[];
  body: string;
}): Promise<{ error: string | null }> {
  try {
    await apiSendFor("/api/v1/admin/incidents", input);
    revalidatePath("/admin/incidents");
    // La page publique est servie sans cache côté Next, mais l'invalider ici
    // évite de dépendre de ce détail.
    revalidatePath("/status");
    return { error: null };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Publication refusée." };
  }
}

export async function postIncidentUpdate(
  incidentId: string,
  input: { state: IncidentState; body: string },
): Promise<{ error: string | null }> {
  try {
    await apiSendFor(`/api/v1/admin/incidents/${incidentId}/updates`, input);
    revalidatePath("/admin/incidents");
    revalidatePath("/status");
    return { error: null };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Publication refusée." };
  }
}
