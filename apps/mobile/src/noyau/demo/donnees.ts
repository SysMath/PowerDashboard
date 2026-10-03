import type {
  AdminActivityEntry,
  AdminIncident,
  AdminNode,
  AdminServer,
  AdminUser,
  ClientBackupView,
  ClientFileEntryView,
  ClientNotificationView,
  ClientServerView,
  ResellerOverview,
  UpdateStatus,
} from "@gamedashboard/contracts";

/*
 * Les données fictives du mode démo (vérificateurs d'Apple et de Google,
 * curieux sans panel). Aucune marque d'autrui : les jeux portent des noms
 * génériques. Les rares textes libres existent en français et en anglais.
 */

export type Langue = "fr" | "en";

export interface EtatDemo {
  serveurs: ClientServerView[];
  sauvegardes: Record<string, ClientBackupView[]>;
  /** Contenu de chaque dossier, par chemin absolu (« / », « /logs »). */
  dossiers: Record<string, ClientFileEntryView[]>;
  /** Contenu des fichiers texte, par chemin absolu. */
  textes: Record<string, string>;
  notifications: ClientNotificationView[];
  revendeur: ResellerOverview;
  noeuds: AdminNode[];
  parc: AdminServer[];
  comptes: AdminUser[];
  incidents: AdminIncident[];
  journal: AdminActivityEntry[];
  miseAJour: UpdateStatus;
  /** Lignes de console de chaque serveur, les plus anciennes d'abord. */
  consoles: Record<string, string[]>;
  langue: Langue;
}

const MO = 1024 * 1024;

const TEXTES = {
  fr: {
    sauvegardeTerminee: ["Sauvegarde terminée", "La sauvegarde quotidienne d'Aurora est prête."],
    serveurArrete: ["Serveur arrêté", "Nebula s'est arrêté : aucun joueur depuis une heure."],
    miseAJour: ["Mise à jour disponible", "Une nouvelle version du panel est parue."],
    incident: "Lenteurs sur la machine Lyon-2",
    incidentCorps: "Des lenteurs sont signalées sur Lyon-2. Nous cherchons la cause.",
    commande: "Commande reçue",
  },
  en: {
    sauvegardeTerminee: ["Backup finished", "Aurora's daily backup is ready."],
    serveurArrete: ["Server stopped", "Nebula stopped: no player for an hour."],
    miseAJour: ["Update available", "A new panel version is out."],
    incident: "Slowness on the Lyon-2 machine",
    incidentCorps: "Slowness is reported on Lyon-2. We are looking into it.",
    commande: "Command received",
  },
} as const;

export const texteDemo = (langue: Langue) => TEXTES[langue];

const serveur = (
  id: string,
  name: string,
  game: string,
  runtimeState: string,
  players: number | null,
  memoryMb: number | null,
): ClientServerView => ({
  id,
  shortId: id.slice(0, 8),
  name,
  description: null,
  address: `play.exemple.invalid:${25565 + Number(id.slice(-1))}`,
  nodeName: "Paris-1",
  nodeUnreachableSince: null,
  game,
  memoryMaxMb: 4096,
  diskMaxMb: 20480,
  cpuMaxPct: 200,
  state: null,
  runtimeState,
  cpuPct: runtimeState === "running" ? 34 : null,
  memoryMb,
  diskMb: 5210,
  players,
  maxPlayers: 20,
  isOwner: true,
});

const entree = (
  name: string,
  directory: boolean,
  size: number,
  modified: string,
  mime = directory ? "inode/directory" : "text/plain",
): ClientFileEntryView => ({
  name,
  mode: directory ? "drwxr-xr-x" : "-rw-r--r--",
  size,
  directory,
  file: !directory,
  symlink: false,
  mime,
  modified,
});

/** Un état neuf, daté de `maintenant`. Chaque ouverture de la démo repart de lui. */
export function etatInitial(maintenant: number, langue: Langue): EtatDemo {
  const il = (minutes: number) => new Date(maintenant - minutes * 60_000).toISOString();
  const t = TEXTES[langue];
  const serveurs = [
    serveur("demo-srv-1", "Aurora", "Sandbox", "running", 7, 2900),
    serveur("demo-srv-2", "Nebula", "Survival", "offline", null, null),
    serveur("demo-srv-3", "Atlas", "Racing", "running", 2, 1350),
  ];
  const sauvegarde = (id: string, name: string, minutes: number, verrou = false) => ({
    id,
    name,
    bytes: 412 * MO,
    checksum: null,
    isSuccessful: true,
    isLocked: verrou,
    createdAt: il(minutes),
    completedAt: il(minutes - 2),
  });
  const proprietaire = (nom: string, email: string) => ({ owner: nom, ownerEmail: email });
  const parc: AdminServer[] = [
    ...serveurs.map((s) => ({
      id: s.id,
      shortId: s.shortId,
      name: s.name,
      ...proprietaire("Demo User", "demo@exemple.invalid"),
      node: "Paris-1",
      egg: s.game,
      state: null,
      runtimeState: s.runtimeState,
      memoryMb: s.memoryMaxMb,
      createdAt: il(60 * 24 * 40),
    })),
    {
      id: "demo-srv-4",
      shortId: "demo-srv",
      name: "Orion",
      ...proprietaire("Camille Martin", "camille@exemple.invalid"),
      node: "Lyon-2",
      egg: "Sandbox",
      state: "install_failed",
      runtimeState: null,
      memoryMb: 2048,
      createdAt: il(90),
    },
    {
      id: "demo-srv-5",
      shortId: "demo-srv",
      name: "Vega",
      ...proprietaire("Lucas Bernard", "lucas@exemple.invalid"),
      node: "Lyon-2",
      egg: "Survival",
      state: null,
      runtimeState: "running",
      memoryMb: 3072,
      createdAt: il(60 * 24 * 12),
    },
  ];
  const noeud = (name: string, location: string, battement: number, servers: number) => ({
    id: `demo-node-${name}`,
    name,
    category: null,
    subcategory: null,
    location,
    fqdn: `${name.toLowerCase()}.exemple.invalid`,
    memoryMb: 32768,
    diskMb: 512000,
    cpuCores: 8,
    maintenance: false,
    wingsVersion: "v1.13.3",
    lastHeartbeatAt: il(battement),
    ownerId: null,
    ownerName: null,
    servers,
    allocatedMemoryMb: servers * 3072,
    allocatedDiskMb: servers * 20480,
    measuredMemoryMb: servers * 2100,
    measuredDiskMb: servers * 6000,
    measuredServers: servers,
  });
  const compte = (
    id: string,
    prenom: string,
    nom: string,
    email: string,
    role: AdminUser["role"],
    servers: number,
  ): AdminUser => ({
    id,
    name: `${prenom} ${nom}`,
    nameFirst: prenom,
    nameLast: nom,
    email,
    emailVerifiedAt: il(60 * 24 * 30),
    locale: langue,
    suspendedAt: null,
    suspensionReason: null,
    role,
    is2faEnabled: role !== "user",
    allowsPlatformProvisioning: false,
    lastLoginAt: il(45),
    servers,
    platformAccess: "provision",
    quotaMemoryMb: null,
    quotaDiskMb: null,
    quotaServersMax: null,
  });
  const journal: AdminActivityEntry[] = Array.from({ length: 24 }, (_, rang) => {
    const evenements = ["server.power", "backup.create", "account.login", "server.command"];
    const event = evenements[rang % evenements.length] ?? "account.login";
    const cible = serveurs[rang % serveurs.length];
    return {
      id: `demo-act-${rang}`,
      event,
      actorLabel: "demo@exemple.invalid",
      actorType: "user",
      actorId: "demo-user-1",
      ip: null,
      properties: {},
      serverId: event === "account.login" ? null : (cible?.id ?? null),
      serverName: event === "account.login" ? null : (cible?.name ?? null),
      at: il(rang * 37 + 5),
    };
  });

  return {
    serveurs,
    sauvegardes: {
      "demo-srv-1": [
        sauvegarde("demo-bkp-1", "daily-2", 60 * 3),
        sauvegarde("demo-bkp-2", "daily-1", 60 * 27),
        sauvegarde("demo-bkp-3", "before-update", 60 * 24 * 6, true),
      ],
      "demo-srv-2": [sauvegarde("demo-bkp-4", "weekly", 60 * 24 * 2)],
      "demo-srv-3": [],
    },
    dossiers: {
      "/": [
        entree("logs", true, 0, il(5)),
        entree("plugins", true, 0, il(60 * 24)),
        entree("world", true, 0, il(5)),
        entree("server.properties", false, 1180, il(60 * 24 * 3)),
        entree("old-world.tar.gz", false, 96 * MO, il(60 * 24 * 9), "application/gzip"),
      ],
      "/logs": [entree("latest.log", false, 18_400, il(1))],
      "/plugins": [entree("config.yml", false, 640, il(60 * 24))],
      "/world": [entree("level.dat", false, 5_200, il(5), "application/octet-stream")],
    },
    textes: {
      "/server.properties": "motd=Aurora\nmax-players=20\ndifficulty=normal\npvp=true\n",
      "/logs/latest.log": "[12:00:00] Server started\n[12:04:12] Player joined\n",
      "/plugins/config.yml": "welcome: true\nspawn-protection: 16\n",
    },
    notifications: [
      {
        id: "demo-not-1",
        title: t.sauvegardeTerminee[0],
        body: t.sauvegardeTerminee[1],
        level: "success",
        source: "backup",
        href: null,
        createdAt: il(180),
        readAt: null,
      },
      {
        id: "demo-not-2",
        title: t.serveurArrete[0],
        body: t.serveurArrete[1],
        level: "warning",
        source: "server",
        href: null,
        createdAt: il(60 * 5),
        readAt: null,
      },
      {
        id: "demo-not-3",
        title: t.miseAJour[0],
        body: t.miseAJour[1],
        level: "info",
        source: null,
        href: null,
        createdAt: il(60 * 24 * 2),
        readAt: il(60 * 24),
      },
    ],
    revendeur: {
      nodes: [],
      servers: parc
        .filter((s) => s.id !== "demo-srv-4")
        .map((s) => ({
          id: s.id,
          shortId: s.shortId,
          name: s.name,
          owner: s.owner,
          ownerEmail: s.ownerEmail,
          node: s.node,
          egg: s.egg,
          state: s.state,
          memoryMb: s.memoryMb,
          diskMb: 20480,
          cpuPct: 200,
          swapMb: 0,
          backupLimit: 5,
          databaseLimit: 2,
          allocationLimit: 3,
          createdAt: s.createdAt,
        })),
      clients: [
        {
          id: "demo-user-1",
          name: "Demo User",
          email: "demo@exemple.invalid",
          servers: 3,
          memoryMb: 12288,
        },
        {
          id: "demo-user-3",
          name: "Lucas Bernard",
          email: "lucas@exemple.invalid",
          servers: 1,
          memoryMb: 3072,
        },
      ],
      platformAccess: "provision",
      quota: {
        quota: { memoryMb: 24576, diskMb: 204800, serversMax: 6 },
        usage: { memoryMb: 15360, diskMb: 81920, servers: 4, basis: "measured", unmeasured: 0 },
      },
    },
    noeuds: [noeud("Paris-1", "Paris", 0.1, 3), noeud("Lyon-2", "Lyon", 12, 2)],
    parc,
    comptes: [
      compte("demo-user-0", "Alex", "Admin", "alex@exemple.invalid", "admin", 0),
      compte("demo-user-1", "Demo", "User", "demo@exemple.invalid", "reseller", 3),
      compte("demo-user-2", "Camille", "Martin", "camille@exemple.invalid", "user", 1),
      compte("demo-user-3", "Lucas", "Bernard", "lucas@exemple.invalid", "user", 1),
      compte("demo-user-4", "Sam", "Support", "sam@exemple.invalid", "support", 0),
    ],
    incidents: [
      {
        id: "demo-inc-1",
        title: t.incident,
        state: "investigating",
        impact: "minor",
        nodeIds: ["demo-node-Lyon-2"],
        updates: [{ state: "investigating", body: t.incidentCorps, at: il(10) }],
        startedAt: il(10),
        resolvedAt: null,
      },
    ],
    journal,
    miseAJour: {
      actif: true,
      version: "v1.4.0",
      enService: "v1.4.0",
      precedente: "v1.3.2",
      derniereVerification: il(12),
      derniereRelease: "v1.5.0",
      operation: null,
      dernierResultat: null,
      refusees: [],
    },
    consoles: Object.fromEntries(
      serveurs.map((s) => [
        s.id,
        s.runtimeState === "running"
          ? ["[12:00:00] Starting server", "[12:00:04] Done, ready for players"]
          : ["[11:02:51] Server stopped"],
      ]),
    ),
    langue,
  };
}
