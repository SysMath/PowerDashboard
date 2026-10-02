import type { ClientNotificationView } from "@gamedashboard/contracts";
import { apiFetch } from "./client";

/**
 * Lecture des notifications.
 *
 * Sans `"use server"`, contrairement à `notifications-actions.ts` : cette
 * directive impose que **tout** export du module soit une fonction asynchrone,
 * ce qui exclut le type ci-dessous. Même découpage que pour l'administration —
 * les types et les lectures d'un côté, les actions de l'autre.
 */
export type Notification = ClientNotificationView;

export async function fetchNotifications(): Promise<Notification[]> {
  const { data } = await apiFetch<{ data: Notification[] }>("/api/v1/client/notifications");
  return data;
}
