"use server";

import { revalidatePath } from "next/cache";
import { apiFetch, apiSend } from "./client";

/** Un événement du catalogue, avec ce que le compte en a réglé. */
export interface NotificationPreference {
  type: string;
  group: string;
  channels: string[];
  /** Vrai quand le choix n'est pas offert : l'écran l'affiche verrouillé. */
  mandatory: boolean;
}

export interface NotificationPreferences {
  items: NotificationPreference[];
  /** Faux quand aucun SMTP n'est configuré : le courriel ne partira pas. */
  mailEnabled: boolean;
  /** Faux tant que l'adresse n'a pas été confirmée : rien ne lui sera écrit. */
  emailVerified: boolean;
  /** Faux quand le panel n'envoie pas de notifications à l'application mobile. */
  pushEnabled: boolean;
  /** Téléphones liés au compte qui les recevront. */
  pushDevices: number;
}

export async function fetchNotificationPreferences(): Promise<NotificationPreferences> {
  const { data, meta } = await apiFetch<{
    data: NotificationPreference[];
    meta: {
      mailEnabled: boolean;
      emailVerified: boolean;
      pushEnabled?: boolean;
      pushDevices?: number;
    };
  }>("/api/v1/client/notifications/preferences");

  return { items: data, pushEnabled: false, pushDevices: 0, ...meta };
}

export async function saveNotificationPreference(
  type: string,
  channels: string[],
): Promise<{ error: string | null }> {
  try {
    await apiSend("/api/v1/client/notifications/preferences", { type, channels });
    revalidatePath("/account");
    return { error: null };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Opération refusée." };
  }
}
