import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * La carte du sous-domaine est un bloc à l'intérieur de l'écran réseau
 * (revue N10) : sa lecture ne doit pas passer par `apiFetch`, qui renvoie
 * vers la connexion sur un refus. Un sous-utilisateur sans `allocations.read`
 * perdait sinon tout l'écran pour une carte qu'il n'a pas à voir.
 */

const client = vi.hoisted(() => ({
  apiFetch: vi.fn(async () => {
    throw new Error("NEXT_REDIRECT;/login");
  }),
  apiReadFor: vi.fn(),
  apiSend: vi.fn(),
}));
vi.mock("./client", () => client);
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const { getSubdomain } = await import("./network");

describe("getSubdomain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lit l'état du sous-domaine en lecture d'appoint", async () => {
    const etat = { available: true, domain: "jeux.exemple.fr", subdomain: null };
    client.apiReadFor.mockResolvedValueOnce({ data: etat });
    await expect(getSubdomain("srv")).resolves.toEqual(etat);
    expect(client.apiReadFor).toHaveBeenCalledWith("/api/v1/client/servers/srv/subdomain");
    expect(client.apiFetch).not.toHaveBeenCalled();
  });

  it("masque la carte sur un refus, sans quitter l'écran", async () => {
    client.apiReadFor.mockRejectedValueOnce(new Error("Permission manquante."));
    await expect(getSubdomain("srv")).resolves.toBeNull();
    expect(client.apiFetch).not.toHaveBeenCalled();
  });
});
