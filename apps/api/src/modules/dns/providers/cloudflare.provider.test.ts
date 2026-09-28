import { describe, expect, it } from "vitest";
import { cloudflareSimule } from "../../../test/cloudflare-simule";
import { DnsRefusal } from "../dns-provider";
import { CloudflareProvider } from "./cloudflare.provider";

/** Le protocole de Cloudflare, contre l'API simulée : ce qui part, et ce qu'on lit. */
function monter() {
  const sim = cloudflareSimule("exemple.fr");
  const provider = new CloudflareProvider(sim.fetch);
  return { sim, provider, connection: { zoneId: sim.zoneId, apiToken: sim.jeton } };
}

describe("CloudflareProvider", () => {
  it("lit le nom de la zone", async () => {
    const { provider, connection } = monter();
    await expect(provider.zoneName(connection)).resolves.toBe("exemple.fr");
  });

  it("rend la phrase de Cloudflare quand le jeton est refusé", async () => {
    const { provider, connection } = monter();
    const refus = provider.zoneName({ ...connection, apiToken: "mauvais" });
    await expect(refus).rejects.toBeInstanceOf(DnsRefusal);
    await expect(refus).rejects.toThrow("Authentication error");
  });

  it("refuse un identifiant de zone qui n'en est pas un, sans rien envoyer", async () => {
    const { sim, provider, connection } = monter();
    await expect(provider.zoneName({ ...connection, zoneId: "../accounts" })).rejects.toThrow(
      "32 caractères",
    );
    expect(sim.appels).toHaveLength(0);
  });

  it("crée un enregistrement A jamais relayé, avec sa note et une durée courte", async () => {
    const { sim, provider, connection } = monter();
    const record = await provider.create(
      connection,
      { type: "A", name: "survie.jeux.exemple.fr", content: "203.0.113.7" },
      "GameDashboard, serveur 42",
    );
    expect(record).toMatchObject({ type: "A", content: "203.0.113.7" });
    expect(sim.appels.at(-1)?.body).toEqual({
      type: "A",
      name: "survie.jeux.exemple.fr",
      content: "203.0.113.7",
      proxied: false,
      ttl: 60,
      comment: "GameDashboard, serveur 42",
    });
  });

  it("crée un SRV avec son port et sa cible dans `data`", async () => {
    const { sim, provider, connection } = monter();
    await provider.create(
      connection,
      {
        type: "SRV",
        name: "_minecraft._tcp.survie.jeux.exemple.fr",
        target: "survie.jeux.exemple.fr",
        port: 25_570,
      },
      "note",
    );
    expect(sim.appels.at(-1)?.body).toMatchObject({
      type: "SRV",
      name: "_minecraft._tcp.survie.jeux.exemple.fr",
      data: { priority: 0, weight: 5, port: 25_570, target: "survie.jeux.exemple.fr" },
    });
  });

  it("retire un enregistrement, et tolère qu'il ait déjà disparu", async () => {
    const { sim, provider, connection } = monter();
    const { id } = await provider.create(
      connection,
      { type: "A", name: "a.exemple.fr", content: "203.0.113.7" },
      "note",
    );
    await provider.remove(connection, id);
    expect(sim.enregistrements.size).toBe(0);
    await expect(provider.remove(connection, id)).resolves.toBeUndefined();
  });

  it("liste les enregistrements d'un nom exact, quel qu'en soit le type", async () => {
    const { sim, provider, connection } = monter();
    sim.poser({ type: "CNAME", name: "www.exemple.fr", content: "exemple.fr" });
    sim.poser({ type: "A", name: "autre.exemple.fr", content: "203.0.113.9" });
    const found = await provider.recordsNamed(connection, "www.exemple.fr");
    expect(found.map((r) => r.type)).toEqual(["CNAME"]);
  });

  it("dit qu'une panne est une panne, pas un refus de la demande", async () => {
    const { sim, provider, connection } = monter();
    sim.panne = true;
    await expect(provider.zoneName(connection)).rejects.toThrow("ne répond pas (503)");
  });
});
