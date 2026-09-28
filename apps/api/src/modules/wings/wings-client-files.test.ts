import type { Database } from "@gamedashboard/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WingsClientService, WingsUnavailableError } from "./wings-client.service";

/**
 * La forme exacte de ce que le panel envoie au daemon pour les fichiers.
 *
 * Wings n'est pas modifié : une clé mal nommée ou un nombre à la place d'une
 * chaîne ne produit aucune erreur ici, seulement un refus chez le daemon — ou
 * pire, un 204 qui n'a rien fait. Ces tests figent donc le corps et la route,
 * relevés dans `router/router.go` et `router/router_server_files.go`.
 */

const SERVEUR = "8cddb6da-0d02-4d29-9a64-a7dce45922e0";

function client() {
  const service = new WingsClientService({} as Database);
  // Les coordonnées viennent de la base et d'un jeton chiffré : sans rapport
  // avec ce qui est vérifié ici, elles sont fournies telles quelles.
  vi.spyOn(
    service as unknown as { endpointFor: () => Promise<unknown> },
    "endpointFor",
  ).mockResolvedValue({ baseUrl: "https://node.test:8080", token: "jeton", nodeName: "N1" });
  return service;
}

function fetchRepondant(status: number, corps = "") {
  const appel = vi.fn(async () => new Response(corps === "" ? null : corps, { status }));
  vi.stubGlobal("fetch", appel);
  return appel;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("relais chmod vers Wings", () => {
  it("poste sur files/chmod le corps attendu par le daemon", async () => {
    const appel = fetchRepondant(204);
    await client().chmodFiles(SERVEUR, "/plugins", [{ file: "start.sh", mode: "755" }]);

    expect(appel).toHaveBeenCalledTimes(1);
    const [url, init] = appel.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://node.test:8080/api/servers/${SERVEUR}/files/chmod`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      root: "/plugins",
      files: [{ file: "start.sh", mode: "755" }],
    });
  });

  it("envoie le mode en chaîne, jamais en nombre", async () => {
    // `chmodFile.Mode` est un `string` que Wings passe à `ParseUint(…, 8, 32)`.
    const appel = fetchRepondant(204);
    await client().chmodFiles(SERVEUR, "/", [{ file: "a", mode: "644" }]);
    const [, init] = appel.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(init.body)).toContain('"mode":"644"');
  });

  it("ne laisse passer aucun champ en plus", async () => {
    const appel = fetchRepondant(204);
    const entree = { file: "a", mode: "644", recursive: true } as { file: string; mode: string };
    await client().chmodFiles(SERVEUR, "/", [entree]);
    const [, init] = appel.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).files).toEqual([{ file: "a", mode: "644" }]);
  });

  it("rend le refus du daemon lisible", async () => {
    fetchRepondant(400, JSON.stringify({ error: "Invalid file mode." }));
    const erreur = await client()
      .chmodFiles(SERVEUR, "/", [{ file: "a", mode: "999" }])
      .catch((e: unknown) => e);
    expect(erreur).toBeInstanceOf(WingsUnavailableError);
    expect((erreur as WingsUnavailableError).isRefusal).toBe(true);
    expect((erreur as WingsUnavailableError).detail).toBe("Invalid file mode.");
  });
});

describe("relais du renommage vers Wings", () => {
  it("passe en PUT sur files/rename avec une liste from/to", async () => {
    const appel = fetchRepondant(204);
    await client().renameFile(SERVEUR, "/", "a.txt", "archives/a.txt");
    const [url, init] = appel.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://node.test:8080/api/servers/${SERVEUR}/files/rename`);
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({
      root: "/",
      files: [{ from: "a.txt", to: "archives/a.txt" }],
    });
  });
});

/*
 * `POST /api/deauthorize-user` (`router/router_system.go`, Wings 1.13.3) :
 * `{ user, servers }`. Une liste de serveurs vide déconnecterait le compte de
 * tout le node : elle ne doit jamais partir vide.
 */
describe("déconnexion d'un compte chez Wings", () => {
  const COMPTE = "0b6f1c8e-2d1a-4f7e-9a51-3c2b7d9e4f10";

  it("poste le compte et ce seul serveur sur deauthorize-user", async () => {
    const appel = fetchRepondant(204);
    await client().deauthorizeUser(SERVEUR, COMPTE);

    expect(appel).toHaveBeenCalledTimes(1);
    const [url, init] = appel.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://node.test:8080/api/deauthorize-user");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ user: COMPTE, servers: [SERVEUR] });
  });

  it("signale un node qui ne répond pas, pour que l'appelant le consigne", async () => {
    fetchRepondant(502);
    await expect(client().deauthorizeUser(SERVEUR, COMPTE)).rejects.toBeInstanceOf(
      WingsUnavailableError,
    );
  });
});
