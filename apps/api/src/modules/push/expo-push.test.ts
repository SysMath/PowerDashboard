import { describe, expect, it, vi } from "vitest";
import { type EnvoiExpo, EXPO_PUSH_URL, envoyerExpo } from "./expo-push";

const envoi = (to: string): EnvoiExpo => ({
  to,
  title: "Survie",
  body: "Serveur injoignable",
  data: {
    instance: "6f1d1c8e-8a43-4d0f-9d0e-2f1f3a5b7c9d",
    notification: "0b9b8f2e-4d6c-4b1e-9a51-2f3d1c0e7a11",
    type: "server.unreachable",
  },
});

const repondre = (corps: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(corps), { status }));

describe("envoi à Expo Push", () => {
  it("envoie avec le jeton d'accès de l'éditeur et rend une issue par envoi", async () => {
    const appel = repondre({
      data: [
        { status: "ok", id: "a" },
        { status: "error", details: { error: "DeviceNotRegistered" } },
        { status: "error", details: { error: "MessageRateExceeded" } },
      ],
    });
    const issues = await envoyerExpo(
      [envoi("ExponentPushToken[a]"), envoi("ExponentPushToken[b]"), envoi("ExponentPushToken[c]")],
      "jeton-editeur",
      appel as unknown as typeof fetch,
    );
    expect(issues).toEqual(["envoyee", "inconnue", "reessayer"]);
    const [url, init] = appel.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(EXPO_PUSH_URL);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer jeton-editeur");
  });

  it("reprend tout le lot quand Expo ne répond pas ou refuse la requête", async () => {
    const lot = [envoi("ExponentPushToken[a]")];
    expect(await envoyerExpo(lot, "j", repondre({}, 503) as unknown as typeof fetch)).toEqual([
      "reessayer",
    ]);
    const panne = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await envoyerExpo(lot, "j", panne as unknown as typeof fetch)).toEqual(["reessayer"]);
  });
});
