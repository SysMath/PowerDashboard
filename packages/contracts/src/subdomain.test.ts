import { describe, expect, it } from "vitest";
import {
  desiredRecords,
  domainWithinZone,
  normalizeDnsDomain,
  reservedLabels,
  sameRecord,
  subdomainLabelProblem,
} from "./subdomain";

describe("subdomainLabelProblem", () => {
  const reserved = reservedLabels("boutique, Discord\nforum");

  it("accepte un libellé simple", () => {
    expect(subdomainLabelProblem("survie-2", reserved)).toBeNull();
  });

  it.each([
    ["ab", "length"],
    ["a".repeat(64), "length"],
    ["-survie", "characters"],
    ["survie-", "characters"],
    ["sur.vie", "characters"],
    ["Survie", "characters"],
    ["créatif", "characters"],
    ["xn--pypal-4ve", "punycode"],
    ["ab--cd", "punycode"],
    ["www", "reserved"],
    ["panel", "reserved"],
    ["discord", "reserved"],
    ["forum", "reserved"],
  ])("refuse « %s » (%s)", (label, problem) => {
    expect(subdomainLabelProblem(label, reserved)).toBe(problem);
  });
});

describe("normalizeDnsDomain", () => {
  it("ramène un domaine à sa forme canonique", () => {
    expect(normalizeDnsDomain(" Jeux.Exemple.FR. ")).toBe("jeux.exemple.fr");
  });

  it.each(["", "exemple", "jeux..exemple.fr", "https://exemple.fr", "-a.exemple.fr"])(
    "refuse « %s »",
    (raw) => {
      expect(normalizeDnsDomain(raw)).toBeNull();
    },
  );
});

describe("domainWithinZone", () => {
  it("admet la zone et ses sous-domaines, pas un voisin qui finit pareil", () => {
    expect(domainWithinZone("exemple.fr", "exemple.fr")).toBe(true);
    expect(domainWithinZone("jeux.exemple.fr", "exemple.fr")).toBe(true);
    expect(domainWithinZone("autreexemple.fr", "exemple.fr")).toBe(false);
  });
});

describe("desiredRecords", () => {
  const fqdn = "survie.jeux.exemple.fr";

  it("publie un A seul pour un jeu qui ne lit pas le SRV", () => {
    expect(
      desiredRecords({ fqdn, host: "203.0.113.7", hostKind: "ipv4", port: 27_015, srv: false }),
    ).toEqual([{ type: "A", name: fqdn, content: "203.0.113.7" }]);
  });

  it("publie un AAAA pour une adresse IPv6", () => {
    expect(
      desiredRecords({ fqdn, host: "2001:db8::7", hostKind: "ipv6", port: 1, srv: false })[0],
    ).toMatchObject({ type: "AAAA", content: "2001:db8::7" });
  });

  it("ajoute un SRV Minecraft qui vise le nom lui-même", () => {
    const records = desiredRecords({
      fqdn,
      host: "203.0.113.7",
      hostKind: "ipv4",
      port: 25_570,
      srv: true,
    });
    expect(records[1]).toEqual({
      type: "SRV",
      name: `_minecraft._tcp.${fqdn}`,
      target: fqdn,
      port: 25_570,
    });
  });

  it("vise directement l'hôte en CNAME : un SRV ne doit pas viser un alias", () => {
    const records = desiredRecords({
      fqdn,
      host: "Node1.Exemple.fr.",
      hostKind: "name",
      port: 25_565,
      srv: true,
    });
    expect(records[0]).toEqual({ type: "CNAME", name: fqdn, content: "node1.exemple.fr" });
    expect(records[1]).toMatchObject({ type: "SRV", target: "node1.exemple.fr" });
  });
});

describe("sameRecord", () => {
  it("distingue un changement de port d'un SRV", () => {
    const a = { type: "SRV", name: "n", target: "t", port: 1 } as const;
    expect(sameRecord(a, { ...a })).toBe(true);
    expect(sameRecord(a, { ...a, port: 2 })).toBe(false);
  });
});
