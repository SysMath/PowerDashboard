import type { PushOutcome } from "@gamedashboard/contracts";

/** Le service d'envoi d'Expo Push (ADR 0010). */
export const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

/** Au-delà, l'envoi est repris au tour suivant : un tour ne reste pas suspendu. */
const DELAI_MS = 15_000;

export interface EnvoiExpo {
  to: string;
  title: string;
  body: string;
  /**
   * Lu par l'application au toucher : quelle notification ouvrir, et chez
   * quel panel. Le jeton Expo d'un téléphone est le même pour tous ses
   * panels : sans l'instance, il ne saurait pas lequel ouvrir.
   */
  data: { instance: string; notification: string; type: string };
}

interface TicketExpo {
  status?: string;
  details?: { error?: string };
}

/**
 * Envoie un lot à Expo, avec le jeton d'accès de l'éditeur (« sécurité
 * renforcée » : sans lui, un jeton d'appareil ne sert à rien), et rend une
 * issue par envoi, dans l'ordre.
 *
 * `inconnue` seulement quand Expo dit l'appareil désinscrit
 * (`DeviceNotRegistered`) : c'est le seul refus définitif. Le reste se
 * reprend, dans la limite des essais de l'appelant.
 */
export async function envoyerExpo(
  envois: readonly EnvoiExpo[],
  jeton: string,
  appel: typeof fetch = fetch,
): Promise<PushOutcome[]> {
  if (envois.length === 0) return [];
  const reessayer = envois.map((): PushOutcome => "reessayer");
  let reponse: Response;
  try {
    reponse = await appel(EXPO_PUSH_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${jeton}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(
        envois.map((envoi) => ({ ...envoi, sound: "default", priority: "high" })),
      ),
      signal: AbortSignal.timeout(DELAI_MS),
    });
  } catch {
    return reessayer;
  }
  if (!reponse.ok) return reessayer;
  const corps = (await reponse.json().catch(() => null)) as { data?: unknown } | null;
  const tickets = Array.isArray(corps?.data) ? (corps.data as TicketExpo[]) : [];
  return envois.map((_, rang): PushOutcome => {
    const ticket = tickets[rang];
    if (ticket?.status === "ok") return "envoyee";
    return ticket?.details?.error === "DeviceNotRegistered" ? "inconnue" : "reessayer";
  });
}
