import { describe, expect, it } from "vitest";
import { coffreMemoire, hasardNode } from "./essais/outils-node";
import { Registre } from "./instances";

const panel = (instance: string, nom = "Panel A") => ({
  instance,
  nom,
  origine: "https://a.example",
  version: null,
  notifications: "aucune" as const,
  relais: null,
});

describe("Registre", () => {
  it("range chaque panel à part, avec son propre secret", async () => {
    const registre = new Registre(coffreMemoire(), hasardNode);
    const a = await registre.preparer("https://a.example", panel("inst-a-0001"));
    const b = await registre.preparer("https://b.example", panel("inst-b-0001", "Panel B"));
    await registre.ecrireSecret(a.id, "gd_dev_a");
    await registre.ecrireSecret(b.id, "gd_dev_b");
    expect(a.id).not.toBe(b.id);
    expect(await registre.lireSecret(a.id)).toBe("gd_dev_a");
    await registre.retirer(a.id);
    expect(await registre.lireSecret(a.id)).toBeNull();
    expect(await registre.lireSecret(b.id)).toBe("gd_dev_b");
    expect((await registre.lister()).map((i) => i.nom)).toEqual(["Panel B"]);
  });

  it("garde l'identifiant local d'une adresse qu'on relie de nouveau", async () => {
    const registre = new Registre(coffreMemoire(), hasardNode);
    const premiere = await registre.preparer("https://a.example", panel("inst-a-0001"));
    const seconde = await registre.preparer("https://a.example", panel("inst-a-0001"));
    expect(seconde.id).toBe(premiere.id);
    expect(await registre.lister()).toHaveLength(1);
  });

  it("suspend un panel qui répond avec un autre identifiant d'instance", async () => {
    // Réinstallé, ou le domaine a changé de mains : rien ne part vers lui
    // avant que l'utilisateur ait confirmé.
    const registre = new Registre(coffreMemoire(), hasardNode);
    const a = await registre.preparer("https://a.example", panel("inst-a-0001"));
    await registre.enregistrer({ ...a, etat: "liee", deviceId: "d1" });
    await registre.ecrireSecret(a.id, "gd_dev_a");

    const meme = await registre.verifierIdentite(a.id, panel("inst-a-0001", "Nouveau nom"));
    expect(meme?.etat).toBe("liee");
    expect(meme?.nom).toBe("Nouveau nom");

    const autre = await registre.verifierIdentite(a.id, panel("inst-z-9999"));
    expect(autre?.etat).toBe("a-confirmer");
    expect(autre?.instance).toBe("inst-a-0001");

    // Confirmer repart du navigateur : l'appareil de l'ancien panel n'existe
    // pas chez le nouveau.
    await registre.accepterNouvelleIdentite(a.id, panel("inst-z-9999"));
    const relie = await registre.trouver(a.id);
    expect(relie?.etat).toBe("a-relier");
    expect(relie?.instance).toBe("inst-z-9999");
    expect(await registre.lireSecret(a.id)).toBeNull();
  });

  it("survit à une liste illisible dans le trousseau", async () => {
    const coffre = coffreMemoire();
    coffre.valeurs.set("gd.instances", "{pas du json");
    expect(await new Registre(coffre, hasardNode).lister()).toEqual([]);
  });
});
