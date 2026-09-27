import { describe, expect, it } from "vitest";
import { assertPublicDestination, isPrivateAddress, PrivateDestinationError } from "./public-url";

/**
 * Les adresses internes, sous toutes leurs écritures.
 *
 * Le défaut (revue des sous-domaines, V2-C2) : l'adresse était comparée comme
 * du texte. `::ffff:7f00:1` — la forme que `URL` donne de `::ffff:127.0.0.1` —
 * ou `0:0:0:0:0:0:0:1` passaient pour publiques : les rappels sortants
 * atteignaient la boucle locale et le service de métadonnées, et les
 * sous-domaines publiaient l'adressage interne.
 */
describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.5",
    "172.16.0.1",
    "192.168.1.4",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "192.0.0.8",
    "192.88.99.1",
    "198.18.0.1",
    "198.19.255.254",
    "2002:7f00:1::",
    "2002:a9fe:a9fe::1",
    "2001:0:4136:e378:8000:63bf:3fff:fdd2",
    "::",
    "::1",
    "0:0:0:0:0:0:0:1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:a00:5",
    "::FFFF:A9FE:A9FE",
    "0:0:0:0:0:ffff:10.0.0.5",
    "::ffff:0:10.0.0.5",
    "::10.0.0.5",
    "64:ff9b::a00:5",
    "64:ff9b::10.0.0.5",
    "64:ff9b:1::1",
    "100::1",
    "fc00::1",
    "FD12:3456::1",
    "fe80::1",
    "fe80::1%eth0",
    "fec0::1",
    "ff02::1",
    "[::1]",
    // Illisibles : refusées plutôt qu'admises.
    "",
    "localhost",
    "1:2:3:4:5:6:7:8:9",
    "1::2::3",
    "::ffff:300.0.0.1",
  ])("refuse %s", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each([
    "203.0.113.10",
    "8.8.8.8",
    "2001:db8::1",
    "2606:4700:4700::1111",
    "::ffff:808:808",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808",
    "2002:808:808::1",
    "198.20.0.1",
    "192.0.2.1",
  ])("admet %s", (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });
});

describe("assertPublicDestination", () => {
  it.each([
    "http://[::ffff:127.0.0.1]:3201/",
    "http://[::ffff:a9fe:a9fe]/",
    "http://[0:0:0:0:0:0:0:1]/",
    "http://[64:ff9b::7f00:1]/",
    "http://[ff02::1]/",
  ])("refuse le rappel %s", async (url) => {
    await expect(assertPublicDestination(new URL(url))).rejects.toBeInstanceOf(
      PrivateDestinationError,
    );
  });

  it("admet une adresse publique écrite en IPv6", async () => {
    await expect(
      assertPublicDestination(new URL("http://[2606:4700:4700::1111]/")),
    ).resolves.toBeUndefined();
  });
});
