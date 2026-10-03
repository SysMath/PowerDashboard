"use server";

import {
  type AppAuthorizeQuery,
  type AppDeviceSummary,
  appLinkCookieName,
} from "@gamedashboard/contracts";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { AUTH_COOKIE_OPTIONS } from "@/lib/session-cookie";
import { appLinkReturn, decodeAppLink } from "../app-link";
import { renderQr } from "../qr";
import { apiFetch, apiSend, apiSendFor } from "./client";
import { currentHost } from "./forwarded";

/** Appareils mobiles liés au compte (Compte › Sécurité). */
export async function listAppDevices(): Promise<AppDeviceSummary[]> {
  const { data } = await apiFetch<{ data: AppDeviceSummary[] }>("/api/v1/auth/devices");
  return data;
}

export async function revokeAppDevice(deviceId: string): Promise<{ error: string | null }> {
  try {
    await apiSend(`/api/v1/auth/devices/${encodeURIComponent(deviceId)}`, undefined, "DELETE");
    revalidatePath("/account/security");
    return { error: null };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Opération refusée." };
  }
}

/**
 * Le code QR que l'application scanne pour trouver ce panel.
 *
 * Il ne contient que l'adresse, sur le domaine où l'on se trouve — celui du
 * revendeur pour ses clients — et rien qui ouvre un accès : la connexion se
 * fait ensuite dans le navigateur du téléphone.
 */
export async function appLinkQr(): Promise<{ address: string; qrSvg: string } | null> {
  const host = await currentHost();
  if (!host) return null;
  const address = `https://${host}`;
  return { address, qrSvg: await renderQr(address) };
}

/** La demande de liaison en attente, si le cookie en porte une valide. */
export async function pendingAppLink(): Promise<AppAuthorizeQuery | null> {
  return decodeAppLink((await cookies()).get(appLinkCookieName(process.env))?.value);
}

/**
 * Réponse de la personne à « Autoriser l'application ? ».
 *
 * Rend l'adresse `gamedashboard://` vers laquelle la page renvoie le
 * téléphone : avec le code si elle accepte, avec le refus sinon. Le cookie
 * tombe dans les deux cas — une demande ne se rejoue pas.
 */
export async function answerAppLink(
  approved: boolean,
): Promise<{ redirect: string | null; error: string | null }> {
  const store = await cookies();
  const query = decodeAppLink(store.get(appLinkCookieName(process.env))?.value);
  store.set(appLinkCookieName(process.env), "", { ...AUTH_COOKIE_OPTIONS, maxAge: 0 });
  if (!query) return { redirect: null, error: "expired" };
  if (!approved) return { redirect: appLinkReturn(query, { error: "access_denied" }), error: null };

  try {
    const { data } = await apiSendFor<{ data: { code: string } }>("/api/v1/auth/app/authorize", {
      codeChallenge: query.code_challenge,
      deviceName: query.device_name,
      platform: query.platform,
    });
    return { redirect: appLinkReturn(query, { code: data.code }), error: null };
  } catch (error) {
    return {
      redirect: appLinkReturn(query, { error: "server_error" }),
      error: error instanceof Error ? error.message : "Opération refusée.",
    };
  }
}
