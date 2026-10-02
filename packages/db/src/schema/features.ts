import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { id, moment, timestamps } from "../columns";
import { backupDisk, marketplaceSource, scheduleAction } from "./enums";
import { users } from "./identity";
import { nodes } from "./infrastructure";
import { servers } from "./servers";

/** §6.5 — Fonctionnalités serveur. */

export const backups = pgTable(
  "backups",
  {
    id: id(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 120 }).notNull(),
    ignoredFiles: text("ignored_files").array().notNull().default([]),
    disk: backupDisk("disk").notNull().default("local"),
    checksum: varchar("checksum", { length: 128 }),
    /*
     * `bigint`, comme les mesures de `server_stats` : le plafond d'un
     * `integer` est 2 Gio, qu'un monde ordinaire dépasse. Le compte rendu d'une
     * archive plus grosse échouait en base, et Wings, faute d'accusé de
     * réception, **effaçait l'archive** — la sauvegarde restait « en cours »,
     * sans rien derrière.
     */
    bytes: bigint("bytes", { mode: "number" }).notNull().default(0),
    /**
     * Nul tant que la sauvegarde est en cours. Un booléen à `false` par défaut
     * ferait passer une sauvegarde en cours pour une sauvegarde ratée.
     */
    isSuccessful: boolean("is_successful"),
    /**
     * Identifiant du téléversement fractionné en cours, côté S3.
     *
     * Nul pour une sauvegarde locale, et pour une sauvegarde distante déjà
     * close : la colonne dit « un dépôt est en cours », pas « cette sauvegarde
     * est distante » — ce que `disk` dit déjà.
     */
    uploadId: text("upload_id"),
    /** Une sauvegarde verrouillée échappe à la rotation de rétention. */
    isLocked: boolean("is_locked").notNull().default(false),
    /**
     * Qui fait l'archive (ADR 0009) : `wings`, depuis le dossier vivant, ou
     * `snapshot`, l'agent de node depuis un instantané, donc cohérente. Le
     * format est le même et la restauration passe toujours par Wings.
     */
    source: varchar("source", { length: 10 }).notNull().default("wings"),
    /** L'instantané d'où l'agent a tiré l'archive. */
    snapshotName: varchar("snapshot_name", { length: 32 }),
    completedAt: moment("completed_at"),
    expiresAt: moment("expires_at"),
    ...timestamps,
  },
  (table) => [index("backup_server_idx").on(table.serverId)],
);

/*
 * Il y avait ici `backup_schedules` : un second moyen de planifier des
 * sauvegardes, avec sa propre expression cron, sa rétention et sa liste
 * d'exclusions. Vide depuis le premier jour, retirée en 0029.
 *
 * `schedules` le fait déjà, par une tâche d'action « backup ». Deux mécanismes
 * pour la même chose, dont un seul tourne — et celui qui ne tournait pas était
 * le mieux doté sur le papier, ce qui est la façon la plus sûre de faire perdre
 * une heure à qui arrive après.
 */

export const databaseHosts = pgTable("database_hosts", {
  id: id(),
  name: varchar("name", { length: 100 }).notNull(),
  host: varchar("host", { length: 255 }).notNull(),
  port: integer("port").notNull().default(3306),
  username: varchar("username", { length: 100 }).notNull(),
  passwordEnc: text("password_enc").notNull(),
  /** Restreint le host à un node, quand il vit sur la même machine. */
  nodeId: uuid("node_id").references(() => nodes.id, { onDelete: "set null" }),
  maxDatabases: integer("max_databases"),
  ...timestamps,
});

export const databases = pgTable(
  "databases",
  {
    id: id(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    databaseHostId: uuid("database_host_id")
      .notNull()
      .references(() => databaseHosts.id, { onDelete: "restrict" }),
    name: varchar("name", { length: 120 }).notNull(),
    username: varchar("username", { length: 100 }).notNull(),
    /**
     * Chiffré, et non haché : contrairement à un mot de passe de connexion au
     * panel, celui-ci doit pouvoir être réaffiché au client qui l'a perdu.
     */
    passwordEnc: text("password_enc").notNull(),
    remote: varchar("remote", { length: 255 }).notNull().default("%"),
    maxConnections: integer("max_connections"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("database_host_name_unique").on(table.databaseHostId, table.name),
    index("database_server_idx").on(table.serverId),
  ],
);

export const schedules = pgTable(
  "schedules",
  {
    id: id(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 120 }).notNull(),
    cronMinute: varchar("cron_minute", { length: 40 }).notNull().default("*"),
    cronHour: varchar("cron_hour", { length: 40 }).notNull().default("*"),
    cronDayOfMonth: varchar("cron_dom", { length: 40 }).notNull().default("*"),
    cronMonth: varchar("cron_month", { length: 40 }).notNull().default("*"),
    cronDayOfWeek: varchar("cron_dow", { length: 40 }).notNull().default("*"),
    isActive: boolean("is_active").notNull().default(true),
    /** Évite qu'une tâche récurrente redémarre en boucle un serveur arrêté volontairement. */
    onlyWhenOnline: boolean("only_when_online").notNull().default(true),
    lastRunAt: moment("last_run_at"),
    /**
     * Cause de l'échec de la dernière exécution, `null` si elle a réussi.
     *
     * Sans cette colonne, une planification qui échoue le fait **en silence et
     * pour toujours** : la cause partait dans le journal applicatif, que le
     * client ne lit pas et ne peut pas lire. Il continuait à croire que ses
     * sauvegardes se faisaient.
     */
    lastRunFailure: text("last_run_failure"),
    /**
     * Quand le propriétaire a été prévenu du dérangement en cours.
     *
     * Posée à la première exécution ratée, effacée au premier succès. Une
     * planification cassée échoue à chaque tour : sans cette borne, une tâche
     * horaire enverrait vingt-quatre messages par jour, et la vingt-cinquième
     * personne à les recevoir aurait coupé les notifications.
     */
    failureNotifiedAt: moment("failure_notified_at"),
    nextRunAt: moment("next_run_at"),
    ...timestamps,
  },
  (table) => [
    index("schedule_server_idx").on(table.serverId),
    // Le planificateur balaye par échéance : sans cet index il lirait toute
    // la table à chaque tick.
    index("schedule_next_run_idx").on(table.nextRunAt).where(sql`is_active`),
  ],
);

export const scheduleTasks = pgTable(
  "schedule_tasks",
  {
    id: id(),
    scheduleId: uuid("schedule_id")
      .notNull()
      .references(() => schedules.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    action: scheduleAction("action").notNull(),
    payload: text("payload").notNull().default(""),
    /** Délai en secondes avant l'exécution, une fois la tâche précédente terminée. */
    timeOffset: integer("time_offset").notNull().default(0),
    continueOnFailure: boolean("continue_on_failure").notNull().default(false),
    ...timestamps,
  },
  (table) => [uniqueIndex("schedule_task_sequence_unique").on(table.scheduleId, table.sequence)],
);

export const mounts = pgTable("mounts", {
  id: id(),
  name: varchar("name", { length: 120 }).notNull(),
  source: text("source").notNull(),
  target: text("target").notNull(),
  readOnly: boolean("read_only").notNull().default(true),
  /** Un montage non « user_mountable » ne peut être attaché que par un administrateur. */
  userMountable: boolean("user_mountable").notNull().default(false),
  ...timestamps,
});

export const serverMounts = pgTable(
  "server_mounts",
  {
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    mountId: uuid("mount_id")
      .notNull()
      .references(() => mounts.id, { onDelete: "cascade" }),
  },
  (table) => [uniqueIndex("server_mount_unique").on(table.serverId, table.mountId)],
);

/** Ce que le marketplace a effectivement déposé dans le conteneur (§10). */
export const marketplaceInstalls = pgTable(
  "marketplace_installs",
  {
    id: id(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    source: marketplaceSource("source").notNull(),
    projectId: varchar("project_id", { length: 120 }).notNull(),
    versionId: varchar("version_id", { length: 120 }).notNull(),
    /**
     * Les fichiers réellement écrits, pour pouvoir désinstaller. Sans cette
     * trace, retirer un plugin reviendrait à deviner son nom de fichier.
     */
    installedFiles: text("installed_files").array().notNull().default([]),
    installedBy: uuid("installed_by").references(() => users.id, { onDelete: "set null" }),
    installedAt: moment("installed_at").notNull(),
    /**
     * Nom du projet au moment de l'installation, pour lister ce qui est
     * installé sans interroger les catalogues à chaque affichage.
     */
    name: varchar("name", { length: 200 }).notNull().default(""),
    /**
     * Publication compatible plus récente que celle installée, relevée par la
     * veille des mises à jour. `null` : à jour, ou pas encore vérifié.
     */
    latestVersion: varchar("latest_version", { length: 120 }),
    /** Dernière vérification aboutie auprès du catalogue. */
    checkedAt: moment("checked_at"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("marketplace_install_unique").on(table.serverId, table.source, table.projectId),
  ],
);

/**
 * Le moteur que le panel a posé sur un serveur : plateforme ou modpack (§10.2).
 *
 * Une ligne par serveur au plus, remplacée à chaque installation, **effacée**
 * quand le daemon rend compte d'une réinstallation réussie : ce qui tourne
 * alors est ce que le script de l'egg a posé, que le panel ne connaît pas.
 * Sans elle, l'écran du moteur ne pouvait dire ni ce qui était installé, ni
 * qu'une version plus récente d'un modpack existait.
 */
export const serverEngines = pgTable("server_engines", {
  serverId: uuid("server_id")
    .primaryKey()
    .references(() => servers.id, { onDelete: "cascade" }),
  /** `jar` (une plateforme) ou `pack` (un modpack). */
  kind: varchar("kind", { length: 8 }).notNull(),
  /** Identifiant de l'option telle que l'écran la propose : `paper:paper`, `modpack:…`. */
  optionId: varchar("option_id", { length: 160 }).notNull(),
  label: varchar("label", { length: 200 }).notNull(),
  versionId: varchar("version_id", { length: 120 }).notNull(),
  versionLabel: varchar("version_label", { length: 200 }).notNull(),
  /** Date de publication de la version, pour ne proposer que plus récent. */
  versionPublishedAt: moment("version_published_at"),
  gameVersion: varchar("game_version", { length: 40 }).notNull().default(""),
  /** Chargeur demandé par le pack (« fabric 0.16.10 »), s'il le dit. */
  loader: varchar("loader", { length: 80 }),
  packSource: marketplaceSource("pack_source"),
  packProjectId: varchar("pack_project_id", { length: 120 }),
  /**
   * Fichiers posés par le pack, avec l'empreinte relevée juste après (taille et
   * date de modification) : une mise à jour retire ou remplace ce que le pack a
   * posé, et garde ce que l'utilisateur a modifié depuis.
   */
  files: jsonb("files").$type<Record<string, string>>().notNull().default({}),
  /** Version plus récente et compatible relevée par la veille ; nulle : à jour ou pas vérifié. */
  latestVersionId: varchar("latest_version_id", { length: 120 }),
  latestVersionLabel: varchar("latest_version_label", { length: 200 }),
  checkedAt: moment("checked_at"),
  installedBy: uuid("installed_by").references(() => users.id, { onDelete: "set null" }),
  installedAt: moment("installed_at").notNull(),
  ...timestamps,
});

/**
 * La dernière installation de moteur lancée sur un serveur, et son sort.
 *
 * Une installation de modpack enchaîne des centaines de téléchargements et
 * peut attendre une demi-heure une sauvegarde préalable : aucune requête HTTP
 * ne tient jusque-là (échéance de l'interface, du vhost, de Passenger). Elle
 * part donc en tâche de fond, et c'est cette ligne qui porte son état jusqu'à
 * l'écran : `running`, puis `done` avec son compte rendu, ou `failed` avec sa
 * raison.
 *
 * Une ligne par serveur, remplacée à chaque lancement : c'est aussi le verrou
 * qui interdit deux installations à la fois. Une ligne restée `running` après
 * un redémarrage de l'API est close en échec au démarrage suivant, sans quoi
 * le serveur resterait bloqué pour toujours.
 */
export const serverEngineInstalls = pgTable("server_engine_installs", {
  serverId: uuid("server_id")
    .primaryKey()
    .references(() => servers.id, { onDelete: "cascade" }),
  /** `running`, `done` ou `failed`. */
  status: varchar("status", { length: 8 }).notNull(),
  optionId: varchar("option_id", { length: 160 }).notNull(),
  versionId: varchar("version_id", { length: 120 }).notNull(),
  /** Ce qui est installé, lisible (« Pack 1.2 », « Paper 1.21.1 »). */
  label: varchar("label", { length: 200 }).notNull(),
  /** Compte rendu d'une installation terminée (fichiers posés, manquants, gardés…). */
  report: jsonb("report").$type<Record<string, unknown>>(),
  /** Raison d'un échec, en clair. */
  error: varchar("error", { length: 1000 }),
  startedBy: uuid("started_by").references(() => users.id, { onDelete: "set null" }),
  startedAt: moment("started_at").notNull(),
  finishedAt: moment("finished_at"),
});

/**
 * Instantanés de volumes (ADR 0009) : réglages et état de la fonction sur un
 * node. Une ligne par node qui a déjà parlé ou été réglé.
 */
export const nodeSnapshots = pgTable("node_snapshots", {
  nodeId: uuid("node_id")
    .primaryKey()
    .references(() => nodes.id, { onDelete: "cascade" }),
  /** `SnapshotPolicy` ; nul : les valeurs par défaut de la plateforme. */
  policy: jsonb("policy"),
  /** `btrfs`, `zfs`, ou nul quand l'agent ne peut pas en prendre. */
  filesystem: varchar("filesystem", { length: 8 }),
  /** La raison, dite par l'agent, quand il ne peut pas en prendre. */
  reason: text("reason"),
  totalBytes: bigint("total_bytes", { mode: "number" }),
  freeBytes: bigint("free_bytes", { mode: "number" }),
  /** Sous le seuil d'espace libre : l'agent ne prend plus rien. */
  suspended: boolean("suspended").notNull().default(false),
  reportedAt: moment("reported_at"),
  ...timestamps,
});

/**
 * Registre des instantanés d'un node, tenu d'après les rapports de l'agent.
 *
 * L'agent fait foi : un nom qu'il ne rapporte plus est marqué disparu
 * (`gone_at`), jamais supprimé, pour que le journal garde de quoi le nommer.
 */
export const volumeSnapshots = pgTable(
  "volume_snapshots",
  {
    id: id(),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    /** `gd-AAAAMMJJTHHMMSS.mmmZ`, tiré par l'agent. */
    name: varchar("name", { length: 32 }).notNull(),
    takenAt: moment("taken_at").notNull(),
    /** `auto`, `manual` ou `safety`. */
    cause: varchar("cause", { length: 10 }).notNull().default("auto"),
    /** Serveurs (identifiants Wings) présents dans l'instantané. */
    servers: uuid("servers").array().notNull().default([]),
    /** Nul quand le système ne le dit pas (btrfs sans quotas). */
    bytes: bigint("bytes", { mode: "number" }),
    /** Le serveur pour lequel il a été demandé (manuel, de sûreté). */
    serverId: uuid("server_id").references(() => servers.id, { onDelete: "set null" }),
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    goneAt: moment("gone_at"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("volume_snapshot_node_name_unique").on(table.nodeId, table.name),
    index("volume_snapshot_node_taken_idx").on(table.nodeId, table.takenAt),
  ],
);

/** Un épinglage : l'instantané échappe à la rotation, jamais à la durée maximale. */
export const volumeSnapshotPins = pgTable(
  "volume_snapshot_pins",
  {
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => volumeSnapshots.id, { onDelete: "cascade" }),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    label: varchar("label", { length: 80 }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("volume_snapshot_pin_unique").on(table.snapshotId, table.serverId),
    index("volume_snapshot_pin_server_idx").on(table.serverId),
  ],
);

/**
 * Ordres donnés à l'agent, tirés par lui au relevé suivant.
 *
 * Des données, jamais des commandes : un type fermé, un serveur, un nom
 * d'instantané. `pending` tant que l'agent n'a pas rendu compte ; un ordre
 * resté sans réponse est clos en échec (`SnapshotOrdersService`).
 */
export const snapshotOrders = pgTable(
  "snapshot_orders",
  {
    id: id(),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    /** `prendre`, `restaurer`, `detruire` ou `archiver`. */
    kind: varchar("kind", { length: 12 }).notNull(),
    /** Cause de l'instantané qu'une prise produira (`manual`, `safety`). */
    cause: varchar("cause", { length: 10 }),
    serverId: uuid("server_id").references(() => servers.id, { onDelete: "cascade" }),
    snapshotName: varchar("snapshot_name", { length: 32 }),
    /**
     * `pending` (envoyé à l'agent), `waiting` (restauration qui attend l'arrêt
     * du serveur, pas encore envoyée), `done` ou `failed`.
     */
    state: varchar("state", { length: 10 }).notNull().default("pending"),
    /** Instantané pris ou réutilisé, rendu par l'agent. */
    result: varchar("result", { length: 32 }),
    error: text("error"),
    /** La sauvegarde qu'un ordre `archiver` produit. */
    backupId: uuid("backup_id").references(() => backups.id, { onDelete: "cascade" }),
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    completedAt: moment("completed_at"),
    ...timestamps,
  },
  (table) => [
    index("snapshot_order_backup_idx").on(table.backupId),
    index("snapshot_order_node_state_idx").on(table.nodeId, table.state),
    index("snapshot_order_server_idx").on(table.serverId, table.createdAt),
  ],
);
