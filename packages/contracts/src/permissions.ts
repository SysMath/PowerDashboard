import { z } from "zod";

/** Liste exhaustive des permissions par serveur. Source de vérité pour l'API et l'UI. */
export const SERVER_PERMISSIONS = [
  "console.read",
  "console.send",
  "power.start",
  "power.stop",
  "power.restart",
  "power.kill",
  "files.read",
  "files.write",
  "files.delete",
  "files.archive",
  "files.sftp",
  "backups.read",
  "backups.create",
  // Distincte de la lecture : une archive contient tout le serveur, fichiers de
  // configuration compris — donc ses mots de passe RCON et ses clés d'API.
  // Voir la liste des sauvegardes et pouvoir les emporter ne sont pas le même
  // droit.
  "backups.download",
  "backups.restore",
  "backups.delete",
  // Instantanés de volumes (ADR 0009) : pris par l'agent de node, sur les
  // seules machines qui en ont un. Épingler compte comme prendre.
  "snapshots.read",
  "snapshots.create",
  "snapshots.restore",
  "databases.read",
  "databases.create",
  "databases.update",
  "databases.delete",
  "schedules.read",
  "schedules.create",
  "schedules.update",
  "schedules.delete",
  "subusers.read",
  "subusers.create",
  "subusers.update",
  "subusers.delete",
  "allocations.read",
  "allocations.create",
  "allocations.update",
  "allocations.delete",
  "startup.read",
  "startup.update",
  "startup.docker-image",
  "settings.rename",
  "settings.reinstall",
  "activity.read",
  // Rappels sortants du client : son propre point d'entrée, sur son serveur.
  "webhooks.read",
  "webhooks.manage",
  // Vue joueurs : voir qui est connecté n'est pas agir sur eux.
  "players.read",
  "players.manage",
] as const;

export const ServerPermission = z.enum(SERVER_PERMISSIONS);
export type ServerPermission = z.infer<typeof ServerPermission>;

export const SubuserRolePreset = z.enum(["viewer", "moderator", "developer", "owner"]);
export type SubuserRolePreset = z.infer<typeof SubuserRolePreset>;

export const ROLE_PRESETS: Record<SubuserRolePreset, readonly ServerPermission[]> = {
  viewer: [
    "console.read",
    "files.read",
    "backups.read",
    "snapshots.read",
    "activity.read",
    "players.read",
  ],
  moderator: [
    "console.read",
    "console.send",
    "power.start",
    "power.stop",
    "power.restart",
    "files.read",
    "backups.read",
    "snapshots.read",
    "activity.read",
    "players.read",
    "players.manage",
  ],
  developer: SERVER_PERMISSIONS.filter(
    (p) => !p.startsWith("subusers.") && p !== "settings.reinstall",
  ),
  owner: SERVER_PERMISSIONS,
};

/* --- Presets modifiables par l'administration (§5.2) ---------------------- */

/**
 * Les presets qu'une administration peut redéfinir.
 *
 * « owner » n'en fait pas partie : il ne se délègue pas — l'écran d'invitation
 * ne le propose pas — et il veut dire « tout ». Le restreindre produirait un
 * preset dont le nom mentirait sur son contenu, pour un usage qui n'existe
 * pas. Il reste défini par le code, et ne sert plus que de repli aux lignes
 * anciennes.
 */
export const DELEGABLE_ROLE_PRESETS = ["viewer", "moderator", "developer"] as const;
export type DelegableRolePreset = (typeof DELEGABLE_ROLE_PRESETS)[number];
export type RolePresets = Record<DelegableRolePreset, ServerPermission[]>;

/** Clé de la table `settings` qui porte les presets redéfinis. */
export const ROLE_PRESETS_SETTING_KEY = "subusers.rolePresets";

/** Les presets tels que le code les définit : le repli, et ce que « rétablir » remet. */
export function defaultRolePresets(): RolePresets {
  return {
    viewer: [...ROLE_PRESETS.viewer],
    moderator: [...ROLE_PRESETS.moderator],
    developer: [...ROLE_PRESETS.developer],
  };
}

/**
 * Les permissions d'un preset, validées.
 *
 * Trois refus, chacun avec un message qui nomme la permission fautive :
 *
 * - une permission `admin.*` : un preset décrit ce qu'on délègue **sur un
 *   serveur**, jamais un pouvoir sur la plateforme. Aucune n'existe aujourd'hui
 *   dans `SERVER_PERMISSIONS`, et c'est justement pour cela que le refus est
 *   explicite — le jour où une permission de ce nom apparaîtrait, elle ne
 *   deviendrait pas distribuable par une case cochée ;
 * - une permission inconnue : écrite, elle ne serait jamais vérifiée nulle part
 *   et ferait croire à un droit accordé ;
 * - une liste vide : l'invitation refuse un accès sans permission, un preset
 *   vide pré-cocherait donc un formulaire impossible à envoyer.
 *
 * Les doublons sont retirés plutôt que refusés : ils ne changent rien au sens.
 */
export const RolePresetPermissions = z
  .array(z.string())
  .superRefine((permissions, context) => {
    const administration = permissions.filter((p) => p.startsWith("admin."));
    if (administration.length > 0) {
      context.addIssue({
        code: "custom",
        message: `Une permission d'administration ne peut pas figurer dans un preset : ${administration.join(", ")}.`,
      });
      return;
    }
    const inconnues = permissions.filter(
      (p) => !(SERVER_PERMISSIONS as readonly string[]).includes(p),
    );
    if (inconnues.length > 0) {
      context.addIssue({
        code: "custom",
        message: `Permission inconnue dans un preset : ${inconnues.join(", ")}.`,
      });
      return;
    }
    if (permissions.length === 0) {
      context.addIssue({
        code: "custom",
        message: "Un preset doit accorder au moins une permission.",
      });
    }
  })
  .transform((permissions) => [...new Set(permissions)] as ServerPermission[]);

/**
 * Le jeu complet des presets délégables, tel que l'administration l'enregistre.
 *
 * Strict : une clé « owner » ou mal orthographiée est refusée, pas ignorée —
 * l'ignorer laisserait croire qu'elle a été prise en compte.
 */
export const RolePresetsInput = z
  .object({
    viewer: RolePresetPermissions,
    moderator: RolePresetPermissions,
    developer: RolePresetPermissions,
  })
  .strict();

/** Les presets en vigueur, et ce qui les distingue des valeurs du code. */
export interface RolePresetsView {
  presets: RolePresets;
  defaults: RolePresets;
  /** Presets qui s'écartent du code : l'écran les signale, « rétablir » les ramène. */
  customized: DelegableRolePreset[];
}

/**
 * Les presets en vigueur, à partir de ce que la table `settings` contient.
 *
 * **Repli preset par preset** sur la valeur du code : rien d'enregistré, une
 * ligne abîmée, une permission retirée du catalogue depuis l'enregistrement —
 * dans chaque cas, le preset concerné redevient celui du code, et les autres
 * gardent ce que l'administration a choisi. Tout jeter pour un seul preset
 * illisible effacerait sans prévenir un travail qui, lui, était valable.
 *
 * Le repli n'élargit personne : un preset ne sert qu'à pré-cocher le
 * formulaire d'invitation, les droits accordés sont ceux qu'on envoie.
 */
export function resolveRolePresets(stored: unknown): RolePresetsView {
  const defaults = defaultRolePresets();
  const presets = defaultRolePresets();
  const record =
    stored && typeof stored === "object" && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};

  for (const name of DELEGABLE_ROLE_PRESETS) {
    const parsed = RolePresetPermissions.safeParse(record[name]);
    if (parsed.success) presets[name] = parsed.data;
  }

  const customized = DELEGABLE_ROLE_PRESETS.filter((name) => {
    const current = new Set(presets[name]);
    return current.size !== defaults[name].length || defaults[name].some((p) => !current.has(p));
  });

  return { presets, defaults, customized };
}

export function hasPermission(
  granted: readonly ServerPermission[],
  required: ServerPermission,
): boolean {
  return granted.includes(required);
}

/**
 * Catalogue des permissions, groupé pour l'affichage.
 *
 * Il vit ici et non dans l'interface : une permission ajoutée à
 * `SERVER_PERMISSIONS` sans entrée ici serait vérifiable par l'API mais
 * impossible à accorder depuis l'écran — donc inutilisable, sans qu'aucune
 * erreur ne le signale. Le test associé interdit ce cas.
 */
export interface PermissionDescriptor {
  value: ServerPermission;
  label: string;
  /** Présent quand l'intitulé seul induirait en erreur sur la portée réelle. */
  warning?: string;
}

export interface PermissionGroup {
  key: string;
  label: string;
  description?: string;
  permissions: PermissionDescriptor[];
}

export const PERMISSION_GROUPS: readonly PermissionGroup[] = [
  {
    key: "console",
    label: "Console",
    description: "Lecture de la sortie et envoi de commandes.",
    permissions: [
      { value: "console.read", label: "Voir la console" },
      {
        value: "console.send",
        label: "Envoyer des commandes",
        warning: "Une commande de jeu peut donner les pleins pouvoirs dans le jeu.",
      },
    ],
  },
  {
    key: "power",
    label: "Alimentation",
    permissions: [
      { value: "power.start", label: "Démarrer" },
      { value: "power.stop", label: "Arrêter" },
      { value: "power.restart", label: "Redémarrer" },
      {
        value: "power.kill",
        label: "Tuer le processus",
        warning: "Interrompt le serveur sans sauvegarde : la progression en cours est perdue.",
      },
    ],
  },
  {
    key: "files",
    label: "Fichiers",
    permissions: [
      { value: "files.read", label: "Lire et télécharger" },
      { value: "files.write", label: "Créer et modifier" },
      {
        value: "files.delete",
        label: "Supprimer",
        warning: "Aucune corbeille : un dossier supprimé emporte les mondes qu'il contient.",
      },
      { value: "files.archive", label: "Archiver et extraire" },
      {
        value: "files.sftp",
        label: "Accès SFTP",
        warning: "Contourne l'interface : les fichiers deviennent accessibles hors du panel.",
      },
    ],
  },
  {
    key: "backups",
    label: "Sauvegardes",
    permissions: [
      { value: "backups.read", label: "Lister" },
      { value: "backups.create", label: "Créer" },
      {
        value: "backups.download",
        label: "Télécharger",
        warning:
          "L'archive contient tout le serveur, mots de passe des fichiers de configuration compris.",
      },
      {
        value: "backups.restore",
        label: "Restaurer",
        warning: "Réécrit les fichiers du serveur par ceux de l'archive.",
      },
      { value: "backups.delete", label: "Supprimer et verrouiller" },
    ],
  },
  {
    key: "snapshots",
    label: "Instantanés",
    permissions: [
      { value: "snapshots.read", label: "Lister" },
      { value: "snapshots.create", label: "Prendre et épingler" },
      {
        value: "snapshots.restore",
        label: "Restaurer",
        warning:
          "Arrête le serveur et remet ses fichiers dans l'état de l'instantané ; un instantané de sûreté est pris juste avant.",
      },
    ],
  },
  {
    key: "databases",
    label: "Bases de données",
    permissions: [
      { value: "databases.read", label: "Voir les coordonnées" },
      { value: "databases.create", label: "Créer" },
      { value: "databases.update", label: "Voir et changer le mot de passe" },
      { value: "databases.delete", label: "Supprimer" },
    ],
  },
  {
    key: "schedules",
    label: "Planification",
    permissions: [
      { value: "schedules.read", label: "Lister" },
      { value: "schedules.create", label: "Créer" },
      { value: "schedules.update", label: "Modifier" },
      { value: "schedules.delete", label: "Supprimer" },
    ],
  },
  {
    key: "allocations",
    label: "Réseau",
    permissions: [
      { value: "allocations.read", label: "Voir les ports" },
      { value: "allocations.create", label: "Attribuer un port" },
      { value: "allocations.update", label: "Annoter et définir le port principal" },
      { value: "allocations.delete", label: "Libérer un port" },
    ],
  },
  {
    key: "startup",
    label: "Démarrage",
    permissions: [
      { value: "startup.read", label: "Voir les variables" },
      {
        value: "startup.update",
        label: "Modifier les variables",
        warning: "Les variables contiennent souvent des mots de passe RCON et des clés d'API.",
      },
      { value: "startup.docker-image", label: "Changer l'image Docker" },
    ],
  },
  {
    key: "subusers",
    label: "Accès",
    description: "Gestion des personnes ayant accès au serveur.",
    permissions: [
      { value: "subusers.read", label: "Lister les sous-utilisateurs" },
      {
        value: "subusers.create",
        label: "Inviter",
        warning: "Permet de partager l'accès au serveur avec de nouvelles personnes.",
      },
      { value: "subusers.update", label: "Modifier les permissions" },
      { value: "subusers.delete", label: "Retirer un accès" },
    ],
  },
  {
    key: "settings",
    label: "Paramètres",
    permissions: [
      { value: "settings.rename", label: "Renommer le serveur" },
      {
        value: "settings.reinstall",
        label: "Réinstaller",
        warning: "Réexécute le script d'installation : les fichiers du serveur sont écrasés.",
      },
      { value: "activity.read", label: "Consulter le journal d'activité" },
    ],
  },
  {
    key: "webhooks",
    label: "Rappels sortants",
    description:
      "Prévenir une adresse — un salon Discord, par exemple — quand quelque chose arrive au serveur.",
    permissions: [
      { value: "webhooks.read", label: "Voir les rappels et leur historique" },
      {
        value: "webhooks.manage",
        label: "Déclarer, modifier et supprimer",
        warning: "Le contenu des rappels part vers une adresse choisie par celui qui la déclare.",
      },
    ],
  },
  {
    key: "players",
    label: "Joueurs",
    description: "Voir les joueurs connectés et les modérer par les commandes du jeu.",
    permissions: [
      { value: "players.read", label: "Voir les joueurs connectés" },
      {
        value: "players.manage",
        label: "Expulser, bannir et gérer la liste blanche",
        warning:
          "Nommer un opérateur exige en plus « Envoyer des commandes » : il obtient les pleins pouvoirs dans le jeu.",
      },
    ],
  },
];

/**
 * Ce qu'un compte d'assistance peut faire sur un serveur qu'il ne possède pas.
 *
 * **En lecture seule, et c'est le point.** Diagnostiquer demande de voir la
 * console, les fichiers et les sauvegardes ; cela ne demande ni d'écrire, ni de
 * supprimer, ni d'inviter quelqu'un. Un incident résolu en modifiant le serveur
 * d'un client à son insu est un incident qu'on ne peut plus lui expliquer.
 *
 * `console.send` en est volontairement absent : envoyer une commande dans une
 * console de jeu, c'est agir sur le serveur, pas l'observer. Un administrateur
 * peut le faire ; l'assistance passe par lui.
 *
 * Les actions d'alimentation le sont aussi. Redémarrer coupe les joueurs
 * connectés — c'est une décision qui appartient au client ou à l'hébergeur.
 */
export const SUPPORT_SERVER_PERMISSIONS: readonly ServerPermission[] = [
  "console.read",
  "files.read",
  "backups.read",
  "snapshots.read",
  "databases.read",
  "schedules.read",
  "subusers.read",
  "allocations.read",
  "startup.read",
  "activity.read",
  // L'assistance peut constater qu'un rappel n'arrive pas ; elle ne déclare
  // pas d'adresse à la place du client.
  "webhooks.read",
  // Voir qui est connecté aide à diagnostiquer ; expulser ne regarde que le client.
  "players.read",
];

/** Une permission est-elle dans ce que l'assistance peut exercer ? */
export function isSupportPermission(permission: ServerPermission): boolean {
  return SUPPORT_SERVER_PERMISSIONS.includes(permission);
}
