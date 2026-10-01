/**
 * Ce que chaque rôle a le droit de décider en créant un serveur.
 *
 * Trois façons de remplir le même formulaire, et une seule règle : plus on
 * répond de la machine, plus on choisit. Un client n'arbitre rien — il prend
 * une offre. Un revendeur arbitre sur **son** matériel, dans les limites de ce
 * matériel. Un administrateur arbitre partout.
 *
 * Ce fichier est la source unique de cette règle. L'API s'en sert pour refuser,
 * l'interface pour ne pas proposer — et c'est bien dans cet ordre : l'écran
 * peut être contourné, la route non.
 */

export type ProvisioningMode =
  /** Offres toutes faites, localisation. Aucun nombre à saisir. */
  | "guided"
  /** Ressources ajustables, bornées par la capacité du node choisi. */
  | "assisted"
  /** Tout est libre, y compris le node, le propriétaire et l'image Docker. */
  | "advanced";

export function provisioningMode(role: string): ProvisioningMode {
  if (role === "admin") return "advanced";
  if (role === "reseller") return "assisted";
  return "guided";
}

/**
 * Un mode accepte-t-il des quantités explicites ?
 *
 * En `guided`, le corps de la requête ne porte qu'un identifiant d'offre :
 * accepter une quantité de mémoire depuis le navigateur laisserait n'importe
 * qui s'attribuer le node entier.
 */
export function acceptsExplicitResources(mode: ProvisioningMode): boolean {
  return mode !== "guided";
}

/** Un mode laisse-t-il désigner le node, plutôt que de le faire choisir par le panel ? */
export function choosesNode(mode: ProvisioningMode): boolean {
  return mode !== "guided";
}

/**
 * Un mode laisse-t-il créer le serveur pour quelqu'un d'autre ?
 *
 * Le revendeur aussi, désormais. Il ne le pouvait pas, et cela le privait de
 * son métier : livrer un serveur à un client passait forcément par sa
 * boutique, par clé applicative. Un revendeur sans boutique — celui qui prend
 * une enveloppe et sert quelques clients à la main — ne pouvait servir
 * personne.
 *
 * Les deux modes ne donnent pas le même pouvoir pour autant, et c'est
 * `resolveOwner` qui fait la différence : l'administrateur crée pour qui il
 * veut, le revendeur seulement pour un compte **libre ou déjà sien**. Sans
 * cette borne, il annexerait le client d'un confrère en lui posant un serveur.
 */
export function choosesOwner(mode: ProvisioningMode): boolean {
  return mode === "advanced" || mode === "assisted";
}

/**
 * Ce que le revendeur laisse la plateforme faire sur son parc.
 *
 * Trois niveaux, parce que le réglage précédent n'en avait que deux et qu'il
 * n'en tenait qu'un : il refusait la **création** sur le compte du revendeur,
 * et laissait malgré tout l'administration ouvrir la console, écrire dans les
 * fichiers et supprimer n'importe lequel de ses serveurs. Le revendeur croyait
 * fermer une porte ; il n'en fermait qu'une sur trois.
 */
/**
 * Où en est le certificat TLS d'un domaine de revendeur.
 *
 * Le panel ne délivre rien lui-même : un agent tourne sur le serveur web,
 * appelle certbot et rend compte. Cette fonction ne fait que lire son compte
 * rendu — quatre champs indépendants — et en tirer la seule chose qui
 * intéresse celui qui regarde l'écran : **est-ce que les clients de ce
 * revendeur voient un avertissement de sécurité, et si oui pourquoi**.
 *
 * `renewing` mérite d'exister à part : un certificat valide **et** un échec
 * veulent dire qu'un renouvellement a échoué alors que l'ancien tient encore.
 * C'est le seul état où tout va bien à l'écran du client et où il faut agir
 * quand même — l'écraser en « actif » ou en « échec » perdrait l'un des deux
 * faits.
 */
export type CertificateStanding =
  /** Le domaine n'est pas vérifié : aucun certificat n'est demandé. */
  | "not_sought"
  /** Vérifié, jamais tenté : l'agent le prendra à son prochain tour. */
  | "queued"
  /** Un certificat valide, rien à signaler. */
  | "active"
  /** Valide mais proche de l'échéance, et le renouvellement a échoué. */
  | "renewing"
  /** Aucun certificat, et la dernière tentative a échoué. */
  | "failed"
  /** Aucun certificat, aucun échec, mais une tentative a eu lieu. */
  | "unknown";

/** Jours avant l'échéance à partir desquels on parle de renouvellement. */
export const CERTIFICATE_RENEWAL_DAYS = 30;

export function certificateStanding(
  domain: {
    verifiedAt: string | null;
    certificateIssuedAt: string | null;
    certificateExpiresAt: string | null;
    certificateAttemptedAt: string | null;
    certificateFailure: string | null;
  },
  now: number = Date.now(),
): CertificateStanding {
  // Un domaine non vérifié n'est pas en attente de certificat : rien ne prouve
  // encore qu'il appartienne à ce revendeur, et rien ne sera demandé pour lui.
  if (domain.verifiedAt === null) return "not_sought";

  /*
   * Un certificat expiré n'en est plus un : le navigateur du client affiche
   * l'avertissement, exactement comme s'il n'y en avait jamais eu. Le compter
   * valide sur la seule foi de sa date d'émission rendait « actif » un domaine
   * que tous ses visiteurs voyaient en rouge.
   */
  const expire =
    domain.certificateExpiresAt !== null && new Date(domain.certificateExpiresAt).getTime() <= now;
  const valide = domain.certificateIssuedAt !== null && !expire;
  const echec = domain.certificateFailure !== null;

  if (valide) {
    // L'échec l'emporte sur la validité : c'est lui qui demande un geste.
    return echec ? "renewing" : "active";
  }

  if (echec) return "failed";
  if (domain.certificateAttemptedAt === null) return "queued";

  /*
   * Tenté, sans certificat et sans motif : l'agent a rendu un compte rendu
   * incomplet. Rare, mais le dire vaut mieux que de choisir à sa place entre
   * « ça va » et « c'est cassé ».
   */
  return "unknown";
}

/** Le certificat expire-t-il bientôt ? `null` quand on ne sait pas. */
export function certificateExpiringSoon(
  expiresAt: string | null,
  now: number = Date.now(),
): boolean | null {
  if (expiresAt === null) return null;
  const reste = new Date(expiresAt).getTime() - now;
  return reste < CERTIFICATE_RENEWAL_DAYS * 24 * 60 * 60 * 1000;
}

export const PLATFORM_ACCESS_LEVELS = [
  /** L'administration crée sur son compte et gère ses serveurs. */
  "provision",
  /** Elle regarde, elle n'agit pas. C'est le niveau par défaut. */
  "read_only",
  /** Elle ne voit rien — y compris depuis ses propres écrans. */
  "none",
] as const;

export type PlatformAccess = (typeof PLATFORM_ACCESS_LEVELS)[number];

/**
 * Lit un niveau venu de la base sans jamais élargir en cas de doute.
 *
 * Une valeur inconnue rend `read_only` et non `provision` : si la colonne
 * portait un jour quelque chose d'inattendu, mieux vaut regarder sans agir
 * qu'agir sans regarder.
 */
export function platformAccessOf(value: string | null | undefined): PlatformAccess {
  return (PLATFORM_ACCESS_LEVELS as readonly string[]).includes(value ?? "")
    ? (value as PlatformAccess)
    : "read_only";
}

/**
 * Ce que chaque niveau veut dire, et ce qu'il coûte.
 *
 * Le coût est écrit ici, avec le niveau, et non dans une note à côté : fermer
 * l'accès a une conséquence que le revendeur doit lire **au moment où il
 * choisit**, pas découvrir au premier incident.
 *
 * Cette conséquence porte sur le support. La plateforme dépanne deux choses
 * différentes — la machine, et le logiciel qui tourne dessus. La première ne
 * demande aucun accès au serveur ; la seconde en demande un. Un revendeur qui
 * ferme tout garde le support d'infrastructure et reprend à sa charge tout ce
 * qui touche au logiciel de ses clients.
 */
export interface PlatformAccessMeta {
  readonly label: string;
  readonly body: string;
  /** Ce que la plateforme pourra encore faire pour ses clients, et pas faire. */
  readonly support: string;
}

export const PLATFORM_ACCESS_META: Record<PlatformAccess, PlatformAccessMeta> = {
  provision: {
    label: "Édition et création",
    body: "L'administration de la plateforme peut créer des serveurs sur votre compte et gérer ceux de vos clients : console, fichiers, alimentation.",
    support:
      "Le support peut dépanner jusqu'au logiciel installé sur le service — c'est le niveau où il vous décharge le plus.",
  },
  read_only: {
    label: "Lecture seule",
    body: "L'administration voit votre parc et peut diagnostiquer, mais n'agit pas : ni console, ni fichiers, ni alimentation, ni création sur votre compte.",
    support:
      "Le support peut constater une panne et vous dire ce qu'il voit, pas la réparer. Tout ce qui touche au logiciel de vos clients revient à vous.",
  },
  none: {
    label: "Aucune visibilité",
    body: "Vos serveurs n'apparaissent nulle part côté plateforme, pas même dans ses écrans d'administration.",
    support:
      "Il ne reste que le support d'infrastructure : machine, réseau, daemon. Plus rien sur ce qui tourne dessus — un client bloqué par son logiciel n'aura que vous.",
  },
};

/** La plateforme peut-elle créer un serveur sur le compte de ce revendeur ? */
export function platformMayProvision(level: PlatformAccess): boolean {
  return level === "provision";
}

/** Peut-elle agir sur ses serveurs — console, fichiers, alimentation ? */
export function platformMayManage(level: PlatformAccess): boolean {
  return level === "provision";
}

/** Peut-elle seulement les voir ? */
export function platformMaySee(level: PlatformAccess): boolean {
  return level !== "none";
}

/** Ce qu'il faut savoir pour dire à qui un serveur se rattache. */
export interface AttributionInput {
  /** Le rôle du demandeur. */
  readonly role: string;
  /** Son identifiant. */
  readonly id: string;
  /**
   * Le revendeur pour le compte de qui la plateforme agit, s'il y en a un.
   *
   * C'est le cas d'une clé applicative bornée : la boutique d'un revendeur
   * appelle l'API de la plateforme, mais commande pour elle-même.
   */
  readonly onBehalfOf?: string | null;
  /** Le propriétaire de la machine où le serveur va se poser, ou `null`. */
  readonly nodeOwnerId: string | null;
}

/**
 * À quel revendeur un serveur se rattache, au moment où il naît.
 *
 * Une phrase, trois cas : **celui pour qui le serveur est créé**.
 *
 * - un revendeur qui provisionne, depuis son espace ou depuis sa boutique,
 *   crée pour lui-même ;
 * - la plateforme qui provisionne sur la machine d'un revendeur crée pour
 *   lui — c'est déjà le plafond qu'on lui oppose au quota, ce doit donc être
 *   aussi la consommation qu'on lui compte ;
 * - le reste appartient à la plateforme, et vaut `null`.
 *
 * Le rattachement ne se lit **pas** sur le compte du client : un compte
 * n'appartient à personne, et le même client peut acheter chez deux revendeurs.
 *
 * La règle vit ici, avec les autres règles de provisionnement, parce qu'elle
 * décide de trois choses qui doivent s'accorder — ce que le quota refuse, ce
 * que la part d'un node compte, et ce qu'une clé applicative voit. Les trois
 * lisaient la même colonne, que personne n'écrivait.
 */
export function attributedReseller(demande: AttributionInput): string | null {
  if (demande.role === "reseller") return demande.id;
  return demande.onBehalfOf ?? demande.nodeOwnerId;
}

/**
 * Bornes absolues d'une ressource.
 *
 * Elles ne remplacent pas le contrôle de capacité du node — elles l'encadrent.
 * Un node de 512 Go accepterait sinon un serveur de 512 Go, ce qui n'est pas
 * une allocation mais une faute de frappe.
 */
export interface ResourceBounds {
  readonly min: number;
  readonly max: number;
  /** Pas conseillé dans l'interface. Sans effet sur la validation. */
  readonly step: number;
}

export const RESOURCE_BOUNDS = {
  /** Mémoire, en Mo. En dessous de 256, aucun serveur de jeu ne démarre. */
  memoryMb: { min: 256, max: 512 * 1024, step: 256 },
  /** Disque, en Mo. */
  diskMb: { min: 1024, max: 4 * 1024 * 1024, step: 1024 },
  /**
   * Processeur, en pourcentage d'un cœur : 100 = un cœur, 400 = quatre.
   *
   * Zéro est **permis** et signifie « sans limite », comme dans Wings. Le
   * minimum ne s'applique donc qu'aux valeurs non nulles — c'est pour cela que
   * la validation le traite à part.
   */
  cpuPct: { min: 0, max: 6400, step: 25 },
  /** Swap, en Mo. Zéro désactive, -1 laisse illimité côté Docker. */
  swapMb: { min: -1, max: 128 * 1024, step: 512 },
  /** Ports supplémentaires, en plus de l'allocation principale. */
  allocations: { min: 1, max: 32, step: 1 },
  backups: { min: 0, max: 100, step: 1 },
  databases: { min: 0, max: 50, step: 1 },
} as const satisfies Record<string, ResourceBounds>;

export type ResourceKey = keyof typeof RESOURCE_BOUNDS;

/** Quantités demandées, en mode `assisted` ou `advanced`. */
export interface ResourceRequest {
  memoryMb: number;
  diskMb: number;
  cpuPct: number;
  swapMb: number;
  allocations: number;
  backups: number;
  databases: number;
  /**
   * Instantanés épinglés au plus (ADR 0009) ; absent ou `null`, la limite
   * par défaut du node. Hors de `RESOURCE_BOUNDS` : ce n'est pas une
   * ressource de la machine, et un facturier qui ne l'envoie pas reste valable.
   */
  snapshots?: number | null;
}

export type ResourceProblem =
  | { kind: "out-of-bounds"; resource: ResourceKey; min: number; max: number }
  | { kind: "not-integer"; resource: ResourceKey };

/**
 * Contrôle des bornes, sans connaissance du node.
 *
 * Volontairement séparé du contrôle de capacité : celui-ci est pur et
 * vérifiable, celui-là demande la base. Les mélanger obligerait à une base de
 * données pour tester qu'on refuse bien une mémoire négative.
 */
export function checkResources(request: ResourceRequest): ResourceProblem[] {
  const problems: ResourceProblem[] = [];

  for (const key of Object.keys(RESOURCE_BOUNDS) as ResourceKey[]) {
    const value = request[key];
    const bounds = RESOURCE_BOUNDS[key];

    if (!Number.isInteger(value)) {
      problems.push({ kind: "not-integer", resource: key });
      continue;
    }

    // `cpuPct` à zéro vaut « sans limite » et court-circuite le minimum, qui
    // n'a de sens que pour une limite réellement posée.
    if (key === "cpuPct" && value === 0) continue;

    if (value < bounds.min || value > bounds.max) {
      problems.push({ kind: "out-of-bounds", resource: key, min: bounds.min, max: bounds.max });
    }
  }

  return problems;
}

/* --- Enveloppe de ressources d'un revendeur ------------------------------- */

/**
 * Plafond accordé à un revendeur, toutes machines confondues.
 *
 * Le quota compte **aussi** ce qui tourne sur le matériel du revendeur : un
 * revendeur possédant 64 Go et disposant d'un quota de 32 Go n'en exploite que
 * la moitié. La plateforme borne ce qui est revendu, pas ce qui est branché,
 * et les deux ne coïncident pas.
 *
 * `null` sur une dimension vaut **sans limite**, jamais zéro : à la mise en
 * service personne n'a d'enveloppe, et lire l'absence comme un zéro
 * interdirait d'un coup toute création à tout le monde.
 */
export interface ResellerQuota {
  readonly memoryMb: number | null;
  readonly diskMb: number | null;
  readonly serversMax: number | null;
}

/** Quota par défaut, en l'absence de ligne en base. */
export const UNLIMITED_QUOTA: ResellerQuota = {
  memoryMb: null,
  diskMb: null,
  serversMax: null,
};

/**
 * Ce qui est déjà consommé.
 *
 * Union, pas somme de deux ensembles : un serveur appartenant au revendeur
 * **et** hébergé sur son node ne compte qu'une fois. C'est le cas courant, et
 * le compter deux fois diviserait l'enveloppe par deux sans prévenir.
 */
export interface QuotaUsage {
  readonly memoryMb: number;
  readonly diskMb: number;
  readonly servers: number;
}

export type QuotaDimension = "memoryMb" | "diskMb" | "servers";

export interface QuotaProblem {
  readonly kind: "quota-exceeded";
  readonly dimension: QuotaDimension;
  /** Plafond accordé. Jamais `null` ici : une dimension sans limite ne produit pas de problème. */
  readonly limit: number;
  readonly used: number;
  readonly requested: number;
}

/**
 * Le revendeur a-t-il encore la place pour ce serveur ?
 *
 * Pur, comme `checkResources` : la lecture de la consommation demande la base,
 * l'arbitrage non. On peut donc vérifier qu'un dépassement d'un mégaoctet est
 * refusé sans monter une base de données.
 *
 * Un revendeur **déjà** au-delà de son plafond — parce qu'on vient de le
 * réduire — ne voit pas ses serveurs coupés : il ne peut simplement plus en
 * créer. Cela tombe de la comparaison `used + requested > limit`, et c'est le
 * comportement voulu : réduire une enveloppe est une décision commerciale, pas
 * un ordre d'extinction.
 */
/**
 * Ce qu'une consommation **supplémentaire** heurterait dans l'enveloppe.
 *
 * `servers` est un paramètre et non un `1` en dur, parce que la création n'est
 * pas le seul geste qui consomme : agrandir un serveur existant prend de la
 * mémoire et du disque **sans** ajouter de serveur. Compter un serveur de plus
 * refuserait l'agrandissement à tout revendeur déjà au plafond du nombre —
 * alors qu'il ne demande pas à en créer un.
 *
 * Les quantités sont des **écarts**, pas des totaux : passer de 2 à 4 Go
 * demande 2 Go, et réduire ne demande rien.
 */
export function checkQuotaGrowth(
  quota: ResellerQuota,
  usage: QuotaUsage,
  growth: { memoryMb: number; diskMb: number; servers: number },
): QuotaProblem[] {
  const problems: QuotaProblem[] = [];

  const push = (dimension: QuotaDimension, limit: number | null, used: number, wanted: number) => {
    if (limit === null) return;
    // Une demande nulle ou négative ne peut rien dépasser : un revendeur déjà
    // au-delà de son plafond doit pouvoir **réduire** un serveur, et le
    // refuser l'enfermerait dans le dépassement qu'on lui reproche.
    if (wanted <= 0) return;
    if (used + wanted > limit) {
      problems.push({ kind: "quota-exceeded", dimension, limit, used, requested: wanted });
    }
  };

  push("memoryMb", quota.memoryMb, usage.memoryMb, growth.memoryMb);
  push("diskMb", quota.diskMb, usage.diskMb, growth.diskMb);
  if (growth.servers > 0) {
    push("servers", quota.serversMax, usage.servers, growth.servers);
  }

  return problems;
}

export function checkQuota(
  quota: ResellerQuota,
  usage: QuotaUsage,
  requested: Pick<ResourceRequest, "memoryMb" | "diskMb">,
): QuotaProblem[] {
  return checkQuotaGrowth(quota, usage, { ...requested, servers: 1 });
}

/** Libellés français, pour un message d'erreur lisible côté API comme côté écran. */
/**
 * Qualité d'un relevé de consommation.
 *
 * `estimated` et `partial` veulent dire la même chose pour qui décide : le
 * chiffre est **majoré** par les limites accordées, donc au-dessus du réel.
 */
export type UsageBasis = "measured" | "estimated" | "partial";

/**
 * Ce qui va réellement arriver au revendeur, vu son enveloppe.
 *
 * Pas un niveau de gravité : une **prévision**. L'écran doit dire ce qui
 * l'attend, et les quatre cas ne s'annoncent pas de la même façon.
 */
export type QuotaOutlook =
  /** Rien à signaler. */
  | "under"
  /** Au plafond sans le dépasser : plus de création, rien d'autre. */
  | "full"
  /** Mémoire dépassée et mesurée : une coupure viendra. */
  | "over-enforced"
  /** Mémoire dépassée mais non mesurée : rien ne se passera. */
  | "over-unmeasured"
  /** Disque ou nombre dépassé : aucun effet automatique. */
  | "over-passive";

/**
 * Traduit une enveloppe et sa consommation en ce qui va se passer.
 *
 * Cette fonction existe parce que l'écran mentait. Il annonçait « les serveurs
 * en place continuent de tourner » pour tout dépassement — ce qui était vrai
 * tant que l'enveloppe n'était opposée qu'à la création, et qui a cessé de
 * l'être le jour où le surveillant s'est mis à couper sur l'enveloppe. Une
 * phrase rassurante devenue fausse est pire qu'une absence de phrase : elle est
 * crue.
 *
 * Trois distinctions gouvernent la réponse, et chacune change ce que le
 * revendeur doit faire dans l'heure :
 *
 * 1. **La mémoire n'est pas le disque.** Arrêter un serveur rend de la
 *    mémoire ; cela ne rend pas un octet de disque. Seule la mémoire est donc
 *    coupée, et annoncer une coupure pour un dépassement de disque ferait
 *    craindre une panne qui n'arrivera pas.
 * 2. **Une estimation n'est pas une mesure.** Le surveillant refuse d'agir sur
 *    une consommation majorée par les limites. Un revendeur dont les relevés
 *    manquent voit donc un dépassement sans conséquence — et il a le droit de
 *    le savoir, plutôt que d'attendre une coupure qui ne viendra pas.
 * 3. **Atteint n'est pas dépassé.** Au plafond exact, rien n'est coupé : seule
 *    la création s'arrête.
 */
export function quotaOutlook(
  quota: ResellerQuota,
  usage: QuotaUsage,
  basis: UsageBasis,
): QuotaOutlook {
  const over = (limit: number | null, used: number) => limit !== null && used > limit;

  if (over(quota.memoryMb, usage.memoryMb)) {
    return basis === "measured" ? "over-enforced" : "over-unmeasured";
  }

  if (over(quota.diskMb, usage.diskMb) || over(quota.serversMax, usage.servers)) {
    return "over-passive";
  }

  const atteint =
    (quota.memoryMb !== null && usage.memoryMb >= quota.memoryMb) ||
    (quota.diskMb !== null && usage.diskMb >= quota.diskMb) ||
    (quota.serversMax !== null && usage.servers >= quota.serversMax);

  return atteint ? "full" : "under";
}

export const QUOTA_DIMENSION_LABELS: Record<QuotaDimension, string> = {
  memoryMb: "mémoire",
  diskMb: "disque",
  servers: "serveurs",
};

/**
 * Part consommée d'une dimension, entre 0 et 1, ou `null` si elle est sans
 * limite.
 *
 * `null` plutôt que 0 ou 1 : une jauge sur une enveloppe illimitée n'a pas de
 * remplissage à afficher, et choisir un nombre reviendrait à inventer un
 * plafond. L'écran doit montrer la consommation brute dans ce cas.
 */
export function quotaRatio(limit: number | null, used: number): number | null {
  if (limit === null) return null;
  // Un plafond à zéro est plein par construction, et la division ne dirait rien.
  if (limit <= 0) return 1;
  return Math.min(used / limit, 1);
}
