import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Refus des destinations internes pour tout ce que le panel appelle sur
 * demande d'un tiers : rappels sortants, adresses saisies par un client.
 *
 * Le panel tourne sur un réseau qui contient des choses qu'un visiteur ne
 * doit pas atteindre — l'API sur la boucle locale, les nodes, un service de
 * métadonnées chez certains hébergeurs. Une adresse « publique » à l'écran
 * peut résoudre vers l'un d'eux : c'est le nom qu'il faut résoudre, pas
 * seulement le lire.
 *
 * Le contrôle est fait au moment de l'enregistrement. Une résolution qui
 * changerait ensuite (rebinding DNS) n'est pas couverte : la protection
 * réelle contre ce cas est que le panel ne rend jamais le corps de la réponse
 * d'un rappel, seulement son code.
 */
export async function assertPublicDestination(url: URL): Promise<void> {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw new PrivateDestinationError(host);
  }

  const addresses = isIP(host)
    ? [host]
    : await lookup(host, { all: true })
        .then((entries) => entries.map((entry) => entry.address))
        .catch(() => []);

  // Un nom qui ne résout pas est refusé aussi : un rappel vers nulle part ne
  // partirait jamais, autant le dire tout de suite.
  if (addresses.length === 0) throw new PrivateDestinationError(host);

  for (const address of addresses) {
    if (isPrivateAddress(address)) throw new PrivateDestinationError(host);
  }
}

export class PrivateDestinationError extends Error {
  constructor(host: string) {
    super(`« ${host} » désigne une adresse interne ou introuvable.`);
    this.name = "PrivateDestinationError";
  }
}

/**
 * Plages qui ne sont jamais une destination légitime depuis le panel.
 *
 * L'adresse est d'abord **lue**, pas comparée comme du texte : une même
 * adresse IPv6 s'écrit de bien des façons (`::1` et `0:0:0:0:0:0:0:1`,
 * `::ffff:127.0.0.1` et `::ffff:7f00:1` — la forme que `URL` produit), et
 * seule la valeur compte. Ce qui ne se lit ni en IPv4 ni en IPv6 est refusé :
 * mieux vaut une destination de trop refusée qu'une adresse interne admise.
 */
export function isPrivateAddress(address: string): boolean {
  const v4 = ipv4Octets(address);
  if (v4) return privateIpv4(v4);
  const groups = ipv6Groups(address);
  return groups ? privateIpv6(groups) : true;
}

function privateIpv4([a, b, c]: number[]): boolean {
  if (a === undefined || b === undefined || c === undefined) return true;
  if (a === 0 || a === 10 || a === 127) return true; // ce réseau, privé, boucle
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // lien local et métadonnées
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && c === 0) return true; // affectations de l'IETF
  if (a === 192 && b === 88 && c === 99) return true; // relais 6to4, retiré
  if (a === 198 && (b === 18 || b === 19)) return true; // bancs d'essai
  if (a >= 224) return true; // multicast et réservé
  return false;
}

function privateIpv6(g: number[]): boolean {
  const head = g[0] ?? 0;
  const embedded = () => [
    (g[6] ?? 0) >> 8,
    (g[6] ?? 0) & 0xff,
    (g[7] ?? 0) >> 8,
    (g[7] ?? 0) & 0xff,
  ];
  const zeros = (from: number, to: number) => g.slice(from, to).every((group) => group === 0);
  // `::`, `::1` et l'IPv4 « compatible » (::a.b.c.d, obsolète) : on juge
  // l'adresse IPv4 qu'elles portent — `0.0.0.0/8` pour les deux premières.
  if (zeros(0, 6)) return privateIpv4(embedded());
  // IPv4 encapsulée (::ffff:a.b.c.d) et sa variante traduite (::ffff:0:a.b.c.d).
  if (zeros(0, 5) && g[5] === 0xffff) return privateIpv4(embedded());
  if (zeros(0, 4) && g[4] === 0xffff && g[5] === 0) return privateIpv4(embedded());
  // NAT64 (64:ff9b::/96) : la passerelle joint l'adresse IPv4 qu'elle porte.
  if (head === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return privateIpv4(embedded());
  if (head === 0x64 && g[1] === 0xff9b && g[2] === 1) return true; // NAT64 local
  if (head === 0x0100 && zeros(1, 4)) return true; // rejet (100::/64)
  // 6to4 (2002::/16) : l'IPv4 est dans les groupes 1 et 2.
  if (head === 0x2002) {
    return privateIpv4([
      (g[1] ?? 0) >> 8,
      (g[1] ?? 0) & 0xff,
      (g[2] ?? 0) >> 8,
      (g[2] ?? 0) & 0xff,
    ]);
  }
  if (head === 0x2001 && g[1] === 0) return true; // Teredo (2001::/32), adresse masquée
  if ((head & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
  if ((head & 0xffc0) === 0xfe80) return true; // lien local fe80::/10
  if ((head & 0xffc0) === 0xfec0) return true; // site local fec0::/10, obsolète
  if ((head & 0xff00) === 0xff00) return true; // multicast ff00::/8
  return false;
}

/** `a.b.c.d` en quatre octets, ou `null`. */
function ipv4Octets(address: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

/**
 * Une adresse IPv6, sous n'importe laquelle de ses écritures, en huit groupes
 * de 16 bits ; `null` si ce n'en est pas une. Crochets et zone (`%eth0`) sont
 * ignorés.
 */
function ipv6Groups(raw: string): number[] | null {
  const address = raw
    .trim()
    .replace(/^\[|\]$/g, "")
    .replace(/%.*$/, "")
    .toLowerCase();
  if (!address.includes(":")) return null;

  // Une IPv4 en queue compte pour deux groupes.
  let text = address;
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (tail?.[1]) {
    const octets = ipv4Octets(tail[1]);
    if (!octets) return null;
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    text = `${text.slice(0, -tail[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const read = (part: string) => (part === "" ? [] : part.split(":"));
  const left = read(halves[0] ?? "");
  const right = halves.length === 2 ? read(halves[1] ?? "") : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;

  const groups = [...left, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...right];
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map((group) => Number.parseInt(group, 16));
}
