import { type PushMode, pushMode, pushRelayUrl } from "@gamedashboard/contracts";

/**
 * Réglages des notifications poussées, lus dans l'environnement à chaque
 * appel (`env/api.env`), jamais en base : le jeton Expo est celui de
 * l'éditeur et ne se saisit pas dans un écran.
 */
export interface PushConfig {
  mode: PushMode;
  /** Jeton d'accès Expo : mode `direct`, et le relais lui-même. */
  expoAccessToken: string | null;
  relayUrl: string | null;
  /** Ce panel sert aussi de relais aux autres (`PUSH_RELAY=1`). */
  relay: boolean;
}

export function pushConfig(env: NodeJS.ProcessEnv = process.env): PushConfig {
  return {
    mode: pushMode(env),
    expoAccessToken: env.EXPO_ACCESS_TOKEN?.trim() || null,
    relayUrl: pushRelayUrl(env),
    relay: env.PUSH_RELAY === "1",
  };
}
