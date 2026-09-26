import { z } from "zod";

/**
 * États de gestion, propres au panel et stockés en base.
 *
 * Ils se distinguent des états du conteneur (`offline`, `starting`, `running`,
 * `stopping`), qui appartiennent à Wings, sont rapportés en direct et ne sont
 * jamais écrits : les dupliquer créerait une seconde vérité qui finirait par
 * mentir. La colonne `servers.state` n'accepte donc que cette liste.
 */
export const SERVER_MANAGED_STATES = [
  "installing",
  "install_failed",
  "suspended",
  "restoring",
  "transferring",
] as const;

export const ServerManagedState = z.enum(SERVER_MANAGED_STATES);
export type ServerManagedState = z.infer<typeof ServerManagedState>;

/**
 * État affiché d'un serveur : la réunion des deux origines.
 *
 * `crash_loop` n'appartient ni à l'une ni à l'autre — il est déduit des arrêts
 * successifs observés, donc calculé à la lecture et jamais stocké.
 */
export const ServerState = z.enum([
  "offline",
  "starting",
  "running",
  "stopping",
  ...SERVER_MANAGED_STATES,
  "crash_loop",
]);
export type ServerState = z.infer<typeof ServerState>;

/**
 * Ce qui empêche un serveur d'obéir, état par état.
 *
 * **Une seule liste pour deux usages**, et l'ordre compte : l'API s'en sert
 * pour refuser, l'interface pour ne pas proposer. L'écran peut être contourné,
 * la route non — mais un écran qui propose ce que la route refuse fait cliquer
 * puis échouer, ce qui est la pire façon d'apprendre une règle.
 *
 * C'est exactement ce qui se passait : les boutons d'alimentation ne lisaient
 * que l'état du **conteneur**, rapporté par le daemon. Pendant une
 * installation, le conteneur est à l'arrêt — donc « Start » s'affichait actif,
 * et l'API répondait 409 après le clic.
 *
 * `transitoire` sépare ce qui se termine tout seul de ce qui demande un geste.
 * La distinction décide de ce que l'écran dit : « patientez » n'est pas un
 * conseil utile devant un serveur suspendu.
 */
export interface ServerBlock {
  /** Ce qui se passe, en deux mots. */
  readonly label: string;
  /** Pourquoi rien n'obéit, et quoi faire. */
  readonly body: string;
  /** Cela se termine sans intervention ? */
  readonly transient: boolean;
}

export const SERVER_BLOCKS: Record<ServerManagedState, ServerBlock> = {
  installing: {
    label: "Installation en cours",
    body: "Le daemon installe le programme du serveur et ses fichiers. Attendez qu'il ait terminé : le démarrer maintenant lancerait un programme à moitié écrit.",
    transient: true,
  },
  restoring: {
    label: "Restauration en cours",
    body: "Une sauvegarde est en train d'être rendue sur ce serveur. Démarrer maintenant écraserait ce qui est en cours d'écriture.",
    transient: true,
  },
  transferring: {
    label: "Transfert en cours",
    body: "Ce serveur change de machine. Tant que la copie n'est pas finie, il n'existe complètement ni d'un côté ni de l'autre.",
    transient: true,
  },
  install_failed: {
    label: "Installation échouée",
    body: "L'installation ne s'est pas terminée : il n'y a rien à lancer. Relancez une installation depuis les paramètres du serveur.",
    transient: false,
  },
  suspended: {
    label: "Serveur suspendu",
    body: "Ce serveur est suspendu par l'hébergeur. Contactez-le : cette décision ne se lève pas depuis cet espace.",
    transient: false,
  },
};

/**
 * Le blocage d'un état, ou `null` s'il n'en pose aucun.
 *
 * Accepte n'importe quelle chaîne parce que l'état vient de la base et du
 * daemon : un état d'exécution (`running`, `offline`…) ne bloque rien, et le
 * traiter comme inconnu plutôt que comme une erreur évite qu'une valeur
 * inattendue fige l'interface.
 */
export function serverBlock(state: string | null | undefined): ServerBlock | null {
  if (!state) return null;
  return SERVER_BLOCKS[state as ServerManagedState] ?? null;
}

/**
 * Ce qu'une tâche planifiée doit faire d'un serveur bloqué.
 *
 * Le minuteur n'avait aucune règle : il envoyait ses étapes quel que soit
 * l'état. Wings en rattrapait une partie — il refuse `start` pendant une
 * installation et sur un serveur suspendu — mais il **fabrique volontiers une
 * sauvegarde d'un serveur suspendu**. Un serveur coupé par l'enveloppe de son
 * hébergeur continuait donc, chaque nuit, de remplir le disque du node et son
 * propre quota. C'est précisément ce que la suspension devait arrêter.
 *
 * Les deux issues ne se valent pas, et `transient` tranche :
 *
 * - **reporter** — une installation dure quelques minutes. Sauter ferait
 *   perdre la sauvegarde de la nuit pour une gêne qui aura disparu avant le
 *   café ; il suffit de repasser tout à l'heure.
 * - **sauter** — un serveur suspendu le reste jusqu'à ce que quelqu'un décide
 *   le contraire. Réessayer sans fin n'y changerait rien, et compter cela
 *   comme un échec accuserait une tâche qui n'a rien tenté : le propriétaire
 *   recevrait une alerte par nuit pour une situation qu'il connaît.
 */
/**
 * Une réinstallation a-t-elle un sens dans cet état ?
 *
 * Elle ne suit pas les autres blocages, et c'est volontaire :
 * `install_failed` bloque tout le reste et **appelle** précisément une
 * réinstallation — son propre message dit « relancez une installation ».
 * Refuser là renverrait vers le seul geste qu'on vient d'interdire.
 *
 * La règle vit ici parce qu'elle se lit des deux côtés : l'API refuse, et
 * l'écran grise. Écrite deux fois, elle aurait fini par dire deux choses.
 */
export function reinstallBlocked(state: string | null | undefined): boolean {
  if (state === "install_failed") return false;
  return serverBlock(state) !== null;
}

/**
 * La suppression d'une sauvegarde est-elle refusée dans cet état ?
 *
 * Seulement pendant une restauration. Supprimer libère de la place, et reste
 * donc permis sur un serveur suspendu ou en échec d'installation ; mais
 * pendant une restauration, effacer l'archive qu'on rend ferait répondre 404
 * au compte rendu de fin de Wings, qui ne le rejoue pas : le serveur resterait
 * en `restoring` sans issue. Le panel ne retient pas quelle archive est
 * rendue, d'où un refus pour toutes, le temps de la restauration.
 *
 * Même règle des deux côtés : l'API refuse, l'écran grise.
 */
export function backupDeletionBlocked(state: string | null | undefined): boolean {
  return state === "restoring";
}

export type ScheduleVerdict = "run" | "postpone" | "skip";

export function scheduleVerdict(state: string | null | undefined): ScheduleVerdict {
  const bloc = serverBlock(state);
  if (!bloc) return "run";
  return bloc.transient ? "postpone" : "skip";
}

export const PowerSignal = z.enum(["start", "stop", "restart", "kill"]);
export type PowerSignal = z.infer<typeof PowerSignal>;

export const ServerLimits = z.object({
  memoryMb: z.number().int().nonnegative(),
  swapMb: z.number().int(),
  diskMb: z.number().int().nonnegative(),
  cpuPct: z.number().int().nonnegative(),
  ioWeight: z.number().int().min(10).max(1000).default(500),
});
export type ServerLimits = z.infer<typeof ServerLimits>;

/**
 * Ce qu'on demande de changer sur un serveur existant.
 *
 * Chaque champ est facultatif, et l'absence veut dire « ne touche pas ». La
 * distinction compte : une facturation qui n'envoie que la mémoire ne doit pas
 * remettre le disque à zéro parce que son formulaire ne le portait pas.
 *
 * Le schéma vit ici parce que trois portes l'emploient — l'API applicative,
 * l'espace revendeur et l'administration. Trois copies auraient accepté trois
 * choses légèrement différentes.
 */
export const ServerLimitsPatch = z
  .object({
    memoryMb: z.number().int().nonnegative().optional(),
    diskMb: z.number().int().nonnegative().optional(),
    cpuPct: z.number().int().nonnegative().optional(),
    swapMb: z.number().int().optional(),
    allocations: z.number().int().nonnegative().optional(),
    backups: z.number().int().nonnegative().optional(),
    databases: z.number().int().nonnegative().optional(),
  })
  // Un corps vide ne changerait rien tout en ayant l'air d'avoir agi : mieux
  // vaut le refuser que rendre 200 sur un geste qui n'a pas eu lieu.
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "Indiquez au moins une limite à changer.",
  });

export type ServerLimitsPatch = z.infer<typeof ServerLimitsPatch>;

/**
 * Image de conteneur et commande de démarrage, réglées par l'administration.
 *
 * Bornées (rapport ASVS, NC-23) : l'image par sa colonne (255), qu'un texte
 * plus long faisait tomber en erreur 500 ; la commande comme dans l'éditeur
 * d'eggs (`EggDraft.startup`), où elle naît. Absent vaut « ne touche pas ».
 */
export const ServerRuntimeInput = z.object({
  dockerImage: z.string().max(255).optional(),
  startup: z.string().max(10_000).optional(),
  oomKiller: z.boolean().optional(),
});
export type ServerRuntimeInput = z.infer<typeof ServerRuntimeInput>;

export const ServerFeatureLimits = z.object({
  backups: z.number().int().nonnegative(),
  databases: z.number().int().nonnegative(),
  allocations: z.number().int().nonnegative(),
});
export type ServerFeatureLimits = z.infer<typeof ServerFeatureLimits>;

export const Allocation = z.object({
  id: z.string().uuid(),
  ip: z.string(),
  ipAlias: z.string().nullable(),
  port: z.number().int().min(1).max(65535),
  isDefault: z.boolean(),
});
export type Allocation = z.infer<typeof Allocation>;

export const Server = z.object({
  id: z.string().uuid(),
  shortId: z.string().length(8),
  name: z.string().min(1).max(191),
  description: z.string().max(500).nullable(),
  state: ServerState,
  node: z.object({ id: z.string().uuid(), name: z.string() }),
  egg: z.object({ id: z.string().uuid(), name: z.string(), nest: z.string() }),
  allocation: Allocation,
  limits: ServerLimits,
  featureLimits: ServerFeatureLimits,
  isOwner: z.boolean(),
  isFavorite: z.boolean().default(false),
  createdAt: z.string().datetime(),
});
export type Server = z.infer<typeof Server>;

/** Instantané de ressources envoyé chaque seconde par le daemon. */
export const ServerResources = z.object({
  state: ServerState,
  cpuPct: z.number().nonnegative(),
  memoryBytes: z.number().int().nonnegative(),
  diskBytes: z.number().int().nonnegative(),
  networkRxBytes: z.number().int().nonnegative(),
  networkTxBytes: z.number().int().nonnegative(),
  uptimeMs: z.number().int().nonnegative(),
  players: z.object({ online: z.number().int(), max: z.number().int() }).nullable(),
});
export type ServerResources = z.infer<typeof ServerResources>;

export const CreateServerInput = z.object({
  name: z.string().min(1).max(191),
  description: z.string().max(500).optional(),
  ownerId: z.string().uuid(),
  eggId: z.string().uuid(),
  nodeId: z.string().uuid().optional(),
  allocationId: z.string().uuid().optional(),
  limits: ServerLimits,
  featureLimits: ServerFeatureLimits,
  environment: z.record(z.string(), z.string()).default({}),
  startOnCompletion: z.boolean().default(true),
});
export type CreateServerInput = z.infer<typeof CreateServerInput>;

/**
 * Fraîcheur au-delà de laquelle un relevé ne dit plus rien.
 *
 * Trois minutes, soit trois tours de relevé : assez pour qu'une mesure manquée
 * n'efface pas l'affichage, assez court pour qu'un serveur arrêté cesse vite de
 * paraître en marche. Passé ce délai, l'état rendu est `null` — « je ne sais
 * pas » — et non un état périmé que personne ne saurait lire comme tel.
 *
 * **Partagée, et pas recopiée.** La valeur vivait dans le service client, seul
 * à composer l'état d'exécution ; la liste d'administration, elle, affichait
 * `servers.state` — l'état de *gestion*, nul en fonctionnement normal — et
 * rendait donc « État inconnu » sur des serveurs parfaitement mesurés. Les deux
 * écrans lisent maintenant la même fenêtre, et une seconde copie de ce nombre
 * les ferait diverger au premier ajustement.
 */
export const RUNTIME_STATE_FRESH_WINDOW = "3 minutes";

/**
 * Le blocage d'une machine qui ne répond plus.
 *
 * **Ce n'est pas un état du serveur**, et c'est pourquoi il ne figure pas dans
 * `SERVER_BLOCKS` : rien n'a été décidé à son sujet, et il n'a peut-être rien.
 * C'est la machine qui s'est tue. Mais du point de vue de l'interface, la
 * conséquence est exactement la même que pendant une installation — **tout ce
 * qui passe par le daemon échouera** : la console, les fichiers, les
 * sauvegardes, les bases, l'alimentation.
 *
 * Il est donc rendu sous la même forme, pour que les écrans n'aient qu'une
 * notion à consulter. `transient` est vrai : une machine revient, et le plus
 * souvent sans que le client ait quoi que ce soit à faire.
 */
export function nodeOutageBlock(unreachableSince: string | null | undefined): ServerBlock | null {
  if (!unreachableSince) return null;
  return {
    label: "Machine injoignable",
    body:
      "La machine qui héberge ce serveur ne répond plus. Nous ne savons pas ce que fait votre " +
      "serveur — il tourne peut-être encore. Rien n'est perdu, et rien n'est à faire de votre " +
      "côté : l'hébergeur est prévenu automatiquement.",
    transient: true,
  };
}
