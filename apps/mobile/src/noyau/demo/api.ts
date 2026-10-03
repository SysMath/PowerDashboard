import type { ClientFileEntryView, IncidentImpact, IncidentState } from "@gamedashboard/contracts";
import { type EtatDemo, etatInitial, type Langue, texteDemo } from "./donnees";

/**
 * Le panel fictif du mode démo : un `fetch` qui répond comme l'API, sur un
 * état en mémoire, et une socket de console qui répond comme le daemon. Rien
 * ne sort du téléphone. Les écrans sont les vrais, avec le vrai SDK.
 */

export const ADRESSE_DEMO = "https://demo.gamedashboard.invalid";

interface Requete {
  methode: string;
  chemin: string;
  query: URLSearchParams;
  corps: Record<string, unknown>;
  params: string[];
}

type Reponse = { data?: unknown; meta?: unknown; texte?: string; statut?: number };
type Gestionnaire = (etat: EtatDemo, requete: Requete) => Reponse;

const refus = (statut: number, titre: string): Reponse => ({ statut, data: { title: titre } });

const parent = (chemin: string) => chemin.replace(/\/[^/]+$/, "") || "/";
const joindre = (dossier: string, nom: string) =>
  dossier === "/" ? `/${nom}` : `${dossier}/${nom}`;
const texte = (valeur: unknown) => (typeof valeur === "string" ? valeur : "");

function ajouterEntree(etat: EtatDemo, dossier: string, entree: ClientFileEntryView) {
  const liste = etat.dossiers[dossier] ?? [];
  etat.dossiers[dossier] = [...liste.filter((autre) => autre.name !== entree.name), entree];
}

const fichierNeuf = (name: string, directory: boolean, size = 0): ClientFileEntryView => ({
  name,
  mode: directory ? "drwxr-xr-x" : "-rw-r--r--",
  size,
  directory,
  file: !directory,
  symlink: false,
  mime: directory ? "inode/directory" : "text/plain",
  modified: new Date().toISOString(),
});

/** Une suspension se voit partout : écrans du client, du revendeur et de l'administration. */
function suspendre(etat: EtatDemo, id: string, suspendu: boolean): boolean {
  const cibles = [
    ...etat.serveurs.filter((s) => s.id === id),
    ...etat.revendeur.servers.filter((s) => s.id === id),
    ...etat.parc.filter((s) => s.id === id),
  ];
  for (const cible of cibles) cible.state = suspendu ? "suspended" : null;
  return cibles.length > 0;
}

/** Les sockets de console ouvertes, par serveur : une commande y fait écho. */
type Ecoute = (evenement: string, args: string[]) => void;

export interface ApiDemo {
  fetch: typeof fetch;
  WebSocket: typeof WebSocket;
}

export function creerApiDemo(langue: Langue, maintenant: () => number = Date.now): ApiDemo {
  const etat = etatInitial(maintenant(), langue);
  const ecoutes = new Map<string, Set<Ecoute>>();
  const diffuser = (serverId: string, evenement: string, args: string[]) => {
    for (const ecoute of ecoutes.get(serverId) ?? []) ecoute(evenement, args);
  };

  const serveur = (id: string) => etat.serveurs.find((s) => s.id === id);

  const routes: [string, RegExp, Gestionnaire][] = [
    [
      "GET",
      /^\/api\/v1\/auth\/me$/,
      () => ({
        data: { user: { id: "demo-user-1", email: "demo@exemple.invalid", role: "admin" } },
      }),
    ],
    ["GET", /^\/api\/v1\/client\/servers$/, (e) => ({ data: e.serveurs })],
    [
      "GET",
      /^\/api\/v1\/client\/servers\/([^/]+)$/,
      (_e, r) => {
        const s = serveur(r.params[0] ?? "");
        return s ? { data: s } : refus(404, "Serveur introuvable.");
      },
    ],
    [
      "POST",
      /^\/api\/v1\/client\/servers\/([^/]+)\/power$/,
      (_e, r) => {
        const id = r.params[0] ?? "";
        const s = serveur(id);
        if (!s) return refus(404, "Serveur introuvable.");
        const marche = r.corps.signal === "start" || r.corps.signal === "restart";
        s.runtimeState = marche ? "running" : "offline";
        s.cpuPct = marche ? 12 : null;
        s.memoryMb = marche ? 1800 : null;
        s.players = marche ? 0 : null;
        diffuser(id, "status", [s.runtimeState]);
        diffuser(id, "console output", [
          marche ? "[demo] Server started" : "[demo] Server stopped",
        ]);
        return { statut: 204 };
      },
    ],
    [
      "POST",
      /^\/api\/v1\/client\/servers\/([^/]+)\/websocket$/,
      (_e, r) => ({
        data: { token: "demo", socket: `wss://demo.gamedashboard.invalid/console/${r.params[0]}` },
      }),
    ],
    [
      "POST",
      /^\/api\/v1\/client\/servers\/([^/]+)\/command$/,
      (e, r) => {
        const id = r.params[0] ?? "";
        const commande = texte(r.corps.command);
        const lignes = [`> ${commande}`, `[demo] ${texteDemo(e.langue).commande}`];
        e.consoles[id] = [...(e.consoles[id] ?? []), ...lignes];
        diffuser(id, "console output", lignes);
        return { statut: 204 };
      },
    ],
    [
      "GET",
      /^\/api\/v1\/client\/servers\/([^/]+)\/players$/,
      (_e, r) => {
        const s = serveur(r.params[0] ?? "");
        const noms = ["Kestrel", "Juniper", "Marlow", "Quill", "Rowan", "Sable", "Tamsin"];
        return {
          data: {
            online: s?.players ?? null,
            max: s?.maxPlayers ?? null,
            sample: s?.players ? noms.slice(0, s.players) : [],
            complete: true,
            observedAt: new Date(maintenant()).toISOString(),
            actions: ["kick", "ban", "pardon", "whitelist_add", "whitelist_remove", "op", "deop"],
          },
        };
      },
    ],
    ["POST", /^\/api\/v1\/client\/servers\/([^/]+)\/players$/, () => ({ statut: 204 })],
    [
      "GET",
      /^\/api\/v1\/client\/notifications$/,
      (e) => ({
        data: e.notifications,
        meta: { unread: e.notifications.filter((n) => n.readAt === null).length },
      }),
    ],
    [
      "POST",
      /^\/api\/v1\/client\/notifications\/read-all$/,
      (e) => {
        const lu = new Date(maintenant()).toISOString();
        e.notifications = e.notifications.map((n) => ({ ...n, readAt: n.readAt ?? lu }));
        return { statut: 204 };
      },
    ],
    ...sauvegardes(maintenant),
    ...fichiers(),
    ...revendeur(),
    ...administration(maintenant),
  ];

  const repondre = (requete: Requete): Reponse => {
    for (const [methode, motif, gestionnaire] of routes) {
      if (methode !== requete.methode) continue;
      const trouve = motif.exec(requete.chemin);
      if (!trouve) continue;
      return gestionnaire(etat, { ...requete, params: trouve.slice(1).map(decodeURIComponent) });
    }
    return refus(404, "Indisponible en démonstration.");
  };

  const fetchDemo = (async (entree: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(entree));
    const corps =
      typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const reponse = repondre({
      methode: (init.method ?? "GET").toUpperCase(),
      chemin: url.pathname,
      query: url.searchParams,
      corps,
      params: [],
    });
    const statut = reponse.statut ?? 200;
    if (reponse.texte !== undefined) return new Response(reponse.texte, { status: statut });
    if (statut === 204) return new Response(null, { status: 204 });
    const enveloppe = statut >= 400 ? reponse.data : { data: reponse.data, meta: reponse.meta };
    return Response.json(enveloppe, { status: statut });
  }) as typeof fetch;

  return { fetch: fetchDemo, WebSocket: socketDemo(etat, ecoutes) };
}

/* --- Sauvegardes ------------------------------------------------------------ */

function sauvegardes(maintenant: () => number): [string, RegExp, Gestionnaire][] {
  const base = /^\/api\/v1\/client\/servers\/([^/]+)\/backups/;
  const liste = (e: EtatDemo, id: string) => {
    e.sauvegardes[id] = e.sauvegardes[id] ?? [];
    return e.sauvegardes[id];
  };
  return [
    [
      "GET",
      new RegExp(`${base.source}$`),
      (e, r) => {
        const items = liste(e, r.params[0] ?? "");
        return { data: items, meta: { used: items.length, limit: 5 } };
      },
    ],
    [
      "POST",
      new RegExp(`${base.source}$`),
      (e, r) => {
        const items = liste(e, r.params[0] ?? "");
        if (items.length >= 5) return refus(409, "Limite de sauvegardes atteinte.");
        const date = new Date(maintenant()).toISOString();
        const neuve = {
          id: `demo-bkp-${maintenant()}`,
          name: texte(r.corps.name) || "backup",
          bytes: 380 * 1024 * 1024,
          checksum: null,
          isSuccessful: true,
          isLocked: false,
          createdAt: date,
          completedAt: date,
        };
        e.sauvegardes[r.params[0] ?? ""] = [neuve, ...items];
        return { data: neuve };
      },
    ],
    [
      "POST",
      new RegExp(`${base.source}/([^/]+)/lock$`),
      (e, r) => {
        const b = liste(e, r.params[0] ?? "").find((x) => x.id === r.params[1]);
        if (b) b.isLocked = r.corps.locked === true;
        return { statut: 204 };
      },
    ],
    ["POST", new RegExp(`${base.source}/([^/]+)/restore$`), () => ({ statut: 204 })],
    [
      "DELETE",
      new RegExp(`${base.source}/([^/]+)$`),
      (e, r) => {
        const id = r.params[0] ?? "";
        const b = liste(e, id).find((x) => x.id === r.params[1]);
        if (b?.isLocked) return refus(409, "Sauvegarde verrouillée.");
        e.sauvegardes[id] = liste(e, id).filter((x) => x.id !== r.params[1]);
        return { statut: 204 };
      },
    ],
  ];
}

/* --- Fichiers ---------------------------------------------------------------- */

function fichiers(): [string, RegExp, Gestionnaire][] {
  const route = (action: string) =>
    new RegExp(`^/api/v1/client/servers/([^/]+)/files${action ? `/${action}` : ""}$`);
  const racine = (r: Requete) => texte(r.corps.root) || "/";
  return [
    ["GET", route(""), (e, r) => ({ data: e.dossiers[r.query.get("directory") ?? "/"] ?? [] })],
    [
      "GET",
      route("contents"),
      (e, r) => ({
        data: { content: e.textes[r.query.get("file") ?? ""] ?? "" },
      }),
    ],
    [
      "POST",
      route("write"),
      (e, r) => {
        const chemin = r.query.get("file") ?? "";
        e.textes[chemin] = texte(r.corps.content);
        ajouterEntree(
          e,
          parent(chemin),
          fichierNeuf(chemin.split("/").pop() ?? "", false, e.textes[chemin].length),
        );
        return { statut: 204 };
      },
    ],
    [
      "POST",
      route("create-directory"),
      (e, r) => {
        const chemin = joindre(racine(r), texte(r.corps.name));
        e.dossiers[chemin] ??= [];
        ajouterEntree(e, racine(r), fichierNeuf(texte(r.corps.name), true));
        return { statut: 204 };
      },
    ],
    [
      "POST",
      route("rename"),
      (e, r) => {
        const dossier = racine(r);
        const entree = (e.dossiers[dossier] ?? []).find((x) => x.name === r.corps.from);
        if (!entree) return refus(404, "Fichier introuvable.");
        e.dossiers[dossier] = (e.dossiers[dossier] ?? []).filter((x) => x !== entree);
        const cible = joindre(dossier, texte(r.corps.to));
        ajouterEntree(e, parent(cible), { ...entree, name: cible.split("/").pop() ?? entree.name });
        return { statut: 204 };
      },
    ],
    [
      "POST",
      route("delete"),
      (e, r) => {
        const noms = Array.isArray(r.corps.files) ? r.corps.files : [];
        e.dossiers[racine(r)] = (e.dossiers[racine(r)] ?? []).filter((x) => !noms.includes(x.name));
        return { statut: 204 };
      },
    ],
    [
      "POST",
      route("compress"),
      (e, r) => {
        const nom = `archive-${(e.dossiers[racine(r)] ?? []).length}.tar.gz`;
        ajouterEntree(e, racine(r), {
          ...fichierNeuf(nom, false, 2_400_000),
          mime: "application/gzip",
        });
        return { data: { name: nom, size: 2_400_000 } };
      },
    ],
    [
      "POST",
      route("decompress"),
      (e, r) => {
        ajouterEntree(
          e,
          racine(r),
          fichierNeuf(texte(r.corps.file).replace(/\.tar\.gz$|\.zip$/, ""), true),
        );
        return { statut: 204 };
      },
    ],
  ];
}

/* --- Revendeur --------------------------------------------------------------- */

function revendeur(): [string, RegExp, Gestionnaire][] {
  return [
    ["GET", /^\/api\/v1\/reseller\/overview$/, (e) => ({ data: e.revendeur })],
    [
      "POST",
      /^\/api\/v1\/reseller\/servers\/([^/]+)\/suspension$/,
      (e, r) => {
        const id = r.params[0] ?? "";
        const suspendu = r.corps.suspended === true;
        if (!suspendre(e, id, suspendu)) return refus(404, "Serveur introuvable.");
        return { data: { serverId: id, suspended: suspendu, sessionsNotClosed: 0 } };
      },
    ],
    [
      "GET",
      /^\/api\/v1\/reseller\/consumption\/export$/,
      (e, r) => {
        const debut = Date.parse(`${r.query.get("from")}T00:00:00Z`);
        const fin = Date.parse(`${r.query.get("to")}T00:00:00Z`);
        const lignes: string[] = [];
        for (let jour = debut; jour <= fin; jour += 86_400_000) {
          e.revendeur.servers.forEach((s, rang) => {
            lignes.push(
              JSON.stringify({
                serverId: s.id,
                serverName: s.name,
                day: new Date(jour).toISOString().slice(0, 10),
                samples: 288,
                onlineSamples: 288 - rang * 20,
                cpuAvgPct: 18 + rang * 7,
                memoryMaxBytes: (1500 + rang * 400) * 1024 * 1024,
                networkRxBytes: 900_000_000,
                networkTxBytes: 1_400_000_000,
                playersMax: 4 + rang,
                complete: true,
              }),
            );
          });
        }
        return { texte: lignes.join("\n") };
      },
    ],
  ];
}

/* --- Administration ---------------------------------------------------------- */

function administration(maintenant: () => number): [string, RegExp, Gestionnaire][] {
  const date = () => new Date(maintenant()).toISOString();
  return [
    ["GET", /^\/api\/v1\/admin\/nodes$/, (e) => ({ data: e.noeuds })],
    [
      "GET",
      /^\/api\/v1\/admin\/nodes\/([^/]+)\/agent$/,
      () => ({
        data: {
          status: "online",
          version: "v0.3.0",
          functions: ["instantanes"],
          lastSeenAt: date(),
          tokenIssuedAt: date(),
          capabilities: {
            instantanes: { state: "active", offered: true, writable: true, reason: null },
          },
          configurationPath: "/api/node-agent/configuration",
        },
      }),
    ],
    ["GET", /^\/api\/v1\/admin\/servers$/, (e) => ({ data: e.parc })],
    [
      "POST",
      /^\/api\/v1\/admin\/servers\/([^/]+)\/suspend$/,
      (e, r) => {
        const id = r.params[0] ?? "";
        const suspendu = r.corps.suspended === true;
        if (!suspendre(e, id, suspendu)) return refus(404, "Serveur introuvable.");
        return { data: { serverId: id, suspended: suspendu, sessionsNotClosed: 0 } };
      },
    ],
    ["GET", /^\/api\/v1\/admin\/users$/, (e) => ({ data: e.comptes })],
    [
      "POST",
      /^\/api\/v1\/admin\/users\/([^/]+)\/suspend$/,
      (e, r) => {
        const c = e.comptes.find((x) => x.id === r.params[0]);
        if (!c) return refus(404, "Compte introuvable.");
        const suspendu = r.corps.suspended === true;
        c.suspendedAt = suspendu ? date() : null;
        c.suspensionReason = suspendu ? texte(r.corps.reason) : null;
        return { data: { email: c.email, revokedSessions: suspendu ? 1 : 0 } };
      },
    ],
    [
      "POST",
      /^\/api\/v1\/admin\/users\/([^/]+)\/revoke-sessions$/,
      () => ({ data: { revoked: 2 } }),
    ],
    ["GET", /^\/api\/v1\/admin\/incidents$/, (e) => ({ data: e.incidents })],
    [
      "POST",
      /^\/api\/v1\/admin\/incidents$/,
      (e, r) => {
        const incident = {
          id: `demo-inc-${maintenant()}`,
          title: texte(r.corps.title),
          state: "investigating" as IncidentState,
          impact: (texte(r.corps.impact) || "minor") as IncidentImpact,
          nodeIds: [],
          updates: [
            { state: "investigating" as IncidentState, body: texte(r.corps.body), at: date() },
          ],
          startedAt: date(),
          resolvedAt: null,
        };
        e.incidents = [incident, ...e.incidents];
        return { data: incident };
      },
    ],
    [
      "POST",
      /^\/api\/v1\/admin\/incidents\/([^/]+)\/updates$/,
      (e, r) => {
        const i = e.incidents.find((x) => x.id === r.params[0]);
        if (!i) return refus(404, "Incident introuvable.");
        if (i.resolvedAt) return refus(400, "Incident clos.");
        const state = texte(r.corps.state) as IncidentState;
        i.state = state;
        i.updates = [...i.updates, { state, body: texte(r.corps.body), at: date() }];
        i.resolvedAt = state === "resolved" ? date() : null;
        return { data: i };
      },
    ],
    ["GET", /^\/api\/v1\/admin\/updates$/, (e) => ({ data: e.miseAJour })],
    [
      "POST",
      /^\/api\/v1\/admin\/updates\/check$/,
      (e) => {
        if (e.miseAJour.actif && e.miseAJour.derniereRelease) {
          const version = e.miseAJour.derniereRelease;
          e.miseAJour = {
            ...e.miseAJour,
            precedente: e.miseAJour.enService,
            version,
            enService: version,
            derniereVerification: date(),
            dernierResultat: { etat: "installee", version, date: date() },
          };
        }
        return { data: e.miseAJour };
      },
    ],
    [
      "GET",
      /^\/api\/v1\/admin\/activity$/,
      (e, r) => {
        const recherche = (r.query.get("query") ?? "").toLowerCase();
        const page = Math.max(1, Number(r.query.get("page")) || 1);
        const trouves = e.journal.filter((l) =>
          `${l.event} ${l.serverName ?? ""} ${l.actorLabel}`.toLowerCase().includes(recherche),
        );
        return {
          data: trouves.slice((page - 1) * 10, page * 10),
          meta: { page, hasMore: trouves.length > page * 10 },
        };
      },
    ],
  ];
}

/* --- Console ----------------------------------------------------------------- */

/**
 * Une socket de console qui parle comme le daemon : `auth success`, puis
 * l'historique, l'état et un relevé toutes les trois secondes.
 */
function socketDemo(etat: EtatDemo, ecoutes: Map<string, Set<Ecoute>>): typeof WebSocket {
  class SocketDemo {
    private readonly serverId: string;
    private readonly auditeurs = new Map<string, Set<(evenement: unknown) => void>>();
    private minuterie: ReturnType<typeof setInterval> | null = null;
    private readonly ecoute: Ecoute;

    constructor(url: string) {
      this.serverId = url.split("/").pop() ?? "";
      this.ecoute = (evenement, args) => this.emettre(evenement, args);
      setTimeout(() => this.signaler("open", {}), 0);
    }

    addEventListener(type: string, auditeur: (evenement: unknown) => void) {
      const liste = this.auditeurs.get(type) ?? new Set();
      liste.add(auditeur);
      this.auditeurs.set(type, liste);
    }

    removeEventListener(type: string, auditeur: (evenement: unknown) => void) {
      this.auditeurs.get(type)?.delete(auditeur);
    }

    send(brut: string) {
      const message = JSON.parse(brut) as { event?: string };
      if (message.event === "auth") this.emettre("auth success", []);
      if (message.event !== "send logs") return;
      const liste = ecoutes.get(this.serverId) ?? new Set();
      liste.add(this.ecoute);
      ecoutes.set(this.serverId, liste);
      const serveur = etat.serveurs.find((s) => s.id === this.serverId);
      this.emettre("console output", etat.consoles[this.serverId] ?? []);
      this.emettre("status", [serveur?.runtimeState ?? "offline"]);
      this.minuterie = setInterval(() => this.releve(), 3000);
      this.releve();
    }

    close() {
      if (this.minuterie) clearInterval(this.minuterie);
      ecoutes.get(this.serverId)?.delete(this.ecoute);
      this.signaler("close", {});
    }

    private releve() {
      const serveur = etat.serveurs.find((s) => s.id === this.serverId);
      if (serveur?.runtimeState !== "running") return;
      const memoire = (serveur.memoryMb ?? 1800) + Math.round(Math.random() * 120);
      const stats = {
        cpu_absolute: 20 + Math.random() * 30,
        memory_bytes: memoire * 1024 * 1024,
        memory_limit_bytes: serveur.memoryMaxMb * 1024 * 1024,
        disk_bytes: (serveur.diskMb ?? 0) * 1024 * 1024,
        uptime: 4_200_000,
      };
      this.emettre("stats", [JSON.stringify(stats)]);
    }

    private emettre(evenement: string, args: string[]) {
      this.signaler("message", { data: JSON.stringify({ event: evenement, args }) });
    }

    private signaler(type: string, evenement: unknown) {
      for (const auditeur of this.auditeurs.get(type) ?? []) auditeur(evenement);
    }
  }
  return SocketDemo as unknown as typeof WebSocket;
}
