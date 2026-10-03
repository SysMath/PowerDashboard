import type { PlayerAction } from "./player-commands";

/*
 * Ce que l'espace client de l'API rend, tel que ses deux clients le lisent :
 * l'interface web et l'application mobile (ADR 0010). Une seule définition,
 * pour qu'un champ renommé côté API casse les deux à la compilation plutôt
 * que l'un des deux en silence.
 */

/** Un serveur, dans la liste et dans le détail (`GET /api/v1/client/servers[/:id]`). */
export interface ClientServerView {
  id: string;
  shortId: string;
  name: string;
  description: string | null;
  address: string;
  nodeName: string;
  /** Depuis quand la machine ne répond plus. `null` quand elle répond. */
  nodeUnreachableSince: string | null;
  game: string;
  memoryMaxMb: number;
  diskMaxMb: number;
  cpuMaxPct: number;
  state: string | null;
  /** État du conteneur au dernier relevé, distinct de l'état de gestion. */
  runtimeState: string | null;
  /** Consommation au dernier relevé. `null` veut dire « pas mesuré », pas zéro. */
  cpuPct: number | null;
  memoryMb: number | null;
  diskMb: number | null;
  /** Dernière sonde de jeu. `null` veut dire « pas mesuré », jamais zéro. */
  players: number | null;
  maxPlayers: number | null;
  isOwner: boolean;
  /**
   * La machine offre les instantanés (ADR 0009). Rendu par le détail d'un
   * serveur seulement, jamais par la liste.
   */
  snapshots?: boolean;
}

/** Une notification de la cloche (`GET /api/v1/client/notifications`). */
export interface ClientNotificationView {
  id: string;
  title: string;
  body: string;
  level: "info" | "success" | "warning" | "danger";
  /** Nom du serveur concerné, ou `null` quand la notification n'en vise aucun. */
  source: string | null;
  /** Où mène la notification, ou `null` quand il n'y a rien à ouvrir. */
  href: string | null;
  createdAt: string;
  readAt: string | null;
}

/** La page Joueurs (`GET /api/v1/client/servers/:id/players`). */
export interface ClientPlayersView {
  online: number | null;
  max: number | null;
  /** Échantillon : Minecraft n'en donne qu'une douzaine au plus. */
  sample: string[] | null;
  complete: boolean;
  observedAt: string | null;
  actions: PlayerAction[];
}

/** Autorisation d'ouvrir la console chez le daemon : dix minutes, ce serveur seul. */
export interface ConsoleGrant {
  token: string;
  socket: string;
}

/** Une sauvegarde (`GET /api/v1/client/servers/:id/backups`). */
export interface ClientBackupView {
  id: string;
  name: string;
  bytes: number;
  checksum: string | null;
  /** `null` = en cours. Ni réussie, ni ratée : on ne sait pas encore. */
  isSuccessful: boolean | null;
  isLocked: boolean;
  createdAt: string;
  completedAt: string | null;
  /** `snapshot` : archivée par l'agent depuis un instantané, donc cohérente. */
  source?: "wings" | "snapshot";
}

/** Les sauvegardes d'un serveur et son quota (`meta` de la même route). */
export interface ClientBackupList {
  items: ClientBackupView[];
  used: number;
  limit: number;
}

/**
 * Une entrée de dossier, telle que Wings la rend et que l'API la relaie
 * (`GET /api/v1/client/servers/:id/files`). Wings ne garantit aucun tri.
 */
export interface ClientFileEntryView {
  name: string;
  mode: string;
  size: number;
  directory: boolean;
  file: boolean;
  symlink: boolean;
  mime: string;
  modified: string;
}

/**
 * Autorisation de déposer des fichiers chez le daemon : une adresse et un
 * jeton à usage unique, quinze minutes, ce serveur seul. Le dépôt part en
 * `multipart/form-data`, champ `files`, vers `url?token=…&directory=…`.
 */
export interface UploadGrant {
  token: string;
  url: string;
}
