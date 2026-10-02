/**
 * Ce dont le panel prévient, et par quels moyens.
 *
 * **Une seule liste pour l'API et l'écran.** Elle décide à la fois de ce qu'on
 * propose de régler et de ce que l'émetteur consulte avant d'envoyer. Deux
 * listes finiraient par diverger, et l'écart prendrait la forme la plus
 * fâcheuse : un réglage affiché que rien ne lit, ou un courriel qu'on ne peut
 * pas refuser.
 *
 * **N'y figure que ce que le panel émet vraiment.** Chaque entrée correspond à
 * un `type` posé quelque part dans le code. Un événement listé ici sans
 * émetteur serait un interrupteur qui ne commande rien, et c'est pire que pas
 * d'interrupteur du tout : on croit avoir choisi.
 */

/**
 * Moyens d'acheminement.
 *
 * Trois, et pas un de plus. Discord a longtemps figuré sur l'écran du compte
 * sans qu'aucune ligne de code ne l'envoie : l'interrupteur se cochait, ne
 * s'enregistrait pas, et personne ne recevait rien. Il reviendra le jour où
 * quelque chose émettra vers Discord, pas avant. `push` part vers les
 * téléphones liés au compte (ADR 0010), quand le panel a un chemin pour
 * les notifications poussées.
 */
export const NOTIFICATION_CHANNELS = ["inapp", "email", "push"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export interface NotificationEventDefinition {
  /** Le `type` écrit en base, tel que l'émetteur le pose. */
  type: string;
  /** Regroupement d'affichage. Sert à l'écran, jamais à la décision. */
  group: "server" | "backup" | "billing" | "reseller" | "infrastructure";
  /**
   * Moyens retenus **quand l'utilisateur n'a rien dit**.
   *
   * Le choix par défaut est le sujet : une sauvegarde qui échoue mérite un
   * courriel, parce que personne ne regarde la cloche d'un panel qu'il
   * n'ouvre qu'une fois par mois — et qu'une sauvegarde qu'on croit avoir est
   * pire que pas de sauvegarde. Un serveur installé, non : on vient de
   * demander l'installation, on est devant l'écran.
   */
  defaults: readonly NotificationChannel[];
  /**
   * Vrai quand le choix n'est pas offert.
   *
   * Une suspension pour impayé et un serveur arrêté faute de quota se
   * notifient quoi qu'il arrive : ce sont des décisions prises **contre** le
   * client, et lui laisser couper l'annonce ferait découvrir la coupure par le
   * silence de ses joueurs.
   */
  mandatory?: boolean;
}

export const NOTIFICATION_EVENTS: readonly NotificationEventDefinition[] = [
  { type: "server.installed", group: "server", defaults: ["inapp"] },
  // Le courriel par défaut : une panne arrive quand personne ne regarde le
  // panel, et ce sont les joueurs qui la découvriraient sinon.
  { type: "server.unreachable", group: "server", defaults: ["inapp", "email", "push"] },
  // La cloche seule : le retour se constate, il ne réclame rien.
  // Sur le téléphone, le retour accompagne la panne qu'on y a reçue.
  { type: "server.recovered", group: "server", defaults: ["inapp", "push"] },
  // Le courriel par défaut : sans lui, une invitation attend qu'on ouvre le
  // panel — ce que fait rarement quelqu'un qui n'y a encore aucun serveur.
  { type: "subuser.invited", group: "server", defaults: ["inapp", "email", "push"] },
  { type: "server.transferred", group: "server", defaults: ["inapp", "email", "push"] },
  { type: "server.transfer_failed", group: "server", defaults: ["inapp", "email", "push"] },
  // Le défaut penche vers le courriel : une sauvegarde qu'on croit avoir est
  // pire que pas de sauvegarde du tout.
  { type: "backup.failed", group: "backup", defaults: ["inapp", "email", "push"] },
  // Pour la même raison, et elle vaut encore davantage ici : une sauvegarde
  // ratée se voit dans la liste des sauvegardes, une **planification** cassée
  // ne se voit nulle part. Elle échouait en silence, et celui qui croyait avoir
  // des sauvegardes quotidiennes ne l'apprenait qu'en en ayant besoin.
  { type: "schedule.failed", group: "backup", defaults: ["inapp", "email", "push"] },
  {
    type: "server.quota_stopped",
    group: "server",
    defaults: ["inapp", "email", "push"],
    mandatory: true,
  },
  // La cloche seule : une extension en retard d'une version n'a rien
  // d'urgent, et la veille repasse chaque jour.
  { type: "marketplace.update_available", group: "server", defaults: ["inapp"] },
  // Pour qui exploite les machines : administrateurs et revendeur du node.
  { type: "node.unreachable", group: "infrastructure", defaults: ["inapp", "email", "push"] },
  { type: "node.recovered", group: "infrastructure", defaults: ["inapp", "push"] },
  { type: "reseller.quota_enforced", group: "reseller", defaults: ["inapp", "email", "push"] },
  { type: "billing.due_soon", group: "billing", defaults: ["inapp", "email", "push"] },
  { type: "billing.overdue", group: "billing", defaults: ["inapp", "email", "push"] },
  {
    type: "billing.suspended",
    group: "billing",
    defaults: ["inapp", "email", "push"],
    mandatory: true,
  },
] as const;

const BY_TYPE = new Map(NOTIFICATION_EVENTS.map((event) => [event.type, event]));

export function notificationEvent(type: string): NotificationEventDefinition | null {
  return BY_TYPE.get(type) ?? null;
}

/**
 * Moyens à employer pour un événement, compte tenu de ce que l'utilisateur a
 * réglé.
 *
 * Trois règles, dans cet ordre :
 *
 * 1. **La cloche est toujours servie.** Elle ne dérange personne, et une
 *    notification qu'on n'a nulle part n'existe pas. Un utilisateur qui coupe
 *    tout doit encore pouvoir retrouver ce qui s'est passé.
 * 2. **Un événement obligatoire ignore le réglage.** Voir `mandatory`.
 * 3. **Un type inconnu passe par la cloche seule.** Un émetteur ajouté sans
 *    entrée ici ne doit pas se mettre à écrire des courriels que personne n'a
 *    acceptés — le défaut sûr est le moins intrusif.
 *
 * Le téléphone (`push`) est arrivé après des réglages déjà enregistrés : une
 * ligne qui ne dit rien de lui (ni `push`, ni `-push`) suit le défaut de
 * l'événement, au lieu de couper le téléphone à qui n'a jamais eu le choix.
 */
export function channelsFor(
  type: string,
  stored: readonly string[] | null,
): readonly NotificationChannel[] {
  const event = notificationEvent(type);
  if (!event) return ["inapp"];
  if (event.mandatory) return event.defaults;

  const chosen = stored === null ? event.defaults : stored;
  const push =
    chosen.includes("push") ||
    (!chosen.includes(PUSH_OFF) && stored !== null && event.defaults.includes("push"));
  const channels = NOTIFICATION_CHANNELS.filter((channel) =>
    channel === "push" ? push : chosen.includes(channel),
  );

  return channels.includes("inapp") ? channels : ["inapp", ...channels];
}

/** Marque d'un téléphone coupé par la personne, rangée avec ses moyens. */
export const PUSH_OFF = "-push";

/**
 * Ce qui se range pour un choix : les moyens connus, et le téléphone dit
 * explicitement, coupé ou non (voir `channelsFor`).
 */
export function storedChannels(wanted: readonly string[]): string[] {
  const clean: string[] = NOTIFICATION_CHANNELS.filter((channel) => wanted.includes(channel));
  return clean.includes("push") ? clean : [...clean, PUSH_OFF];
}
