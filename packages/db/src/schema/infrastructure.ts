import { relations, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  bigint,
  boolean,
  char,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { id, moment, timestamps } from "../columns";
import { users } from "./identity";
import { servers } from "./servers";

/** §6.2 — Infrastructure. */

/**
 * Classement des nodes, premier niveau.
 *
 * `id` est un **slug choisi par l'administrateur**, et non une clé technique :
 * c'est lui qui est inscrit dans `nodes.category`. Ce n'est pas une clé
 * étrangère, et c'est délibéré — un node dont la catégorie a été supprimée doit
 * rester affichable, rangé dans « Non classé », plutôt que d'empêcher la
 * suppression ou de disparaître de la liste.
 *
 * Cette table déclare donc les classements **proposés** ; la valeur portée par
 * le node reste sa propre vérité.
 */
export const nodeCategories = pgTable(
  "node_categories",
  {
    id: varchar("id", { length: 60 }).primaryKey(),
    name: varchar("name", { length: 120 }).notNull(),
    description: text("description"),
    /** Rang d'affichage. L'ordre déclaré est celui qu'on relit dans le tableau. */
    position: integer("position").notNull().default(0),
    ...timestamps,
  },
  (table) => [index("node_category_position_idx").on(table.position)],
);

export const nodeSubcategories = pgTable(
  "node_subcategories",
  {
    id: varchar("id", { length: 60 }).primaryKey(),
    // `cascade` : une sous-catégorie n'a aucun sens sans sa catégorie, et la
    // laisser orpheline la ferait apparaître sous un intitulé vide.
    categoryId: varchar("category_id", { length: 60 })
      .notNull()
      .references(() => nodeCategories.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 120 }).notNull(),
    position: integer("position").notNull().default(0),
    ...timestamps,
  },
  (table) => [index("node_subcategory_category_idx").on(table.categoryId, table.position)],
);

/**
 * Part de capacité d'un revendeur sur une machine.
 *
 * Une machine peut porter **plusieurs** revendeurs : un dédié découpé en trois,
 * quatre, cinq tranches. C'est la raison d'être de cette table — `nodes.owner_id`
 * ne sait exprimer qu'un propriétaire unique, ce qui ne couvre que le cas du
 * VPS confié en entier.
 *
 * Les deux modes coexistent et se lisent sans ambiguïté :
 *
 * - `nodes.owner_id` renseigné : la machine entière est à ce revendeur, sa part
 *   est la capacité de la machine. Aucune ligne ici.
 * - des lignes ici : la machine est découpée, chaque revendeur tient sa part.
 * - ni l'un ni l'autre : machine de la plateforme.
 *
 * Les deux à la fois n'a pas de sens et est refusé côté service : une machine
 * entièrement à quelqu'un ne se découpe pas.
 */
export const nodeResellerShares = pgTable(
  "node_reseller_shares",
  {
    id: id(),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    // `restrict` : supprimer un compte revendeur qui tient encore une part
    // laisserait une tranche de machine sans titulaire, invisible et réservée.
    resellerId: uuid("reseller_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    /**
     * Plafond de mémoire de cette part, en mégaoctets.
     *
     * C'est un plafond sur la mémoire **réellement consommée**, et non sur la
     * somme des limites accordées aux serveurs. Un revendeur peut donc vendre
     * plus qu'il ne détient tant que ses clients n'utilisent pas tout — ce qui
     * est précisément le modèle économique de la revente.
     */
    memoryMb: integer("memory_mb").notNull(),
    diskMb: integer("disk_mb").notNull(),
    /** Nul : aucun plafond sur le nombre de serveurs de cette part. */
    serversMax: integer("servers_max"),
    ...timestamps,
  },
  (table) => [
    // Un revendeur n'a qu'une part par machine : deux lignes se cumuleraient
    // sans que personne sache laquelle fait foi.
    uniqueIndex("node_reseller_share_unique").on(table.nodeId, table.resellerId),
    index("node_reseller_share_reseller_idx").on(table.resellerId),
  ],
);

export const locations = pgTable(
  "locations",
  {
    id: id(),
    short: varchar("short", { length: 20 }).notNull(),
    long: varchar("long", { length: 120 }).notNull(),
    countryCode: char("country_code", { length: 2 }).notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex("location_short_unique").on(table.short)],
);

export const nodes = pgTable(
  "nodes",
  {
    id: id(),
    name: varchar("name", { length: 100 }).notNull(),
    locationId: uuid("location_id")
      .notNull()
      // Restrict et non cascade : supprimer une localisation ne doit pas
      // emporter les nodes qu'elle contient, donc les serveurs qui y tournent.
      .references(() => locations.id, { onDelete: "restrict" }),
    /**
     * Revendeur propriétaire du node, ou `null` pour un node de la plateforme.
     *
     * Un revendeur loue son propre matériel : il ne voit que ses nodes et n'y
     * provisionne que pour ses clients. `null` n'est donc pas « personne » mais
     * « la plateforme », ce qui est le cas de la grande majorité des nodes.
     *
     * `set null` à la suppression du compte plutôt que `cascade` : effacer un
     * revendeur ne doit pas emporter son matériel, donc les serveurs qui y
     * tournent. Le node revient à la plateforme, et quelqu'un décide ensuite.
     */
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    /** Classification à deux niveaux du panel (§10), indépendante de la localisation. */
    category: varchar("category", { length: 60 }),
    subcategory: varchar("subcategory", { length: 60 }),
    fqdn: varchar("fqdn", { length: 255 }).notNull(),
    scheme: varchar("scheme", { length: 5 }).notNull().default("https"),
    daemonPort: integer("daemon_port").notNull().default(8080),
    daemonSftpPort: integer("daemon_sftp_port").notNull().default(2022),

    memoryMb: integer("memory_mb").notNull(),
    memoryOverallocate: integer("memory_overallocate").notNull().default(0),
    diskMb: integer("disk_mb").notNull(),
    diskOverallocate: integer("disk_overallocate").notNull().default(0),
    cpuCores: real("cpu_cores").notNull(),

    public: boolean("public").notNull().default(true),
    maintenanceMode: boolean("maintenance_mode").notNull().default(false),

    /**
     * Jeton d'authentification de Wings (§5.5).
     *
     * Wings n'accepte pas le mTLS : il s'authentifie auprès du panel par un
     * jeton statique, qui lui confère un pouvoir total sur le node. D'où trois
     * colonnes plutôt qu'une : l'identifiant permet de reconnaître le jeton
     * présenté sans le déchiffrer, le secret est chiffré au repos, et la date
     * de rotation rend visible un jeton qui traîne depuis trop longtemps.
     */
    daemonTokenId: varchar("daemon_token_id", { length: 32 }).notNull(),
    daemonTokenEnc: text("daemon_token_enc").notNull(),
    daemonTokenRotatedAt: moment("daemon_token_rotated_at").notNull(),

    /** Version rapportée par le daemon, comparée à la version supportée (§8.1). */
    wingsVersion: varchar("wings_version", { length: 32 }),
    /**
     * Dernier heartbeat reçu. La santé du node n'est pas stockée : elle se
     * déduit de l'âge de cette valeur (`nodeStatus` dans @gamedashboard/contracts).
     * Un booléen « en ligne » à côté finirait par contredire l'horodatage.
     *
     * Voir `unreachableSince`, qui ne contredit pas cette règle.
     */
    lastHeartbeatAt: moment("last_heartbeat_at"),
    /**
     * Début de l'indisponibilité **en cours de signalement**.
     *
     * Ce n'est pas la santé du node, qui reste déduite du heartbeat : c'est la
     * mémoire de ce qu'on a déjà dit. Sans elle, le veilleur ne saurait pas
     * distinguer « ce node vient de tomber » de « ce node est tombé il y a
     * trois heures », et enverrait un rappel toutes les trente secondes à un
     * système tiers qui a compris du premier coup.
     *
     * L'invariant est donc : nul ⇔ aucune indisponibilité en cours n'a été
     * signalée. Un seul écrivain le tient — `NodeHealthWatcherService` — parce
     * qu'une mémoire d'alerte tenue à deux endroits finit par annoncer deux
     * fois, ou pas du tout.
     *
     * La valeur posée est le **dernier heartbeat reçu**, et non l'instant où on
     * l'a remarqué : c'est à ce moment-là que le node a cessé de répondre. Y
     * mettre l'heure de la découverte amputerait chaque panne des deux minutes
     * du seuil, et la durée rendue au retour serait fausse d'autant.
     */
    unreachableSince: moment("unreachable_since"),
    /**
     * Début de l'historique des pannes (`node_outages`) pour ce node.
     *
     * La disponibilité publiée ne se calcule que sur la période où les pannes
     * ont été consignées. Les nodes antérieurs à cette consignation la
     * commencent à la migration qui l'a introduite, pas à leur création :
     * compter leur passé comme sans panne gonflerait le chiffre.
     */
    uptimeTrackedSince: moment("uptime_tracked_since").notNull().default(sql`now()`),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("node_token_id_unique").on(table.daemonTokenId),
    // Le revendeur ne voit que ses nodes : cette liste est chargée à chaque
    // ouverture de son espace.
    index("node_owner_idx").on(table.ownerId),
    index("node_location_idx").on(table.locationId),
    index("node_category_idx").on(table.category, table.subcategory),
  ],
);

/**
 * Pannes des nodes, une ligne par interruption.
 *
 * Écrite par le seul `NodeHealthWatcherService`, aux mêmes transitions que
 * `nodes.unreachable_since` : ouverte au dernier heartbeat reçu, close au
 * retour. C'est l'historique qui permet de publier une disponibilité sur la
 * page de statut sans l'inventer.
 */
export const nodeOutages = pgTable(
  "node_outages",
  {
    id: id(),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    startedAt: moment("started_at").notNull(),
    /** `null` : la panne dure encore. */
    endedAt: moment("ended_at"),
    /** Le node était en maintenance déclarée quand il s'est tu. */
    maintenance: boolean("maintenance").notNull().default(false),
    ...timestamps,
  },
  (table) => [index("node_outage_node_started_idx").on(table.nodeId, table.startedAt)],
);

/**
 * Agent de node (ADR 0008, ADR 0009) : au plus un par node, **facultatif**.
 *
 * L'agent vit à côté de Wings, qu'il ne remplace ni ne modifie. Il s'annonce
 * comme le daemon : `Authorization: Bearer <token_id>.<token>`, identifiant
 * lisible pour la recherche, secret chiffré lié à la ligne
 * (`node_agents.token_enc:<node>`), comparaison à temps constant. Le panel
 * n'appelle jamais l'agent : seule la moitié « la machine appelle le panel »
 * du modèle de Wings est reprise.
 *
 * Pas de ligne, pas d'agent : `nodeCapabilities()` retire alors tout ce qui
 * en dépend, et rien d'autre ne change.
 */
export const nodeAgents = pgTable(
  "node_agents",
  {
    nodeId: uuid("node_id")
      .primaryKey()
      .references(() => nodes.id, { onDelete: "cascade" }),
    tokenId: varchar("token_id", { length: 32 }).notNull(),
    tokenEnc: text("token_enc").notNull(),
    /** Émis par `gamedashboard-agent configure` : chaque appel en tire un neuf. */
    tokenIssuedAt: moment("token_issued_at").notNull(),
    version: varchar("version", { length: 32 }),
    /**
     * Fonctions actives dans le `config.yml` de l'agent, telles qu'annoncées.
     *
     * Ce que l'agent annonce **est** la capacité du node : personne ne coche
     * une case qui pourrait mentir.
     */
    functions: text("functions").array().notNull().default([]),
    /**
     * Dernier signe de vie de chaque fonction, `{ fonction: instant }`.
     *
     * Chaque fonction tourne dans son propre service : l'une peut s'être tue
     * pendant que l'autre parle encore.
     */
    functionsSeen: jsonb("functions_seen").$type<Record<string, string>>().notNull().default({}),
    lastSeenAt: moment("last_seen_at"),
    /**
     * Dernière entrée du journal de l'agent déjà rangée au journal d'activité.
     *
     * Une entrée renvoyée (accusé perdu, deux services qui envoient en même
     * temps) n'est pas consignée deux fois. Remis à zéro par `configure` : une
     * base locale neuve recommence sa numérotation.
     */
    journalAckedId: bigint("journal_acked_id", { mode: "number" }).notNull().default(0),
    ...timestamps,
  },
  (table) => [uniqueIndex("node_agent_token_id_unique").on(table.tokenId)],
);

export const allocations = pgTable(
  "allocations",
  {
    id: id(),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    ip: varchar("ip", { length: 45 }).notNull(),
    ipAlias: varchar("ip_alias", { length: 255 }),
    port: integer("port").notNull(),
    /**
     * Nul quand l'allocation est libre.
     *
     * La référence est déclarée par une fonction, et non par la valeur : elle
     * n'est évaluée qu'à la construction du schéma, ce qui permet le cycle
     * `allocations ↔ servers` sans que l'un des deux modules soit à moitié
     * chargé au moment où l'autre le lit.
     *
     * `set null` et non `cascade` : supprimer un serveur libère son allocation,
     * il serait absurde de détruire le port avec lui.
     */
    serverId: uuid("server_id").references((): AnyPgColumn => servers.id, {
      onDelete: "set null",
    }),
    notes: text("notes"),
    ...timestamps,
  },
  (table) => [
    // Deux serveurs ne peuvent pas écouter le même port sur la même IP :
    // la contrainte appartient à la base, pas au code applicatif, sinon deux
    // créations simultanées passeraient toutes les deux la vérification.
    uniqueIndex("allocation_node_ip_port_unique").on(table.nodeId, table.ip, table.port),
    index("allocation_server_idx").on(table.serverId),
  ],
);

/*
 * Il y avait ici `node_metrics` : la charge de la **machine**, par opposition
 * à ce que ses conteneurs consomment. Vide depuis le premier jour, retirée
 * en 0029 — et elle ne pouvait pas l'être autrement.
 *
 * Wings ne l'expose pas. Son `/api/system` ne rend que l'architecture, le
 * noyau et la version, et le panel ne modifie pas Wings. La table promettait
 * donc un relevé que rien ne pouvait produire.
 *
 * `server_metrics` mesure les conteneurs et est alimentée à la minute. C'est
 * une autre grandeur, et les écrans le disent : « consommé par les serveurs »,
 * jamais « charge du node » — la nuance décide si l'on croit une machine
 * saturée ou disponible.
 */

export const nodesRelations = relations(nodes, ({ one, many }) => ({
  location: one(locations, { fields: [nodes.locationId], references: [locations.id] }),
  owner: one(users, { fields: [nodes.ownerId], references: [users.id] }),
  allocations: many(allocations),
}));

export const allocationsRelations = relations(allocations, ({ one }) => ({
  node: one(nodes, { fields: [allocations.nodeId], references: [nodes.id] }),
}));
