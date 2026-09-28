/**
 * Sous-domaines automatiques des serveurs (PLAN §10.3).
 *
 * Le client choisit un libellé, `monserveur`, et le panel publie
 * `monserveur.<domaine des serveurs>` dans la zone DNS réglée par
 * l'administration : une adresse qui survit aux changements de port et aux
 * transferts, parce que c'est le panel qui la tient à jour.
 *
 * Ce module ne connaît ni le réseau ni la base : ce qui décide qu'un libellé
 * est acceptable, et quels enregistrements publier, doit pouvoir s'éprouver
 * sans eux.
 */

/** Les fournisseurs DNS que le panel sait piloter. */
export const DNS_PROVIDERS = ["cloudflare"] as const;

export type DnsProviderKind = (typeof DNS_PROVIDERS)[number];

export const DNS_PROVIDER_LABELS: Readonly<Record<DnsProviderKind, string>> = {
  cloudflare: "Cloudflare",
};

/** La valeur de `dns.provider`, si c'est un fournisseur connu ; sinon `null`. */
export function readableDnsProvider(raw: unknown): DnsProviderKind | null {
  return typeof raw === "string" && (DNS_PROVIDERS as readonly string[]).includes(raw)
    ? (raw as DnsProviderKind)
    : null;
}

export const SUBDOMAIN_LABEL_MIN = 3;
export const SUBDOMAIN_LABEL_MAX = 63;

/**
 * Libellés refusés d'office, en plus de ceux que l'administration ajoute.
 *
 * Ce sont les noms qu'une zone emploie déjà, ou qu'un visiteur prendrait pour
 * un service de la plateforme : un client qui obtient `panel` ou `support`
 * sous le domaine de l'hébergeur tient une adresse de hameçonnage toute prête.
 */
export const BUILTIN_RESERVED_LABELS: readonly string[] = [
  "admin",
  "api",
  "app",
  "autoconfig",
  "account",
  "auth",
  "autodiscover",
  "billing",
  "blog",
  "cdn",
  "cpanel",
  "dashboard",
  "dns",
  "docs",
  "email",
  "facturation",
  "ftp",
  "gamedashboard",
  "help",
  "imap",
  "isatap",
  "localhost",
  "login",
  "mail",
  "mta-sts",
  "mx",
  "ns",
  "ns1",
  "ns2",
  "ns3",
  "ns4",
  "panel",
  "pop",
  "pop3",
  "sftp",
  "shop",
  "smtp",
  "sso",
  "static",
  "status",
  "support",
  "webmail",
  "wings",
  "wpad",
  "www",
];

/**
 * Libellés réservés : ceux du panel, plus la liste de l'administration
 * (`dns.reservedLabels`, séparés par des virgules, des espaces ou des retours
 * à la ligne).
 */
export function reservedLabels(extra: string): ReadonlySet<string> {
  const added = extra
    .split(/[\s,;]+/)
    .map((label) => label.trim().toLowerCase())
    .filter((label) => label !== "");
  return new Set([...BUILTIN_RESERVED_LABELS, ...added]);
}

export type SubdomainLabelProblem = "length" | "characters" | "punycode" | "reserved";

/**
 * Pourquoi un libellé est refusé, ou `null` s'il est acceptable.
 *
 * Un seul niveau (pas de point), lettres minuscules, chiffres et tirets, sans
 * tiret au bord. Les formes `xx--` sont refusées : `xn--` est l'encodage d'un
 * nom international, par lequel on écrit `pаypal` avec un « а » cyrillique, et
 * les autres sont réservées par la norme.
 */
export function subdomainLabelProblem(
  label: string,
  reserved: ReadonlySet<string>,
): SubdomainLabelProblem | null {
  if (label.length < SUBDOMAIN_LABEL_MIN || label.length > SUBDOMAIN_LABEL_MAX) return "length";
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) return "characters";
  if (label.slice(2, 4) === "--") return "punycode";
  if (reserved.has(label)) return "reserved";
  return null;
}

export const SUBDOMAIN_LABEL_MESSAGES: Readonly<Record<SubdomainLabelProblem, string>> = {
  length: `Le nom doit compter de ${SUBDOMAIN_LABEL_MIN} à ${SUBDOMAIN_LABEL_MAX} caractères.`,
  characters:
    "Le nom ne peut contenir que des lettres minuscules sans accent, des chiffres et des tirets, sans tiret au début ni à la fin.",
  punycode: "Un tiret double en troisième position est réservé aux noms internationaux.",
  reserved: "Ce nom est réservé par la plateforme.",
};

/**
 * Le domaine des serveurs, tel que l'administration l'a saisi, ramené à sa
 * forme canonique — ou `null` s'il n'est pas un nom de domaine.
 */
export function normalizeDnsDomain(raw: string): string | null {
  const domain = raw.trim().toLowerCase().replace(/\.$/, "");
  if (domain.length === 0 || domain.length > 200) return null;
  const labels = domain.split(".");
  if (labels.length < 2) return null;
  const valid = labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
  return valid ? domain : null;
}

/** `domain` est la zone elle-même, ou l'un de ses sous-domaines. */
export function domainWithinZone(domain: string, zone: string): boolean {
  return domain === zone || domain.endsWith(`.${zone}`);
}

/**
 * Le service SRV d'un jeu qui le lit : le client cherche
 * `_minecraft._tcp.<nom>` avant de se connecter, et y trouve le port. Les
 * autres jeux ne le lisent pas : leurs joueurs saisissent le port.
 */
export const MINECRAFT_SRV_PREFIX = "_minecraft._tcp";

/** Un enregistrement tel que le panel le veut publié. */
export type DesiredRecord =
  | { type: "A" | "AAAA" | "CNAME"; name: string; content: string }
  | { type: "SRV"; name: string; target: string; port: number };

/**
 * Où joindre un serveur, une fois son adresse publique connue.
 *
 * - `host` est une adresse IPv4, IPv6 ou un nom d'hôte ;
 * - `srv` vaut vrai pour un jeu qui lit l'enregistrement SRV.
 *
 * Un nom d'hôte se publie en CNAME, et le SRV vise alors directement ce nom :
 * la norme (RFC 2782) interdit qu'un SRV vise un alias.
 */
export function desiredRecords(input: {
  fqdn: string;
  host: string;
  hostKind: "ipv4" | "ipv6" | "name";
  port: number;
  srv: boolean;
}): DesiredRecord[] {
  const { fqdn, host, hostKind, port, srv } = input;
  const address: DesiredRecord =
    hostKind === "ipv4"
      ? { type: "A", name: fqdn, content: host }
      : hostKind === "ipv6"
        ? { type: "AAAA", name: fqdn, content: host }
        : { type: "CNAME", name: fqdn, content: host.replace(/\.$/, "").toLowerCase() };
  if (!srv) return [address];
  const target = hostKind === "name" ? address.content : fqdn;
  return [address, { type: "SRV", name: `${MINECRAFT_SRV_PREFIX}.${fqdn}`, target, port }];
}

/** Deux enregistrements désignent la même chose (même type, même nom, même cible). */
export function sameRecord(a: DesiredRecord, b: DesiredRecord): boolean {
  if (a.type !== b.type || a.name !== b.name) return false;
  if (a.type === "SRV" && b.type === "SRV") return a.target === b.target && a.port === b.port;
  if (a.type !== "SRV" && b.type !== "SRV") return a.content === b.content;
  return false;
}

/** État d'un sous-domaine, tel que l'écran le montre. */
export type SubdomainStatus = "pending" | "active" | "error";

export interface SubdomainView {
  label: string;
  fqdn: string;
  status: SubdomainStatus;
  /** Raison du dernier échec, en clair ; nulle hors erreur. */
  error: string | null;
  /**
   * Ce que le joueur saisit : le nom seul quand le jeu lit le SRV, le nom et
   * le port sinon.
   */
  address: string;
  srv: boolean;
}

/** Ce que l'écran réseau d'un serveur sait de son sous-domaine. */
export interface SubdomainState {
  /** Faux tant que l'administration n'a pas réglé de zone. */
  available: boolean;
  /** Domaine sous lequel le libellé sera publié. */
  domain: string | null;
  subdomain: SubdomainView | null;
}
