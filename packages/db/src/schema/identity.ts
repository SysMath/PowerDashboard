import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { createdAt, id, moment, timestamps } from "../columns";
import { oauthProvider, userRole } from "./enums";

/** §6.1 — Identité & accès. */

export const users = pgTable(
  "users",
  {
    id: id(),
    email: varchar("email", { length: 255 }).notNull(),
    /**
     * Nul pour un compte créé par OAuth ou SSO qui n'a jamais défini de mot de
     * passe. Une chaîne vide serait un condensat valide au sens du type et
     * ouvrirait la porte à une connexion sans secret.
     */
    passwordHash: text("password_hash"),
    /**
     * Échéance d'un mot de passe **provisoire**, tiré au sort par un script
     * d'exploitation (`create-admin`, `reset-password`) ; nulle pour tout mot
     * de passe choisi par son titulaire.
     *
     * Passé l'échéance, la connexion le refuse ; avant, elle demande d'en
     * changer. Tout changement de mot de passe depuis le panel la lève. Voir
     * `passwordStanding`.
     */
    passwordExpiresAt: moment("password_expires_at"),
    nameFirst: varchar("name_first", { length: 100 }).notNull(),
    nameLast: varchar("name_last", { length: 100 }).notNull(),
    locale: varchar("locale", { length: 10 }).notNull().default("fr"),
    timezone: varchar("timezone", { length: 64 }).notNull().default("Europe/Paris"),
    role: userRole("role").notNull().default("user"),
    /**
     * Un revendeur autorise-t-il l'administration à créer des serveurs sur ses
     * comptes clients ?
     *
     * Faux par défaut, et ce défaut est le sujet : un revendeur loue son propre
     * matériel et répond de ce qui y tourne. Laisser l'administration de la
     * plateforme y provisionner sans qu'il l'ait demandé reviendrait à disposer
     * de sa capacité et à engager sa responsabilité à sa place.
     *
     * Ne concerne que les comptes `reseller` ; la colonne est ignorée ailleurs.
     */
    /**
     * Ce que ce revendeur laisse la plateforme faire sur son parc.
     *
     * Remplace un booléen qui ne bloquait que la création : un administrateur
     * gardait malgré lui la console, les fichiers et la suppression de tous
     * ses serveurs. Voir `PLATFORM_ACCESS_LEVELS`.
     *
     * `read_only` par défaut, ici comme à la reprise : regarder sans agir est
     * le seul état qu'on puisse accorder sans que personne ne l'ait demandé.
     */
    platformAccess: varchar("platform_access", { length: 16 })
      .notNull()
      .default("read_only")
      .$type<"provision" | "read_only" | "none">(),
    isTwoFactorEnabled: boolean("is_2fa_enabled").notNull().default(false),
    /**
     * Identifiant de ce client **chez le système de facturation**.
     *
     * C'est la clé par laquelle l'API applicative retrouve un compte : le
     * facturier connaît ses propres clients, pas les identifiants du panel, et
     * le forcer à tenir une table de correspondance la ferait désynchroniser.
     *
     * Le SSO y écrivait aussi son `sub`, ce qui faisait **deux métiers sur une
     * colonne unique** : une facture rattachée après une connexion SSO aurait
     * écrasé l'identité, ou échoué sur l'index. L'identité des fournisseurs vit
     * désormais dans `user_oauth_accounts` (migration 0030).
     */
    externalId: varchar("external_id", { length: 255 }),
    avatarUrl: text("avatar_url"),
    emailVerifiedAt: moment("email_verified_at"),
    lastLoginAt: moment("last_login_at"),
    /**
     * Compte suspendu par l'administration depuis cet instant, ou nul.
     *
     * Un horodatage plutôt qu'un booléen : « depuis quand » est la première
     * question du support, et un booléen obligerait à fouiller le journal pour
     * y répondre. La suspension ferme **toutes** les portes du compte —
     * sessions, clés d'API, SFTP, liens de la facturation — mais laisse ses
     * serveurs tourner : suspendre un serveur est un autre geste, qui existe
     * déjà. Voir `AdminUsersService.setSuspended`.
     */
    suspendedAt: moment("suspended_at"),
    /** Motif donné par l'administrateur, montré au support. Nul hors suspension. */
    suspensionReason: text("suspension_reason"),
    ...timestamps,
  },
  (table) => [
    // L'unicité est insensible à la casse : « Paul@ex.fr » et « paul@ex.fr »
    // désignent la même boîte, et deux comptes pour une même adresse
    // rendraient le rapprochement SSO ambigu. L'index portait sur la colonne
    // brute, sensible à la casse, alors que toutes les lectures comparent en
    // `lower()` (NC-28, migration 0042).
    uniqueIndex("users_email_unique").on(sql`lower(${table.email})`),
    uniqueIndex("users_external_id_unique").on(table.externalId),
  ],
);

export const userOauthAccounts = pgTable(
  "user_oauth_accounts",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: oauthProvider("provider").notNull(),
    providerUserId: varchar("provider_user_id", { length: 255 }).notNull(),
    email: varchar("email", { length: 255 }).notNull(),
    linkedAt: moment("linked_at"),
    ...timestamps,
  },
  (table) => [
    // Un compte distant ne peut être rattaché qu'à un seul compte local :
    // sans cela, deux utilisateurs pourraient se connecter avec le même Google.
    uniqueIndex("oauth_provider_identity_unique").on(table.provider, table.providerUserId),
    // Et un compte local ne porte qu'une identité par fournisseur. Le
    // rapprochement le vérifiait par une lecture, que deux cérémonies
    // concurrentes passaient ensemble (doute D-7, migration 0043).
    uniqueIndex("oauth_user_provider_unique").on(table.userId, table.provider),
    index("oauth_user_idx").on(table.userId),
  ],
);

export const userTotpCredentials = pgTable("user_credentials_totp", {
  id: id(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  /** Chiffré AES-256-GCM (§5.4) : un secret TOTP en clair vaut le mot de passe. */
  secretEnc: text("secret_enc").notNull(),
  verifiedAt: moment("verified_at"),
  /**
   * Dernier pas de trente secondes consommé, pour interdire le rejeu.
   *
   * Sans lui, un code intercepté — épaule, hameçonnage, journal mal configuré —
   * reste utilisable pendant toute la fenêtre de tolérance. Or c'est
   * exactement ce contre quoi une seconde preuve d'identité doit protéger :
   * elle n'a d'intérêt que si le code ne sert qu'une fois.
   *
   * `bigint` en mode nombre : un pas tient dans un entier sûr jusqu'en l'an
   * 6000, mais `integer` déborderait en 2038, comme le temps Unix sur 32 bits.
   */
  lastUsedStep: bigint("last_used_step", { mode: "number" }),
  ...timestamps,
});

export const userPasskeys = pgTable(
  "user_passkeys",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    credentialId: text("credential_id").notNull(),
    publicKey: text("public_key").notNull(),
    /**
     * Compteur anti-rejeu WebAuthn : une valeur reçue inférieure ou égale à la
     * valeur stockée signale un clonage de l'authentifiant.
     */
    counter: integer("counter").notNull().default(0),
    transports: text("transports").array().notNull().default([]),
    label: varchar("label", { length: 100 }).notNull(),
    /**
     * Domaine relais de la clé, quand c'est celui d'un revendeur. `null` : le
     * domaine de la plateforme (`PANEL_ORIGIN`). Une clé est liée au domaine
     * où elle a été créée — l'authentifiant signe ce nom — et ne sert pas
     * ailleurs : il faut le savoir pour ne la proposer qu'au bon endroit.
     */
    rpId: varchar("rp_id", { length: 255 }),
    lastUsedAt: moment("last_used_at"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("passkey_credential_unique").on(table.credentialId),
    index("passkey_user_idx").on(table.userId),
  ],
);

export const userRecoveryCodes = pgTable(
  "user_recovery_codes",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Stocké haché : un code de secours est un mot de passe à usage unique. */
    codeHash: text("code_hash").notNull(),
    usedAt: moment("used_at"),
    ...timestamps,
  },
  (table) => [index("recovery_code_user_idx").on(table.userId)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /**
     * Condensat SHA-256 du jeton de session, jamais le jeton lui-même.
     *
     * Le jeton est une valeur aléatoire distincte de `id`, et c'est délibéré :
     * si l'identifiant primaire servait de jeton, il circulerait dans les
     * cookies, apparaîtrait dans les journaux et les exports, et une fuite de
     * la table suffirait à ouvrir toutes les sessions en cours.
     */
    tokenHash: text("token_hash").notNull(),
    ip: inet("ip"),
    userAgent: text("user_agent"),
    deviceLabel: varchar("device_label", { length: 120 }),
    /**
     * Par quel chemin cette session a été ouverte : `password`, `passkey`,
     * `sso`, ou le nom d'un fournisseur OAuth.
     *
     * Consigné à l'ouverture parce que c'est le seul moment où on le sait. Le
     * déduire après coup — « le compte a un identifiant externe, donc c'est du
     * SSO » — dirait faux de quiconque a lié un compte Google et se connecte
     * pourtant par mot de passe.
     */
    authMethod: varchar("auth_method", { length: 32 }).notNull().default("password"),
    expiresAt: moment("expires_at").notNull(),
    /**
     * Dernière requête servie avec cette session.
     *
     * Colonne distincte de `updated_at`, et non un réemploi de celle-ci : une
     * révocation écrit `updated_at`, si bien qu'une session fermée
     * apparaîtrait comme la plus récemment active de la liste — exactement
     * l'inverse de ce qui s'est passé.
     *
     * L'écriture se fait au plus une fois par minute (cf.
     * `LAST_SEEN_PRECISION_MS`) : la valeur décide de l'expiration
     * d'inactivité (trente minutes), et une tranche plus large la déplacerait.
     */
    lastSeenAt: moment("last_seen_at"),
    /**
     * Une session révoquée est conservée, pas supprimée : l'utilisateur doit
     * pouvoir constater depuis /account/security qu'une session a bien été
     * fermée, et à quel moment.
     */
    revokedAt: moment("revoked_at"),
    /**
     * Membre du personnel qui a ouvert cette session pour le compte d'un
     * client, ou nul — ce qui est le cas de toutes les sessions ordinaires.
     *
     * `user_id` reste **celui du client** : tout le contrôle d'accès existant
     * s'applique donc sans qu'une seule route ait à connaître la prise en main.
     * C'est ce qui rend le mécanisme sûr, en évitant un second chemin
     * d'autorisation à tenir à jour.
     */
    impersonatorId: uuid("impersonator_id").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (table) => [
    // La recherche se fait toujours par condensat : c'est la valeur présentée
    // par le navigateur. L'unicité empêche deux sessions de se confondre.
    uniqueIndex("session_token_hash_unique").on(table.tokenHash),
    index("session_user_idx").on(table.userId),
    index("session_expiry_idx").on(table.expiresAt),
    // Partiel, comme la migration 0022 l'a créé : presque toutes les sessions
    // ont `impersonator_id` nul, et l'index ne sert qu'à retrouver les prises
    // en main.
    index("session_impersonator_idx")
      .on(table.impersonatorId)
      .where(sql`${table.impersonatorId} is not null`),
  ],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 100 }).notNull(),
    /** Partie visible (`gd_live_a1b2c3`) : sert à identifier la clé sans la révéler. */
    prefix: varchar("prefix", { length: 32 }).notNull(),
    keyHash: text("key_hash").notNull(),
    scopes: text("scopes").array().notNull().default([]),
    allowedIps: text("allowed_ips").array().notNull().default([]),
    expiresAt: moment("expires_at"),
    lastUsedAt: moment("last_used_at"),
    revokedAt: moment("revoked_at"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("api_key_prefix_unique").on(table.prefix),
    index("api_key_user_idx").on(table.userId),
  ],
);

export const sshKeys = pgTable(
  "ssh_keys",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 100 }).notNull(),
    publicKey: text("public_key").notNull(),
    fingerprint: varchar("fingerprint", { length: 128 }).notNull(),
    /** Dernière connexion SFTP acceptée grâce à cette clé. */
    lastUsedAt: moment("last_used_at"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("ssh_key_fingerprint_unique").on(table.userId, table.fingerprint),
    index("ssh_key_user_idx").on(table.userId),
  ],
);

/**
 * Tentatives de connexion, pour le rate-limit et l'alerte à la 5ᵉ (§5.1).
 *
 * Les échecs sont enregistrés par e-mail *et* par IP : limiter uniquement par
 * IP laisse passer une attaque distribuée, limiter uniquement par compte permet
 * de verrouiller n'importe qui en le ciblant.
 */
export const loginAttempts = pgTable(
  "login_attempts",
  {
    id: id(),
    email: varchar("email", { length: 255 }).notNull(),
    ip: inet("ip").notNull(),
    success: boolean("success").notNull(),
    at: moment("at").notNull(),
  },
  (table) => [
    index("login_attempt_email_idx").on(table.email, table.at),
    index("login_attempt_ip_idx").on(table.ip, table.at),
  ],
);

/**
 * Jetons envoyés par courrier.
 *
 * Une table plutôt qu'un jeton signé auto-porteur : un jeton signé ne se
 * révoque pas. Celui qui réinitialise un mot de passe doit cesser de valoir dès
 * qu'il a servi — sinon un courriel oublié dans une boîte reste une clé du
 * compte pendant des mois — et doit tomber en même temps que ses frères quand
 * on en redemande un.
 */
export const authTokens = pgTable(
  "auth_tokens",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** `password_reset` ou `email_verify`. Scellé avec le reste : un jeton de
     * vérification d'adresse ne doit pas pouvoir changer un mot de passe. */
    purpose: varchar("purpose", { length: 32 }).notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: moment("expires_at").notNull(),
    /** Non nul dès qu'il a servi. La ligne reste : « déjà utilisé » et « jamais
     * existé » appellent deux messages différents. */
    consumedAt: moment("consumed_at"),
    requestedIp: inet("requested_ip"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("auth_tokens_hash_unique").on(table.tokenHash),
    index("auth_tokens_user_idx").on(table.userId, table.purpose),
  ],
);

export const usersRelations = relations(users, ({ many }) => ({
  oauthAccounts: many(userOauthAccounts),
  passkeys: many(userPasskeys),
  sessions: many(sessions),
  apiKeys: many(apiKeys),
  sshKeys: many(sshKeys),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

/**
 * Enveloppe de ressources d'un revendeur.
 *
 * Plafond **global** : il compte tout ce que le revendeur fait tourner, ses
 * propres machines comprises. Un revendeur disposant de 64 Go de matériel et
 * d'un quota de 32 Go n'exploite que la moitié de sa machine, et c'est voulu —
 * la plateforme facture ce qui est revendu, pas ce qui est branché.
 *
 * Table dédiée plutôt que colonnes sur `users` : ces valeurs ne concernent
 * qu'un rôle, et les poser sur `users` obligerait chaque lecture de compte à
 * les traîner. L'absence de ligne a un sens précis — voir ci-dessous.
 */
export const resellerQuotas = pgTable("reseller_quotas", {
  /**
   * Un quota par compte, d'où la clé primaire sur `user_id`.
   *
   * `cascade` : un compte supprimé n'a plus d'enveloppe à faire respecter.
   */
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /**
   * `null` signifie **sans limite** sur cette dimension, jamais zéro.
   *
   * La distinction décide de tout : à la mise en service, aucun revendeur n'a
   * de ligne, et interpréter l'absence comme zéro les bloquerait tous d'un
   * coup. Zéro reste disponible et veut dire « plus aucune création », ce qui
   * est une décision qu'on prend, pas un état par défaut.
   */
  memoryMb: integer("memory_mb"),
  diskMb: integer("disk_mb"),
  serversMax: integer("servers_max"),
  ...timestamps,
});

/**
 * Le revendeur qui a créé un compte, par la clé applicative de sa boutique.
 *
 * Le périmètre d'une clé de revendeur se lisait **seulement** sur les
 * serveurs : un compte était à lui dès qu'il en possédait un chez lui. La clé
 * pouvait donc créer un serveur chez un compte qui n'était à personne, puis le
 * lire, le modifier et lui ouvrir une session. Le destinataire d'un serveur
 * doit désormais être déjà à ce revendeur : un client qu'il sert, ou un compte
 * qu'il a créé. Cette table dit le second, que les serveurs ne disent pas
 * encore — le compte que la boutique vient d'ouvrir pour une commande.
 *
 * **Un créateur par compte**, d'où la clé primaire sur `user_id` : l'adresse
 * est unique, un compte ne naît qu'une fois. Rien ne s'écrit pour un compte
 * créé par la plateforme, l'administration ou l'inscription : il n'est à
 * aucun revendeur tant qu'aucun ne le sert.
 *
 * `cascade` des deux côtés : un compte supprimé n'a plus de créateur, et un
 * revendeur supprimé n'a plus de clé pour s'en prévaloir.
 */
export const resellerCustomers = pgTable(
  "reseller_customers",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    resellerId: uuid("reseller_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /**
     * D'où vient la ligne : `api` (créé par `POST /users` d'une clé de ce
     * revendeur) ou `journal` (retrouvé à la migration dans la trace de
     * création). Rien ne la lit pour décider ; elle dit à un administrateur
     * pourquoi ce compte est rattaché.
     */
    origin: varchar("origin", { length: 16 }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [index("reseller_customers_reseller_idx").on(table.resellerId)],
);

/**
 * Clés de l'API applicative (§5.2).
 *
 * Table distincte d'`api_keys`, et non une colonne « type » sur celle-ci : les
 * deux natures de clés n'ont pas le même sujet. Une clé personnelle appartient
 * à quelqu'un et ne peut jamais dépasser ses droits ; une clé applicative
 * n'appartient à personne et ses portées **sont** ses droits.
 *
 * Les fondre obligerait `user_id` à devenir nul, et chaque requête existante
 * sur les clés personnelles à se souvenir d'exclure les autres. Le jour où
 * l'une l'oublie, une clé de machine apparaît dans l'espace d'un client, ou
 * une clé de client gagne les pouvoirs d'une machine.
 */
export const applicationKeys = pgTable(
  "application_keys",
  {
    id: id(),
    /** À quoi sert cette clé. « Boutique WHMCS », « Espace client ». */
    name: varchar("name", { length: 120 }).notNull(),
    /** Partie visible (`gd_app_a1b2c3`), pour retrouver la ligne sans révéler le secret. */
    prefix: varchar("prefix", { length: 32 }).notNull(),
    keyHash: text("key_hash").notNull(),
    scopes: text("scopes").array().notNull().default([]),
    /**
     * Adresses autorisées. Vide vaut « toutes », comme pour une clé personnelle.
     *
     * Le défaut ouvert se justifie ici aussi : une clé inutilisable à la
     * création se contourne en désactivant la restriction, ce qui est pire que
     * de la proposer clairement.
     */
    allowedIps: text("allowed_ips").array().notNull().default([]),
    /**
     * Revendeur auquel cette clé est bornée. `null` = toute la plateforme.
     *
     * Une clé portait jusqu'ici des **portées sans périmètre** : elle disait ce
     * qu'on pouvait faire, jamais sur qui. La confier à un revendeur pour qu'il
     * branche sa propre boutique lui donnait donc la main sur les clients des
     * autres revendeurs — et, avec `users.sso`, le moyen d'ouvrir une session
     * au nom de n'importe lequel d'entre eux.
     *
     * Renseignée, la clé ne voit que ce qui relève de ce revendeur : les
     * serveurs qu'il héberge, et les comptes qui en possèdent au moins un. Le
     * rattachement se lit sur les serveurs parce que c'est là qu'il vit — un
     * compte n'appartient à personne.
     *
     * `cascade` : un revendeur supprimé emporte ses clés. Les laisser vivre
     * ferait des jetons dont le périmètre ne désigne plus personne, ce qui se
     * lit « aucun client » ou « tous » selon le bout de code — et c'est la
     * seconde lecture qui fait les incidents.
     */
    resellerId: uuid("reseller_id").references(() => users.id, { onDelete: "cascade" }),
    /**
     * Qui a créé cette clé. Conservé même si le compte disparaît (`set null`) :
     * savoir qu'une clé existe sans savoir qui l'a émise reste utile, et la
     * supprimer avec son auteur couperait un système tiers en service.
     */
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    /**
     * Node auquel cette clé est bornée, ou `null` pour l'ensemble du parc.
     *
     * Renseigné par les clés d'amorçage émises pour `wings configure` : une
     * telle clé passe par un presse-papiers et un historique de shell, et
     * restreindre sa portée à la seule machine qu'elle sert change ce qu'une
     * fuite coûte — un node, et pas le parc entier.
     *
     * **Sans clé étrangère, délibérément.** `nodes` vit dans un module qui
     * importe déjà celui-ci ; la référence croisée ferait un cycle entre les
     * deux schémas. Une ligne orpheline reste bornée par la durée de vie de
     * ces clés, qui se comptent en minutes, et la route vérifie de toute façon
     * que le node existe avant de répondre.
     */
    nodeId: uuid("node_id"),
    /**
     * La clé meurt-elle à son premier usage réussi ?
     *
     * C'est ce qui distingue une clé d'amorçage d'une clé d'intégration. Un
     * système de facturation appelle tous les jours ; `wings configure`
     * appelle une fois, et tout ce qui reste valable après cet appel est une
     * fenêtre ouverte que personne ne surveille.
     */
    singleUse: boolean("single_use").notNull().default(false),
    /**
     * Instant du premier usage réussi d'une clé à usage unique.
     *
     * Distinct de `revokedAt`, qui dit qu'un humain l'a retirée : on veut
     * pouvoir lire qu'une clé d'amorçage a **servi**, plutôt que de la voir
     * disparaître sans qu'on sache si le daemon l'a consommée ou si elle a
     * simplement expiré.
     */
    consumedAt: moment("consumed_at"),
    expiresAt: moment("expires_at"),
    lastUsedAt: moment("last_used_at"),
    revokedAt: moment("revoked_at"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("application_key_prefix_unique").on(table.prefix),
    // Émettre une clé d'amorçage retire la précédente du même node : la
    // recherche se fait à chaque ouverture de la fenêtre de configuration.
    index("application_key_node_idx").on(table.nodeId),
    // Créé par la migration 0033 : le périmètre d'une clé de revendeur se
    // résout par cette colonne à chaque appel.
    index("application_keys_reseller_idx").on(table.resellerId),
  ],
);

/**
 * Réponses déjà rendues à une requête de création, par clé d'idempotence.
 *
 * Indispensable dès lors que la facturation vit ailleurs : un encaissement qui
 * retente son appel — parce que la réponse s'est perdue, parce qu'une file l'a
 * rejoué — ne doit pas créer un second serveur facturé une fois. La table rend
 * la reprise sûre : la même clé renvoie la même réponse, sans rien refaire.
 */
export const idempotencyRecords = pgTable(
  "idempotency_records",
  {
    id: id(),
    /**
     * Clé fournie par l'appelant, portée par chaque clé applicative séparément.
     *
     * L'unicité est sur le couple (clé applicative, clé d'idempotence) : deux
     * intégrations distinctes peuvent numéroter leurs commandes à partir de 1
     * sans se voler leurs réponses.
     */
    applicationKeyId: uuid("application_key_id")
      .notNull()
      .references(() => applicationKeys.id, { onDelete: "cascade" }),
    idempotencyKey: varchar("idempotency_key", { length: 200 }).notNull(),
    /** Route visée, pour refuser de rejouer une clé sur une autre opération. */
    endpoint: varchar("endpoint", { length: 200 }).notNull(),
    /**
     * Condensat du corps de la requête.
     *
     * Une même clé présentée avec un corps différent est un bogue chez
     * l'appelant, pas une reprise : lui rendre la première réponse lui ferait
     * croire que sa seconde demande a été prise en compte.
     */
    requestHash: text("request_hash").notNull(),
    /** Réponse rendue la première fois, restituée telle quelle ensuite. */
    response: jsonb("response").notNull().$type<Record<string, unknown>>(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("idempotency_scope_unique").on(table.applicationKeyId, table.idempotencyKey),
  ],
);

/**
 * Point d'entrée de rappel d'un système tiers.
 *
 * Rattaché à une **clé applicative** et non à un compte : c'est la boutique
 * qu'on prévient, pas une personne. La conséquence est voulue — révoquer la
 * clé emporte ses rappels, et il n'existe pas d'état où un système coupé
 * continuerait d'être appelé.
 *
 * Distinct de la table `webhooks`, qui appartient à un client du panel pour
 * ses propres serveurs : son `owner_id` est obligatoire, et le rendre nul pour
 * loger les rappels de plateforme obligerait chaque lecture existante à se
 * souvenir d'exclure les autres.
 */
export const applicationWebhooks = pgTable(
  "application_webhooks",
  {
    id: id(),
    applicationKeyId: uuid("application_key_id")
      .notNull()
      .references(() => applicationKeys.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    /**
     * Secret de signature, **chiffré** et non haché.
     *
     * Toute la différence avec une clé d'API : celle-ci est présentée puis
     * comparée, donc un condensat suffit. Un secret de signature doit être
     * relu à chaque envoi pour calculer le HMAC — il ne peut donc pas être
     * haché, et le chiffrement est la meilleure protection possible (§5.4).
     */
    secretEnc: text("secret_enc").notNull(),
    events: text("events").array().notNull().default([]),
    isActive: boolean("is_active").notNull().default(true),
    lastSuccessAt: moment("last_success_at"),
    lastFailureAt: moment("last_failure_at"),
    ...timestamps,
  },
  (table) => [index("application_webhook_key_idx").on(table.applicationKeyId)],
);

/**
 * File des livraisons, avec leur historique de tentatives.
 *
 * Une table plutôt qu'une file en mémoire : un rappel perdu parce que l'API a
 * redémarré entre l'événement et l'envoi est un rappel que personne ne réclame
 * — le tiers ignore qu'il devait le recevoir. Ce qui est écrit survit au
 * redémarrage et repart tout seul.
 */
export const applicationWebhookDeliveries = pgTable(
  "application_webhook_deliveries",
  {
    id: id(),
    webhookId: uuid("webhook_id")
      .notNull()
      .references(() => applicationWebhooks.id, { onDelete: "cascade" }),
    event: varchar("event", { length: 120 }).notNull(),
    payload: jsonb("payload").notNull().$type<Record<string, unknown>>(),
    /**
     * Nombre de tentatives **effectuées**. Zéro tant que rien n'est parti.
     *
     * Distinct du numéro de la tentative en cours, que rien ne stocke : compter
     * ce qui a eu lieu se relit sans ambiguïté après un redémarrage.
     */
    attempts: integer("attempts").notNull().default(0),
    /**
     * Quand tenter. `null` signifie « plus jamais » — livré, ou abandonné.
     *
     * C'est cette colonne qui fait la file : le répartiteur ne lit que les
     * lignes dont l'heure est venue, ce qui rend l'attente gratuite.
     */
    nextAttemptAt: moment("next_attempt_at"),
    /** Nul tant qu'aucune réponse n'est parvenue : distinct d'un échec HTTP. */
    responseStatus: integer("response_status"),
    /** Tronquée : on garde de quoi diagnostiquer, pas la page d'erreur entière. */
    responseBody: text("response_body"),
    deliveredAt: moment("delivered_at"),
    /** Renseigné quand on renonce, avec la raison du dernier échec. */
    abandonedAt: moment("abandoned_at"),
    ...timestamps,
  },
  (table) => [
    index("application_webhook_delivery_due_idx").on(table.nextAttemptAt),
    index("application_webhook_delivery_hook_idx").on(table.webhookId, table.createdAt),
  ],
);

/**
 * Marque blanche d'un revendeur, et son domaine propre.
 *
 * Une ligne par revendeur, créée à la première personnalisation. L'absence de
 * ligne n'est pas un défaut : elle veut dire « ce revendeur emploie la marque
 * de la plateforme », qui reste le cas le plus courant.
 *
 * Chaque champ vide retombe sur celui de la plateforme, **champ par champ** :
 * changer une couleur ne doit pas obliger à redéclarer un logo et des
 * mentions légales.
 */
export const resellerBrandings = pgTable(
  "reseller_brandings",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 120 }).notNull().default(""),
    logoUrl: text("logo_url").notNull().default(""),
    faviconUrl: text("favicon_url").notNull().default(""),
    accent: varchar("accent", { length: 9 }).notNull().default(""),
    supportUrl: text("support_url").notNull().default(""),
    termsUrl: text("terms_url").notNull().default(""),
    footerText: varchar("footer_text", { length: 255 }).notNull().default(""),
    loginTagline: varchar("login_tagline", { length: 255 }).notNull().default(""),
    /** Adresse de réponse des courriels (`Reply-To`) : voir `mailSender`. */
    replyTo: varchar("reply_to", { length: 254 }).notNull().default(""),
    /** Domaine propre. Unique : deux revendeurs ne peuvent pas le revendiquer. */
    domain: varchar("domain", { length: 255 }).unique(),
    /** Preuve de possession, publiée en TXT sur `_gamedashboard.<domaine>`. */
    domainToken: varchar("domain_token", { length: 64 }),
    /**
     * Non nul quand **les deux** vérifications ont abouti : possession et
     * acheminement. Tant qu'il est nul, le domaine n'est servi à personne.
     */
    domainVerifiedAt: moment("domain_verified_at"),
    domainCheckedAt: moment("domain_checked_at"),
    /** Dernier motif d'échec : « CNAME absent » et « TXT introuvable » ne se
     * corrigent pas au même endroit. */
    domainFailure: text("domain_failure"),
    /**
     * Où en est le certificat TLS de ce domaine.
     *
     * Rempli par l'agent de certificats, qui tourne sur le serveur web : le
     * panel n'a ni les droits ni l'accès pour délivrer un TLS lui-même.
     *
     * Un certificat **et** un échec peuvent coexister : le renouvellement a
     * échoué mais l'ancien tient encore. C'est précisément le moment où il faut
     * prévenir, et les mêler ferait perdre l'un des deux.
     */
    certificateIssuedAt: moment("certificate_issued_at"),
    certificateExpiresAt: moment("certificate_expires_at"),
    certificateAttemptedAt: moment("certificate_attempted_at"),
    /** Une phrase qui dit à qui est le problème, pas un journal ACME. */
    certificateFailure: text("certificate_failure"),
    ...timestamps,
  },
  (table) => [
    // Partiel, comme la migration 0020 l'a créé : seul un domaine vérifié est
    // cherché à la résolution de la marque d'une requête.
    index("reseller_branding_domain_idx")
      .on(table.domain)
      .where(sql`${table.domainVerifiedAt} is not null`),
  ],
);

/** Octets bruts (`bytea`), rendus en `Buffer` par le pilote. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

/**
 * Logos et favicons **envoyés par fichier** (marque de la plateforme ou d'un
 * revendeur).
 *
 * En base plutôt que sur disque : l'hébergement cPanel n'a qu'un processus,
 * aucun nginx pour servir un dossier, et chaque mise à jour y remplace le
 * dossier de l'application. Une image de 512 Kio au plus (`BRAND_IMAGE_MAX_BYTES`)
 * y tient sans peine, part avec les sauvegardes de la base, et se sert par
 * l'interface sous `/brand/fichier/<id>`.
 *
 * Une ligne n'est jamais modifiée : un nouvel envoi crée une nouvelle ligne,
 * donc une nouvelle adresse, et l'ancienne image est effacée dès que plus rien
 * ne la désigne. C'est ce qui permet de la servir avec un cache sans limite.
 */
export const brandImages = pgTable(
  "brand_images",
  {
    id: id(),
    /** Revendeur propriétaire, ou `null` pour la plateforme. */
    resellerId: uuid("reseller_id").references(() => users.id, { onDelete: "cascade" }),
    /** `logo` ou `favicon` (`BRAND_IMAGE_KINDS`). */
    kind: varchar("kind", { length: 16 }).notNull(),
    /** Type **lu dans les octets** (`sniffBrandImage`), jamais celui annoncé. */
    contentType: varchar("content_type", { length: 32 }).notNull(),
    /** Empreinte SHA-256 en hexadécimal : sert d'ETag. */
    sha256: varchar("sha256", { length: 64 }).notNull(),
    bytes: bytea("bytes").notNull(),
    createdAt: createdAt(),
  },
  (table) => [index("brand_images_owner_idx").on(table.resellerId, table.kind)],
);

/**
 * Appareils mobiles liés à un compte (ADR 0010).
 *
 * Un appareil n'est pas une session : il dure des semaines, se renouvelle de
 * lui-même et ne porte aucun cookie. Il a donc sa table, lue par
 * `SessionGuard` quand un jeton `gd_mob_` se présente, et listée à part dans
 * Compte › Sécurité, avec « Retirer cet appareil ».
 *
 * Aucun secret n'y est en clair : jeton d'accès, secret d'appareil et défi de
 * présence n'y sont que des condensats SHA-256, comme les sessions.
 */
export const appDevices = pgTable(
  "app_devices",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Ce que le téléphone dit de lui (« Pixel de Léa »), montré au compte. */
    name: varchar("name", { length: 80 }).notNull(),
    /** `ios` ou `android` (`APP_PLATFORMS`). */
    platform: varchar("platform", { length: 16 }).notNull(),
    appVersion: varchar("app_version", { length: 32 }),
    /**
     * Clé publique P-256 de l'appareil (SPKI DER, base64).
     *
     * Sa partie privée ne quitte pas le téléphone (Secure Enclave, Android
     * Keystore) : un secret d'appareil copié ailleurs ne sert à rien sans
     * elle, puisque chaque renouvellement doit être signé.
     */
    publicKey: text("public_key").notNull(),
    /** Condensat du secret d'appareil en cours. */
    secretHash: text("secret_hash").notNull(),
    /**
     * Condensat du secret **précédent**.
     *
     * Gardé pour reconnaître un secret rejoué : présenté après avoir été
     * remplacé, il signe une copie, et l'appareil est retiré.
     */
    previousSecretHash: text("previous_secret_hash"),
    /** Condensat du seul jeton d'accès valide ; un renouvellement l'écrase. */
    accessTokenHash: text("access_token_hash"),
    accessExpiresAt: moment("access_expires_at"),
    /** Défi de présence en attente, à usage unique. */
    challengeHash: text("challenge_hash"),
    challengeExpiresAt: moment("challenge_expires_at"),
    /** Dernier jeton présenté ou renouvelé : décide du délai d'inactivité. */
    lastSeenAt: moment("last_seen_at"),
    lastIp: inet("last_ip"),
    /** Quatre-vingt-dix jours après la liaison, quoi qu'il arrive. */
    expiresAt: moment("expires_at").notNull(),
    /** Conservé après retrait, comme une session : la trace reste lisible. */
    revokedAt: moment("revoked_at"),
    /** `user`, `device`, `replay`, `credentials` : qui ou quoi l'a coupé. */
    revokedReason: varchar("revoked_reason", { length: 24 }),
    /**
     * Où pousser ses notifications : `direct` (jeton Expo de l'appareil) ou
     * `relais` (poignée opaque du relais de l'éditeur). `null` : rien.
     *
     * Le jeton Expo n'est pas un secret d'accès : avec la « sécurité
     * renforcée » d'Expo, l'écrire ne sert à rien sans le jeton d'accès de
     * l'éditeur. La poignée ne vaut que pour ce panel, au relais.
     */
    pushMode: varchar("push_mode", { length: 8 }),
    pushHandle: varchar("push_handle", { length: 160 }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("app_device_access_token_unique").on(table.accessTokenHash),
    index("app_device_user_idx").on(table.userId),
  ],
);

/**
 * Notifications à pousser vers les téléphones (ADR 0010, lot 4).
 *
 * Une file, pas une archive : une ligne disparaît dès que l'envoi a abouti,
 * qu'il a été refusé pour de bon ou qu'il a épuisé ses essais. Elle ne porte
 * que le contenu fermé de l'ADR : le type, le nom du serveur, l'identifiant
 * de la notification et la langue.
 */
export const pushOutbox = pgTable(
  "push_outbox",
  {
    id: id(),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => appDevices.id, { onDelete: "cascade" }),
    notificationId: uuid("notification_id").notNull(),
    type: varchar("type", { length: 64 }).notNull(),
    serverName: varchar("server_name", { length: 64 }),
    locale: varchar("locale", { length: 10 }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: moment("next_attempt_at").notNull().default(sql`now()`),
    createdAt: createdAt(),
  },
  (table) => [index("push_outbox_due_idx").on(table.nextAttemptAt)],
);

/**
 * Relais de notifications de l'éditeur (`PUSH_RELAY=1`) : les panels qui s'y
 * sont enregistrés, par leur identifiant d'instance et leur clé publique
 * Ed25519. Vide partout ailleurs.
 */
export const pushRelayInstances = pgTable("push_relay_instances", {
  /** Identifiant d'instance du descripteur. */
  instance: varchar("instance", { length: 100 }).primaryKey(),
  /** Clé publique Ed25519 (SPKI DER, base64) : seule elle signe ses envois. */
  publicKey: text("public_key").notNull(),
  /** Une instance qui abuse est coupée : ses envois sont refusés. */
  suspendedAt: moment("suspended_at"),
  createdAt: createdAt(),
});

/**
 * Poignées du relais : un jeton Expo inscrit par l'application pour une
 * instance donnée. Le panel ne connaît que la poignée, rangée ici sous son
 * condensat ; le relais refuse qu'une instance écrive à la poignée d'une
 * autre. Rien d'autre n'est gardé après l'envoi.
 */
export const pushRelayHandles = pgTable(
  "push_relay_handles",
  {
    /** Condensat SHA-256 de la poignée, en hexadécimal. */
    handleHash: varchar("handle_hash", { length: 64 }).primaryKey(),
    instance: varchar("instance", { length: 100 })
      .notNull()
      .references(() => pushRelayInstances.instance, { onDelete: "cascade" }),
    expoToken: varchar("expo_token", { length: 160 }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex("push_relay_handle_token_unique").on(table.instance, table.expoToken)],
);

/**
 * Codes d'autorisation de la liaison : soixante secondes, une seule fois.
 *
 * Le code part vers l'application dans une adresse `gamedashboard://`, qu'une
 * autre application pourrait revendiquer : il ne s'échange donc qu'avec le
 * vérificateur PKCE dont `code_challenge` est l'empreinte.
 */
export const appLinkCodes = pgTable(
  "app_link_codes",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    codeChallenge: varchar("code_challenge", { length: 64 }).notNull(),
    deviceName: varchar("device_name", { length: 80 }).notNull(),
    platform: varchar("platform", { length: 16 }).notNull(),
    expiresAt: moment("expires_at").notNull(),
    usedAt: moment("used_at"),
    /**
     * L'appareil né de ce code. Un code présenté une seconde fois a fuité :
     * l'appareil qu'il a déjà créé est retiré (RFC 6749, §4.1.2).
     */
    deviceId: uuid("device_id").references(() => appDevices.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex("app_link_code_hash_unique").on(table.codeHash)],
);
