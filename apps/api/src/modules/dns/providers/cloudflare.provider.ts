import type { DesiredRecord } from "@gamedashboard/contracts";
import {
  type DnsConnection,
  type DnsProvider,
  DnsRefusal,
  type DnsRefusalReason,
  type NamedRecord,
  type ProviderRecord,
} from "../dns-provider";

export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

const FETCH_TIMEOUT_MS = 8_000;

/**
 * Durée de vie des enregistrements, en secondes : le minimum de Cloudflare.
 * Après un transfert, l'ancienne adresse ne doit pas rester en cache une heure.
 */
const TTL_SECONDS = 60;

/** Identifiants de zone et d'enregistrement : 32 caractères hexadécimaux. */
const CLOUDFLARE_ID = /^[a-f0-9]{32}$/;

type Fetch = typeof fetch;

/** L'enveloppe de toute réponse de l'API v4. */
interface CloudflareEnvelope {
  success?: unknown;
  errors?: unknown;
  result?: unknown;
}

/**
 * L'API DNS de Cloudflare, par `fetch` seul.
 *
 * Les enregistrements ne sont **jamais relayés** (`proxied: false`) : le proxy
 * de Cloudflare ne transporte que du HTTP, et un serveur de jeu relayé ne
 * répondrait plus à personne.
 *
 * Chaque enregistrement porte une note (`comment`) qui nomme le serveur : dans
 * le tableau de bord de Cloudflare, l'exploitant voit d'où il vient.
 */
export class CloudflareProvider implements DnsProvider {
  readonly kind = "cloudflare" as const;

  constructor(
    private readonly fetcher: Fetch = (input, init) => fetch(input, init),
    private readonly base: string = CLOUDFLARE_API,
  ) {}

  async zoneName(connection: DnsConnection): Promise<string> {
    const result = (await this.call(connection, "GET", "")) as { name?: unknown } | null;
    const name = typeof result?.name === "string" ? result.name : null;
    if (!name) throw new Error("Réponse de Cloudflare illisible.");
    return name.toLowerCase();
  }

  async recordsNamed(connection: DnsConnection, name: string): Promise<NamedRecord[]> {
    const query = new URLSearchParams({ name, per_page: "100" });
    const result = await this.call(connection, "GET", `/dns_records?${query}`);
    if (!Array.isArray(result)) throw new Error("Réponse de Cloudflare illisible.");
    return result.flatMap((row: unknown) => {
      const record = row as { id?: unknown; type?: unknown; comment?: unknown };
      const note = typeof record.comment === "string" ? record.comment : null;
      return typeof record.id === "string" && typeof record.type === "string"
        ? [{ id: record.id, type: record.type, note }]
        : [];
    });
  }

  async create(connection: DnsConnection, record: DesiredRecord, note: string) {
    const result = await this.call(connection, "POST", "/dns_records", body(record, note));
    return published(result, record);
  }

  async update(connection: DnsConnection, id: string, record: DesiredRecord, note: string) {
    const result = await this.call(
      connection,
      "PUT",
      `/dns_records/${recordId(id)}`,
      body(record, note),
    );
    return published(result, record);
  }

  async remove(connection: DnsConnection, id: string): Promise<void> {
    try {
      await this.call(connection, "DELETE", `/dns_records/${recordId(id)}`);
    } catch (error) {
      // Déjà retiré, à la main ou par un essai précédent interrompu.
      if (error instanceof DnsRefusal && error.reason === "missing") return;
      throw error;
    }
  }

  private async call(
    connection: DnsConnection,
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    payload?: unknown,
  ): Promise<Record<string, unknown> | unknown[] | null> {
    // L'identifiant finit dans le chemin : une valeur libre y ajouterait des
    // segments (`../`), et le jeton partirait vers une autre ressource.
    if (!CLOUDFLARE_ID.test(connection.zoneId)) {
      throw new DnsRefusal("L'identifiant de zone doit compter 32 caractères hexadécimaux.");
    }
    const response = await this.fetcher(`${this.base}/zones/${connection.zoneId}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${connection.apiToken}`,
        accept: "application/json",
        ...(payload === undefined ? {} : { "content-type": "application/json" }),
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    let envelope: CloudflareEnvelope | null;
    try {
      envelope = (await response.json()) as CloudflareEnvelope | null;
    } catch {
      envelope = null;
    }
    if (response.ok && envelope?.success === true) {
      return (envelope.result ?? null) as Record<string, unknown> | unknown[] | null;
    }
    throw new CloudflareError(response.status, firstMessage(envelope?.errors, connection.apiToken));
  }
}

/**
 * Un refus de Cloudflare : sa phrase, et le statut HTTP pour distinguer
 * « absent » (404) du reste. Jeton refusé, droits manquants et nom en conflit
 * sont des refus ; une réponse 5xx est une panne.
 */
export class CloudflareError extends DnsRefusal {
  constructor(
    readonly status: number,
    detail: string | null,
  ) {
    super(
      status >= 500
        ? `Cloudflare ne répond pas (${status}).`
        : `Cloudflare a refusé la demande (${status})${detail ? ` : ${detail}` : "."}`,
      reasonOf(status),
    );
  }
}

function reasonOf(status: number): DnsRefusalReason {
  if (status === 401 || status === 403) return "forbidden";
  if (status === 404) return "missing";
  return status >= 500 ? "down" : "refused";
}

function recordId(id: string): string {
  if (!CLOUDFLARE_ID.test(id)) throw new Error("Identifiant d'enregistrement illisible.");
  return id;
}

/**
 * La phrase du premier refus, jeton masqué **avant** d'être coupée : coupée
 * d'abord, un jeton répété en fin de message sortirait tronqué, donc
 * méconnaissable.
 */
function firstMessage(errors: unknown, token: string): string | null {
  if (!Array.isArray(errors)) return null;
  const first = errors[0] as { message?: unknown } | undefined;
  if (typeof first?.message !== "string") return null;
  const masked = token.length >= 8 ? first.message.split(token).join("[jeton]") : first.message;
  return masked.slice(0, 200);
}

function body(record: DesiredRecord, note: string): Record<string, unknown> {
  const common = { name: record.name, ttl: TTL_SECONDS, comment: note.slice(0, 100) };
  if (record.type === "SRV") {
    return {
      ...common,
      type: "SRV",
      data: { priority: 0, weight: 5, port: record.port, target: record.target },
    };
  }
  return { ...common, type: record.type, content: record.content, proxied: false };
}

function published(result: unknown, record: DesiredRecord): ProviderRecord {
  const id = (result as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || !CLOUDFLARE_ID.test(id)) {
    throw new Error("Réponse de Cloudflare illisible.");
  }
  return { ...record, id };
}
