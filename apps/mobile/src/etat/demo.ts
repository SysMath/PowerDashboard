import { GameDashboardClient } from "@gamedashboard/sdk";
import { ADRESSE_DEMO, creerApiDemo } from "@/noyau/demo/api";
import type { Langue } from "@/noyau/demo/donnees";
import type { InstanceOuverte } from "./instance";

/**
 * Le panel de démonstration (ADR 0010, lot 7) : les vrais écrans et le vrai
 * SDK, sur un panel fictif en mémoire. Pour les vérificateurs des magasins,
 * et pour qui veut voir l'application avant d'avoir un panel. Ni liaison, ni
 * clé, ni biométrie, ni notification : rien ne sort du téléphone.
 */
export const ID_DEMO = "demonstration";

export function ouvrirDemo(langue: string, nom: string): InstanceOuverte {
  const api = creerApiDemo((langue === "fr" ? "fr" : "en") satisfies Langue);
  return {
    instance: {
      id: ID_DEMO,
      adresse: ADRESSE_DEMO,
      instance: ID_DEMO,
      nom,
      origine: ADRESSE_DEMO,
      deviceId: ID_DEMO,
      deviceExpiresAt: null,
      lieeLe: new Date().toISOString(),
      etat: "liee",
    },
    session: { jeton: async () => ID_DEMO, delier: async () => undefined },
    client: new GameDashboardClient({ baseUrl: ADRESSE_DEMO, token: ID_DEMO, fetch: api.fetch }),
    descripteur: null,
    signaler: () => undefined,
    demo: true,
    webSocket: api.WebSocket,
  };
}
