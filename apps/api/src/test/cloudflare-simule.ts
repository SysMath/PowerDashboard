import { randomBytes } from "node:crypto";

/**
 * Une API Cloudflare simulée, en mémoire, pour les tests des sous-domaines.
 *
 * Elle répond comme l'API v4 aux seuls appels que le panel emploie : lire la
 * zone, lister les enregistrements d'un nom, créer, remplacer et retirer un
 * enregistrement. Même enveloppe (`success`, `errors`, `result`), mêmes
 * statuts (401 sans le bon jeton, 404 pour un enregistrement absent, 400 pour
 * un nom déjà pris en CNAME), et les corps reçus sont gardés pour qu'un test
 * vérifie ce qui est réellement parti.
 */
export interface EnregistrementSimule {
  id: string;
  type: string;
  name: string;
  content?: string;
  data?: { priority: number; weight: number; port: number; target: string };
  ttl: number;
  proxied?: boolean;
  comment?: string;
}

export interface CloudflareSimule {
  fetch: typeof fetch;
  zoneId: string;
  zoneName: string;
  jeton: string;
  enregistrements: Map<string, EnregistrementSimule>;
  appels: { method: string; path: string; body: unknown }[];
  /** Vrai : toute requête répond 503, comme une panne. */
  panne: boolean;
  /** Ajoute un enregistrement posé hors du panel. */
  poser(record: Omit<EnregistrementSimule, "id" | "ttl">): string;
}

export function cloudflareSimule(zoneName = "exemple.fr"): CloudflareSimule {
  const sim: CloudflareSimule = {
    zoneId: randomBytes(16).toString("hex"),
    zoneName,
    jeton: `jeton-${randomBytes(6).toString("hex")}`,
    enregistrements: new Map(),
    appels: [],
    panne: false,
    poser(record) {
      const id = randomBytes(16).toString("hex");
      sim.enregistrements.set(id, { ...record, id, ttl: 1 });
      return id;
    },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      sim.appels.push({ method, path: `${url.pathname}${url.search}`, body });

      if (sim.panne) return reponse(503, { success: false, errors: [], result: null });
      const auth = new Headers(init?.headers).get("authorization");
      if (auth !== `Bearer ${sim.jeton}`) {
        return echec(401, 10000, "Authentication error");
      }

      const prefix = `/client/v4/zones/${sim.zoneId}`;
      if (!url.pathname.startsWith(prefix)) return echec(404, 7003, "Could not route");
      const rest = url.pathname.slice(prefix.length);

      if (rest === "" && method === "GET") {
        return succes({ id: sim.zoneId, name: sim.zoneName });
      }
      if (rest === "/dns_records" && method === "GET") {
        const name = url.searchParams.get("name");
        return succes([...sim.enregistrements.values()].filter((r) => r.name === name));
      }
      if (rest === "/dns_records" && method === "POST") {
        const conflit = [...sim.enregistrements.values()].some(
          (r) => r.name === body.name && (r.type === "CNAME" || body.type === "CNAME"),
        );
        if (conflit) {
          return echec(400, 81053, "An A, AAAA, or CNAME record with that host already exists.");
        }
        const id = randomBytes(16).toString("hex");
        const record = { ...body, id } as EnregistrementSimule;
        sim.enregistrements.set(id, record);
        return succes(record);
      }
      const match = /^\/dns_records\/([a-f0-9]{32})$/.exec(rest);
      if (match?.[1]) {
        const id = match[1];
        if (!sim.enregistrements.has(id)) return echec(404, 81044, "Record does not exist.");
        if (method === "PUT") {
          const record = { ...body, id } as EnregistrementSimule;
          sim.enregistrements.set(id, record);
          return succes(record);
        }
        if (method === "DELETE") {
          sim.enregistrements.delete(id);
          return succes({ id });
        }
      }
      return echec(405, 10405, "Method not allowed");
    },
  };
  return sim;
}

function reponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function succes(result: unknown): Response {
  return reponse(200, { success: true, errors: [], messages: [], result });
}

function echec(status: number, code: number, message: string): Response {
  return reponse(status, { success: false, errors: [{ code, message }], result: null });
}
