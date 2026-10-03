import { describe, expect, it, vi } from "vitest";
import type { Descripteur } from "./descripteur";
import { coffreMemoire, reponse } from "./essais/outils-node";
import type { InstanceLiee } from "./instances";
import { cibleToucher, inscrirePousse, lireRelaisConnus, POUSSE_RAFRAICHIR_MS } from "./pousse";

const JETON = "ExponentPushToken[abcdefghijklmnop]";
const POIGNEE = "p".repeat(43);
const RELAIS = "https://relais.example.org";

const instance: InstanceLiee = {
  id: "loc-1",
  adresse: "https://panel.example.com",
  instance: "6f1d1c8e-8a43-4d0f-9d0e-2f1f3a5b7c9d",
  nom: "Panel",
  origine: "https://panel.example.com",
  deviceId: "dev-1",
  deviceExpiresAt: null,
  lieeLe: new Date(0).toISOString(),
  etat: "liee",
};

const descripteur = (
  notifications: Descripteur["notifications"],
  relais: string | null = null,
) => ({
  instance: instance.instance,
  nom: "Panel",
  origine: instance.origine,
  version: null,
  notifications,
  relais,
});

function banc(options: { relaisConnus?: string[]; reponses?: (url: string) => Response } = {}) {
  const coffre = coffreMemoire();
  const horloge = { t: 1_000_000, maintenant: () => horloge.t };
  const fetch = vi.fn(async (url: string | URL | Request, _init?: RequestInit) =>
    options.reponses ? options.reponses(String(url)) : new Response(null, { status: 204 }),
  );
  const deps = {
    fetch: fetch as unknown as typeof globalThis.fetch,
    coffre,
    horloge,
    relaisConnus: options.relaisConnus ?? [RELAIS],
  };
  const jetonAcces = async () => "acces";
  const appels = () =>
    fetch.mock.calls.map(([url, init]) => ({
      url: String(url),
      method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    }));
  return { deps, horloge, coffre, fetch, jetonAcces, appels };
}

describe("inscrirePousse", () => {
  it("donne au panel en mode direct le jeton Expo, une fois", async () => {
    const b = banc();
    const entree = {
      instance,
      descripteur: descripteur("direct"),
      jetonExpo: JETON,
      jetonAcces: b.jetonAcces,
    };
    expect(await inscrirePousse(b.deps, entree)).toBe("inscrite");
    expect(b.appels()).toEqual([
      {
        url: "https://panel.example.com/api/v1/auth/app/push",
        method: "PUT",
        body: { mode: "direct", poignee: JETON },
      },
    ]);
    // Inchangé : rien ne repart, jusqu'au rafraîchissement.
    expect(await inscrirePousse(b.deps, entree)).toBe("deja");
    b.horloge.t += POUSSE_RAFRAICHIR_MS;
    expect(await inscrirePousse(b.deps, entree)).toBe("inscrite");
    expect(b.fetch).toHaveBeenCalledTimes(2);
  });

  it("passe par le relais connu, et ne donne au panel que la poignée", async () => {
    const b = banc({
      reponses: (url) =>
        new URL(url).origin === RELAIS
          ? reponse({ data: { poignee: POIGNEE } })
          : new Response(null, { status: 204 }),
    });
    const issue = await inscrirePousse(b.deps, {
      instance,
      descripteur: descripteur("relais", RELAIS),
      jetonExpo: JETON,
      jetonAcces: b.jetonAcces,
    });
    expect(issue).toBe("inscrite");
    expect(b.appels()).toEqual([
      {
        url: `${RELAIS}/api/v1/relais/poignees`,
        method: "POST",
        body: { instance: instance.instance, jeton: JETON },
      },
      {
        url: "https://panel.example.com/api/v1/auth/app/push",
        method: "PUT",
        body: { mode: "relais", poignee: POIGNEE },
      },
    ]);
    expect(JSON.stringify(b.appels()[1])).not.toContain(JETON);
  });

  it("ne porte jamais le jeton Expo chez un relais inconnu de l'application", async () => {
    const b = banc({ relaisConnus: [RELAIS] });
    const issue = await inscrirePousse(b.deps, {
      instance,
      descripteur: descripteur("relais", "https://ailleurs.example.net"),
      jetonExpo: JETON,
      jetonAcces: b.jetonAcces,
    });
    expect(issue).toBe("relais-inconnu");
    expect(b.fetch).not.toHaveBeenCalled();
  });

  it("retire ce qu'il avait déposé quand le panel cesse de pousser ou la permission tombe", async () => {
    const b = banc();
    const base = { instance, jetonAcces: b.jetonAcces };
    await inscrirePousse(b.deps, { ...base, descripteur: descripteur("direct"), jetonExpo: JETON });
    expect(
      await inscrirePousse(b.deps, {
        ...base,
        descripteur: descripteur("direct"),
        jetonExpo: null,
      }),
    ).toBe("aucune");
    expect(b.appels()[1]).toMatchObject({
      method: "DELETE",
      url: "https://panel.example.com/api/v1/auth/app/push",
    });
    // Plus rien à retirer ensuite.
    await inscrirePousse(b.deps, { ...base, descripteur: descripteur("aucune"), jetonExpo: JETON });
    expect(b.fetch).toHaveBeenCalledTimes(2);
  });

  it("réinscrit après une nouvelle liaison, même jeton Expo", async () => {
    // Le panel efface la poignée d'un appareil retiré : le nouvel appareil
    // doit redéposer la sienne.
    const b = banc();
    const base = { descripteur: descripteur("direct"), jetonExpo: JETON, jetonAcces: b.jetonAcces };
    await inscrirePousse(b.deps, { ...base, instance });
    expect(
      await inscrirePousse(b.deps, { ...base, instance: { ...instance, deviceId: "dev-2" } }),
    ).toBe("inscrite");
  });

  it("retentera après un refus, sans rien retenir", async () => {
    const b = banc({ reponses: () => reponse({ message: "Mode différent." }, 409) });
    const entree = {
      instance,
      descripteur: descripteur("direct"),
      jetonExpo: JETON,
      jetonAcces: b.jetonAcces,
    };
    expect(await inscrirePousse(b.deps, entree)).toBe("refusee");
    expect(b.coffre.valeurs.size).toBe(0);
  });
});

describe("lireRelaisConnus", () => {
  it("ne garde que des origines https", () => {
    expect(
      lireRelaisConnus(
        " https://relais.example.org/ , http://non.example, pas une adresse,https://relais.example.org",
      ),
    ).toEqual([RELAIS]);
    expect(lireRelaisConnus(undefined)).toEqual([]);
  });
});

describe("cibleToucher", () => {
  it("ouvre le panel lié qui a envoyé la notification, et nul autre", () => {
    const donnees = {
      instance: instance.instance,
      notification: "n-1",
      type: "server.unreachable",
    };
    expect(cibleToucher(donnees, [instance])).toEqual({ instanceId: "loc-1", notification: "n-1" });
    expect(cibleToucher(donnees, [{ ...instance, etat: "a-confirmer" }])).toBeNull();
    expect(cibleToucher({ notification: "n-1" }, [instance])).toBeNull();
    expect(cibleToucher(null, [instance])).toBeNull();
  });
});
