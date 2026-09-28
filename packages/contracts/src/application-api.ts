/**
 * API applicative : ce qu'un système tiers a le droit de faire.
 *
 * Elle existe parce que la facturation ne vit **pas** dans ce projet. Le site
 * client encaisse, puis demande au panel de créer, suspendre ou supprimer.
 * Cette API est le seul point par lequel il passe, et ses portées disent
 * exactement jusqu'où il va.
 *
 * Deux natures de clés coexistent, et rien ne les mélange :
 *
 * - une **clé personnelle** (`gd_live_…`) appartient à quelqu'un et ne peut
 *   jamais dépasser ses propres droits ; ses portées sont des permissions de
 *   serveur ;
 * - une **clé applicative** (`gd_app_…`) n'appartient à personne. Elle n'a pas
 *   de droits à borner : ses portées *sont* ses droits. C'est pourquoi elle
 *   vit dans une autre table, derrière une autre garde, sur un autre préfixe
 *   d'URL — trois séparations plutôt qu'un drapeau, parce qu'un drapeau
 *   s'oublie dans une requête.
 */

import { z } from "zod";

export const APPLICATION_SCOPES = [
  /* Comptes clients. */
  "users.read",
  "users.write",
  "users.delete",
  /**
   * Ouvrir une session au nom d'un client.
   *
   * Portée à part, et jamais confondue avec `users.write` : modifier une fiche
   * et **entrer dans le compte** ne sont pas la même autorité. C'est celle que
   * le plugin de facturation emploie pour son bouton « Gérer mon serveur », et
   * c'est la seule qu'on voudra refuser à une intégration dont on accepte par
   * ailleurs qu'elle tienne l'état civil des clients.
   */
  "users.sso",
  /* Serveurs de jeu. */
  "servers.read",
  "servers.create",
  "servers.suspend",
  /**
   * Changer les limites d'un serveur existant.
   *
   * Séparée de `servers.create` à dessein : une boutique qui n'a qu'à faire
   * monter ses clients en gamme n'a pas besoin du droit d'en créer, et une clé
   * volée ne doit pas pouvoir remplir un node par ce chemin.
   */
  "servers.resize",
  /**
   * Changer le titulaire d'un serveur : le service change de client chez le
   * facturier, le serveur suit.
   *
   * Portée à part : donner un serveur à quelqu'un d'autre, c'est lui en
   * remettre les fichiers et la console. Une boutique qui ne fait que créer
   * et suspendre n'a aucune raison de le pouvoir, et une clé déjà émise ne
   * l'acquiert pas en silence.
   */
  "servers.owner",
  "servers.delete",
  /* Revendeurs : enveloppe de ressources et autorisations. */
  "resellers.read",
  "resellers.write",
  /* Nodes, localisations, eggs et offres — en lecture seule. */
  "infrastructure.read",
  /**
   * Configuration complète d'un node, **jeton du daemon compris**.
   *
   * Une portée à part, et pas un cas de `infrastructure.read` : ce que celle-ci
   * accorde — la liste du parc — se donne à une boutique sans y réfléchir,
   * alors que le jeton d'un daemon donne les pleins pouvoirs sur la machine.
   * Les réunir ferait de chaque clé de facturation une clé d'administration
   * des nodes, sans que personne ne l'ait décidé.
   */
  "nodes.configure",
  /**
   * Délivrance des certificats TLS des domaines de revendeurs.
   *
   * Portée de **l'agent de certificats**, qui tourne sur le serveur web de la
   * plateforme — pas d'une boutique. Elle lit les domaines vérifiés et écrit
   * l'issue de chaque tentative. Elle ne donne accès à aucun client ni à aucun
   * serveur, mais elle nomme des domaines qui ne sont pas les siens : elle
   * reste donc réservée à la plateforme.
   */
  "domains.certificates",
] as const;

export type ApplicationScope = (typeof APPLICATION_SCOPES)[number];

export function isApplicationScope(value: string): value is ApplicationScope {
  return (APPLICATION_SCOPES as readonly string[]).includes(value);
}

/**
 * La clé porte-t-elle cette portée ?
 *
 * Comparaison exacte, sans joker : ni `servers.*` ni `*`. Un joker donne des
 * droits qu'on n'a pas relus — ceux qui n'existent pas encore. La portée
 * ajoutée l'an prochain serait accordée rétroactivement à toutes les clés
 * créées cette année, sans que personne ne l'ait décidé.
 *
 * L'écriture n'implique pas non plus la lecture : une clé qui crée des
 * serveurs sans pouvoir les lister est une clé utile — elle provisionne, elle
 * n'inventorie pas. Les déduire l'une de l'autre donnerait à un système de
 * facturation compromis la liste complète des clients, qu'il n'avait aucune
 * raison de demander.
 */
export function hasApplicationScope(
  granted: readonly string[],
  required: ApplicationScope,
): boolean {
  return granted.includes(required);
}

export interface ApplicationScopeGroup {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly scopes: readonly { readonly scope: ApplicationScope; readonly label: string }[];
}

/**
 * Catalogue pour l'écran d'administration.
 *
 * Il vit ici, avec la liste : une portée ajoutée sans entrée ici serait
 * vérifiable par l'API mais impossible à accorder depuis l'interface — donc
 * inutilisable, sans qu'aucun test ne s'en plaigne.
 */
export const APPLICATION_SCOPE_CATALOGUE: readonly ApplicationScopeGroup[] = [
  {
    key: "users",
    label: "Comptes clients",
    description: "Créer et tenir à jour les comptes, depuis la boutique ou l'espace client.",
    scopes: [
      { scope: "users.read", label: "Lire les comptes" },
      { scope: "users.write", label: "Créer et modifier un compte" },
      { scope: "users.delete", label: "Supprimer un compte" },
      {
        scope: "users.sso",
        label: "Ouvrir une session au nom d'un client",
      },
    ],
  },
  {
    key: "servers",
    label: "Serveurs",
    description:
      "Le cœur de l'intégration : une commande payée crée, un impayé suspend, une résiliation supprime.",
    scopes: [
      { scope: "servers.read", label: "Lire les serveurs" },
      { scope: "servers.create", label: "Créer un serveur" },
      { scope: "servers.suspend", label: "Suspendre et rétablir" },
      { scope: "servers.resize", label: "Changer les limites d'un serveur" },
      { scope: "servers.owner", label: "Changer le titulaire d'un serveur" },
      { scope: "servers.delete", label: "Supprimer un serveur" },
    ],
  },
  {
    key: "resellers",
    label: "Revendeurs",
    description: "Enveloppe de ressources d'un revendeur, telle que son abonnement la définit.",
    scopes: [
      { scope: "resellers.read", label: "Lire l'enveloppe et la consommation" },
      { scope: "resellers.write", label: "Modifier l'enveloppe" },
    ],
  },
  {
    key: "infrastructure",
    label: "Infrastructure",
    description:
      "Nodes, localisations, jeux et offres. Nécessaire pour composer une commande ; jamais en écriture.",
    scopes: [{ scope: "infrastructure.read", label: "Lire le catalogue et le parc" }],
  },
  {
    key: "daemon",
    label: "Mise en service des daemons",
    description:
      "Ce que `wings configure` vient chercher pour s'installer sur une machine. " +
      "La réponse contient le jeton du daemon : cette clé vaut le contrôle des nodes qu'elle configure.",
    scopes: [
      {
        scope: "nodes.configure",
        label: "Lire la configuration d'un node, jeton du daemon compris",
      },
    ],
  },
  {
    key: "certificates",
    label: "Certificats des domaines",
    description:
      "Ce que l'agent de certificats vient chercher pour délivrer le TLS des domaines " +
      "vérifiés, et où il rend compte de chaque tentative. Il tourne sur le serveur web " +
      "de la plateforme, pas chez un revendeur.",
    scopes: [
      {
        scope: "domains.certificates",
        label: "Lire les domaines à certifier et rendre compte",
      },
    ],
  },
];

/**
 * Cette portée relève-t-elle de la plateforme ?
 *
 * La règle vivait en double — dans le refus à l'émission côté API et dans le
 * catalogue proposé au revendeur côté interface. Deux listes à tenir d'accord
 * pour une seule règle : la portée ajoutée en oubliant l'une des deux serait
 * proposée à l'écran puis refusée à l'enregistrement, ou pire, acceptée.
 */
export function isPlatformScope(scope: string): boolean {
  return (
    scope.startsWith("resellers.") ||
    scope === "nodes.configure" ||
    scope === "domains.certificates"
  );
}

/**
 * Durée au-delà de laquelle une clé applicative doit être renouvelée.
 *
 * Une clé de machine ne se retient pas de tête et ne change jamais d'elle-même :
 * sans échéance, elle reste valable des années après le départ du prestataire
 * qui l'a intégrée. Un an est assez long pour ne pas gêner, assez court pour
 * que la question se pose.
 */
export const APPLICATION_KEY_MAX_DAYS = 365;

/** Longueur maximale d'une clé d'idempotence acceptée. */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 200;

/**
 * Une clé d'idempotence est-elle exploitable ?
 *
 * Elle doit être assez longue pour ne pas se répéter par hasard entre deux
 * commandes sans rapport : deux systèmes qui enverraient tous deux `1` se
 * verraient répondre la commande de l'autre.
 */
export function isUsableIdempotencyKey(value: string): boolean {
  return value.trim().length >= 8 && value.trim().length <= IDEMPOTENCY_KEY_MAX_LENGTH;
}

/*
 * Corps de création et de correction de l'API applicative.
 *
 * Chaque champ texte est **borné par la colonne qui le reçoit** (ASVS 5.1.4).
 * Sans borne, un corps d'un mégaoctet passait la validation et n'était arrêté
 * que par la base — `value too long`, une erreur 500 qu'un système tiers
 * prend pour une panne et rejoue — au lieu d'un refus qui dit quoi changer.
 * Les bornes vivent ici, à côté des portées, pour que l'API et ce qui la
 * documente lisent la même règle.
 */

/**
 * Un identifiant du panel : un UUID, 36 caractères.
 *
 * Borné sans juger du format : un identifiant inconnu reste un 404 rendu par
 * la route, comme avant ; seul le démesuré est refusé ici.
 */
const PanelId = z.string().max(64);

/** Adresse : `users.email`, 255 caractères. Le format est vérifié par le service. */
const Email = z.string().min(3).max(255);
/** Prénom et nom : `users.name_first` et `users.name_last`, 100 caractères. */
const PersonName = z.string().min(1).max(100);
/** Identifiant du client chez l'appelant : `users.external_id`, 255 caractères. */
const ExternalId = z.string().min(1).max(255);

export const ApplicationUserCreate = z.object({
  email: Email,
  nameFirst: PersonName,
  nameLast: PersonName,
  /** Identifiant du client chez l'appelant. C'est par lui qu'il se retrouvera. */
  externalId: ExternalId.optional(),
});
export type ApplicationUserCreate = z.infer<typeof ApplicationUserCreate>;

export const ApplicationUserUpdate = z.object({
  nameFirst: PersonName.optional(),
  nameLast: PersonName.optional(),
  externalId: ExternalId.nullable().optional(),
});
export type ApplicationUserUpdate = z.infer<typeof ApplicationUserUpdate>;

/** Au plus autant de variables qu'un egg peut en déclarer (`egg-editor.ts`). */
export const APPLICATION_SERVER_VARIABLES_MAX = 100;

/**
 * Variables de démarrage : nom borné par `egg_variables.env_variable` (120),
 * valeur à 4 Kio — une ligne de commande Java, pas un fichier.
 */
const ServerVariables = z
  .record(z.string().max(120), z.string().max(4096))
  .refine((variables) => Object.keys(variables).length <= APPLICATION_SERVER_VARIABLES_MAX, {
    message: `Au plus ${APPLICATION_SERVER_VARIABLES_MAX} variables.`,
  });

const ResourceRequest = z.object({
  memoryMb: z.number().int(),
  diskMb: z.number().int(),
  cpuPct: z.number().int(),
  swapMb: z.number().int(),
  allocations: z.number().int(),
  backups: z.number().int(),
  databases: z.number().int(),
});

export const ApplicationServerCreate = z.object({
  ownerId: PanelId.min(1),
  eggId: PanelId.min(1),
  /** `servers.name`, 120 caractères. */
  name: z.string().min(1).max(120),
  variables: ServerVariables.optional(),
  planId: PanelId.optional(),
  locationId: PanelId.optional(),
  nodeId: PanelId.optional(),
  resources: ResourceRequest.optional(),
});
export type ApplicationServerCreate = z.infer<typeof ApplicationServerCreate>;

/**
 * Changement de titulaire : le compte du panel qui reçoit le serveur.
 *
 * Un UUID exigé, et non la seule borne de `PanelId` : l'identifiant part tel
 * quel dans une comparaison avec `users.id`, et une valeur illisible y
 * devenait une erreur 500 de PostgreSQL au lieu d'un refus qui dit quoi
 * corriger.
 */
export const ApplicationServerOwner = z.object({
  ownerId: z.string().uuid("Identifiant de compte invalide."),
});
export type ApplicationServerOwner = z.infer<typeof ApplicationServerOwner>;
