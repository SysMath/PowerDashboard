import { vi } from "vitest";
import type { SubdomainsService } from "../modules/dns/subdomains.service";

/**
 * Un service de sous-domaines qui ne publie rien, pour les tests dont ce
 * n'est pas le sujet : le port principal, le transfert et la suppression le
 * préviennent sans l'attendre. Ses deux méthodes sont des espions, pour
 * vérifier qu'il est bien prévenu.
 */
export function sousDomainesInertes() {
  const espion = {
    refresh: vi.fn(async (_serverId: string) => undefined),
    sweepSoon: vi.fn(async () => undefined),
    departing: vi.fn(async (_db: unknown, _serverId: string) => undefined),
  };
  return espion as typeof espion & SubdomainsService;
}
