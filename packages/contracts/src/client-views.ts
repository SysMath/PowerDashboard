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
