import { randomUUID } from "node:crypto";
import {
  attributedReseller,
  checkResources,
  choosesOwner,
  type ProvisioningMode,
  platformAccessOf,
  platformMayProvision,
  provisioningMode,
  type ResourceProblem,
  type ResourceRequest,
  validateVariableValue,
} from "@gamedashboard/contracts";
import {
  allocations,
  type Database,
  eggs,
  eggVariables,
  servers,
  serverVariables,
  users,
} from "@gamedashboard/db";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { DATABASE } from "../../common/database.provider";
import { isUuid } from "../../common/uuid";
import { PlatformSettingsService } from "../admin/platform-settings.service";
import { ResellerScopeService } from "../application/reseller-scope.service";
import { ResellerQuotaService } from "../reseller/reseller-quota.service";
import { WebhookEmitterService } from "../webhooks/webhook-emitter.service";
import { WingsClientService } from "../wings/wings-client.service";
import { type CataloguePlan, CatalogueService } from "./catalogue.service";

/**
 * Traduit les manquements de bornes en une phrase.
 *
 * Exportée depuis que le redimensionnement s.en sert : les deux portes
 * refusent pour les mêmes raisons, elles doivent le dire avec les mêmes mots.
 */
export function describeResourceProblems(problems: readonly ResourceProblem[]): string {
  return problems
    .map((problem) =>
      problem.kind === "not-integer"
        ? `« ${problem.resource} » doit être un nombre entier.`
        : `« ${problem.resource} » doit être compris entre ${problem.min} et ${problem.max}.`,
    )
    .join(" ");
}

/** Poignée de transaction Drizzle : même interface que la base, dans un seul bloc. */
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface CreateServerInput {
  eggId: string;
  name: string;
  variables: Record<string, string>;
  /** Mode guidé : l'offre décide de tout, et la localisation du node. */
  planId?: string;
  locationId?: string;
  /** Modes assisté et avancé : node désigné et quantités explicites. */
  nodeId?: string;
  resources?: ResourceRequest;
  /** Mode avancé seulement : créer pour quelqu'un d'autre. */
  ownerId?: string;
}

/** Qui demande la création. Le rôle décide de ce qui est accepté du corps. */
export interface Requester {
  id: string;
  role: string;
  /**
   * Le revendeur **pour le compte de qui** la plateforme agit.
   *
   * Renseigné par une clé applicative bornée : la boutique d'un revendeur
   * appelle l'API de la plateforme, mais le serveur qu'elle commande est le
   * sien. Le demandeur reste la plateforme — c'est elle qui a le droit de
   * choisir le destinataire, qu'un revendeur n'a pas — et ce champ dit à qui le
   * résultat se rattache.
   *
   * Séparé du rôle exprès : abaisser le demandeur au rôle « revendeur » lui
   * ferait perdre ce droit, et sa boutique ne pourrait plus créer un serveur
   * pour un client.
   */
  onBehalfOf?: string | null;
}

/** Nombre maximal de serveurs par compte, tant que la facturation n'arbitre pas. */
const SERVERS_PER_USER = 5;

@Injectable()
export class ServerProvisioningService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CatalogueService) private readonly catalogue: CatalogueService,
    @Inject(WingsClientService) private readonly wings: WingsClientService,
    @Inject(ResellerQuotaService) private readonly quotas: ResellerQuotaService,
    @Inject(WebhookEmitterService) private readonly webhooks: WebhookEmitterService,
    @Inject(PlatformSettingsService) private readonly platform: PlatformSettingsService,
  ) {}

  /**
   * Crée un serveur.
   *
   * Ce que le corps de la requête a le droit de décider dépend du rôle, et de
   * lui seul — jamais de ce que l'écran a montré :
   *
   * - **guidé** (client) : un identifiant d'offre, rien d'autre. Accepter une
   *   quantité de mémoire depuis le navigateur laisserait n'importe qui
   *   s'attribuer le node entier ;
   * - **assisté** (revendeur) : des quantités explicites, sur **ses** nodes, et
   *   dans les limites de ce qu'il y reste ;
   * - **avancé** (administrateur) : partout, pour qui il veut — sauf sur le
   *   compte d'un revendeur qui ne l'a pas autorisé.
   */
  async create(requester: Requester, input: CreateServerInput) {
    const mode = provisioningMode(requester.role);
    const ownerId = await this.resolveOwner(requester, mode, input.ownerId);

    // Le quota de comptes ne vise que les clients : un revendeur qui remplit
    // son propre matériel n'a personne à ménager, et un administrateur non plus.
    if (mode === "guided") await this.assertUnderQuota(ownerId);

    const name = input.name.trim();
    if (name === "") throw new BadRequestException("Le nom du serveur est obligatoire.");
    if (name.length > 120) throw new BadRequestException("Nom trop long (120 caractères).");

    const egg = await this.eggFor(input.eggId);
    const { plan, nodeId, resellerId } =
      mode === "guided"
        ? await this.placeGuided(requester, input)
        : await this.placeExplicit(requester, mode, input);

    const serverId = randomUUID();

    /**
     * Port et serveur sont écrits dans **une seule transaction**.
     *
     * Ce n'est pas une précaution de style : les deux tables se référencent
     * mutuellement. `servers.allocation_id` exige que le port existe, et
     * `allocations.server_id` que le serveur existe — le port ne peut donc pas
     * être marqué comme pris avant l'insertion du serveur.
     *
     * Sans transaction, il resterait entre les deux écritures un instant où le
     * port paraît libre alors qu'il est déjà promis : deux créations simultanées
     * repartiraient avec le même, et la seconde volerait l'adresse de la
     * première. Le `FOR UPDATE SKIP LOCKED` tient le verrou pendant tout
     * l'intervalle, et `SKIP LOCKED` fait que la demande concurrente prend le
     * port suivant au lieu d'attendre.
     */
    /*
     * Le tueur de mémoire suit le réglage de la plateforme, lu **maintenant**
     * et non figé dans le code.
     *
     * Il est lu hors de la transaction : c'est un réglage d'exploitation, pas
     * une donnée dont dépend la cohérence de l'insertion, et l'y inclure
     * tiendrait le verrou du port pendant un aller-retour de plus. Ce défaut ne
     * gouverne que la naissance du serveur ; ensuite, il se change depuis sa
     * fiche d'administration.
     */
    const oomKiller = await this.platform.boolean("servers.oomKiller");

    await this.db.transaction(async (tx) => {
      /**
       * L'enveloppe du revendeur, en plus de la capacité de la machine.
       *
       * Les deux contrôles sont distincts et aucun ne remplace l'autre : le node
       * dit ce que le matériel peut porter, l'enveloppe ce que le revendeur a le
       * droit de vendre. Un revendeur avec 64 Go de matériel et 32 Go
       * d'enveloppe n'exploite que la moitié de sa machine — c'est le sujet même
       * du quota, pas un effet de bord.
       *
       * Le plafond visé est celui du **revendeur auquel le serveur se rattache**,
       * et non celui du demandeur : un serveur créé par l'administration sur la
       * machine d'un revendeur est compté dans sa consommation, il doit donc
       * l'être aussi dans son refus. C'est mot pour mot la règle écrite en base à
       * la ligne `resellerId` — un quota qui compterait autrement que ce qu'il
       * refuse se tromperait forcément d'un côté ou de l'autre.
       *
       * **Ici, et non dans le placement explicite seul.** Il y vivait, si bien
       * que la commande guidée passée pour un revendeur (offre, localisation)
       * naissait rattachée à lui sans que son enveloppe soit jamais consultée :
       * sa boutique vendait au-delà de `memoryMb`, `diskMb` et `serversMax`. Un
       * seul contrôle, après les deux placements, ne peut plus oublier l'un.
       *
       * **Dans la transaction qui écrit le serveur**, sous le verrou de
       * l'enveloppe (`assertRoom`) : contrôlé avant, il laissait passer N
       * créations simultanées à `plafond - 1`, qui comptaient toutes avant
       * qu'aucune n'écrive.
       */
      if (resellerId) {
        // Avant le port : un refus d'enveloppe ne doit rien avoir réservé.
        await this.quotas.assertRoom(
          resellerId,
          { memoryMb: plan.memoryMb, diskMb: plan.diskMb },
          tx,
        );
      }

      const [reserved] = await tx
        .select({ id: allocations.id })
        .from(allocations)
        .where(and(eq(allocations.nodeId, nodeId), isNull(allocations.serverId)))
        .orderBy(allocations.port)
        .limit(1)
        .for("update", { skipLocked: true });

      if (!reserved) throw new ServiceUnavailableException("Plus aucun port libre sur ce node.");

      await tx.insert(servers).values({
        id: serverId,
        uuidShort: serverId.slice(0, 8),
        name,
        ownerId,
        nodeId,
        eggId: egg.id,
        /**
         * **À quel revendeur ce serveur se rattache.**
         *
         * La colonne existait depuis la migration 0014 et personne ne l'écrivait :
         * seul le remplissage rétroactif de la 0015 l'avait posée, si bien que
         * tout serveur créé depuis naissait sans rattachement. Trois mécanismes
         * s'en nourrissent pourtant et ne voyaient donc rien — l'enveloppe du
         * revendeur, la consommation de sa part sur un node, et le périmètre de
         * ses clés applicatives. Chacun répondait « zéro » sans se plaindre.
         *
         * La règle est celle du remplissage rétroactif, appliquée à la naissance
         * plutôt qu'après coup.
         */
        resellerId,
        allocationId: reserved.id,
        dockerImage: egg.defaultImage,
        startup: egg.startup,
        environment: {},
        memoryMb: plan.memoryMb,
        diskMb: plan.diskMb,
        cpuPct: plan.cpuPct,
        swapMb: plan.swapMb,
        oomKiller,
        backupLimit: plan.backups,
        databaseLimit: plan.databases,
        // Nul : la limite par défaut du node (ADR 0009).
        snapshotLimit: input.resources?.snapshots ?? null,
        allocationLimit: plan.allocations,
        // L'état de gestion dit ce que le panel attend : l'installation est en
        // cours, et c'est Wings qui la clôturera sur
        // /api/remote/servers/:uuid/install.
        state: "installing",
      });

      await tx
        .update(allocations)
        .set({ serverId, updatedAt: new Date().toISOString() })
        .where(eq(allocations.id, reserved.id));

      await this.writeVariables(tx, serverId, egg.id, input.variables);
    });

    /**
     * Le daemon est prévenu, mais son échec **n'annule pas** la création.
     *
     * Le serveur existe en base, avec son port et ses variables ; Wings le
     * découvrira à son prochain inventaire (`GET /api/remote/servers`) et
     * l'installera alors. Défaire la création parce que le node n'a pas répondu
     * ferait perdre au client un formulaire qu'il vient de remplir, pour une
     * panne qui se résout seule.
     *
     * Conséquence à connaître : tant que le daemon n'a pas accusé réception, le
     * serveur reste affiché « en installation ». C'est exact, et c'est mieux
     * qu'un serveur annoncé prêt qui n'existe nulle part.
     */
    await this.wings.createServer(serverId).catch(() => undefined);

    /**
     * Le système tiers est prévenu, quelle que soit l'origine de la création.
     *
     * Émis ici et non dans le contrôleur applicatif : un serveur créé depuis le
     * panel par un administrateur intéresse la boutique autant qu'une commande
     * passée par elle — c'est une ligne de plus à facturer, et elle ne
     * l'apprendrait jamais.
     *
     * L'événement dit « créé », pas « prêt » : l'installation commence à peine.
     * C'est `server.installed` qui autorisera la boutique à écrire au client.
     */
    await this.webhooks.emit("server.created", {
      serverId,
      shortId: serverId.slice(0, 8),
      name,
      ownerId,
      nodeId,
      memoryMb: plan.memoryMb,
      diskMb: plan.diskMb,
      eggId: egg.id,
      planId: plan.id,
    });

    return { id: serverId, name, shortId: serverId.slice(0, 8) };
  }

  /**
   * Écrit les variables choisies à la création.
   *
   * Mêmes règles qu'après coup (`ServerSettingsService.setVariables`) : la
   * liste autorisée vient de l'egg, et une variable non modifiable est refusée.
   * Les autres reçoivent la valeur par défaut de l'egg — sans quoi le
   * conteneur démarrerait avec un environnement incomplet.
   */
  private async writeVariables(
    tx: Transaction,
    serverId: string,
    eggId: string,
    chosen: Record<string, string>,
  ): Promise<void> {
    const declared = await tx
      .select({
        id: eggVariables.id,
        envVariable: eggVariables.envVariable,
        defaultValue: eggVariables.defaultValue,
        isEditable: eggVariables.userEditable,
        isViewable: eggVariables.userViewable,
        rules: eggVariables.rules,
      })
      .from(eggVariables)
      .where(eq(eggVariables.eggId, eggId));

    // Mêmes règles qu'après coup : la valeur part telle quelle au conteneur.
    for (const variable of declared) {
      const value = chosen[variable.envVariable];
      if (value === undefined) continue;
      const problem = validateVariableValue(variable.rules, value);
      if (problem !== null) {
        throw new BadRequestException(
          `Valeur refusée pour « ${variable.envVariable} » : ${problem}.`,
        );
      }
    }

    const unknown = Object.keys(chosen).filter(
      (name) => !declared.some((v) => v.envVariable === name),
    );
    if (unknown.length > 0) {
      throw new BadRequestException(`Variable inconnue : ${unknown.join(", ")}.`);
    }

    const locked = Object.keys(chosen).filter((name) =>
      declared.some((v) => v.envVariable === name && (!v.isEditable || !v.isViewable)),
    );
    if (locked.length > 0) {
      throw new BadRequestException(`Variable non modifiable : ${locked.join(", ")}.`);
    }

    if (declared.length === 0) return;

    await tx.insert(serverVariables).values(
      declared.map((variable) => ({
        serverId,
        eggVariableId: variable.id,
        value: chosen[variable.envVariable] ?? variable.defaultValue,
      })),
    );
  }

  private async eggFor(eggId: string) {
    // Un identifiant illisible n'est pas un jeu : sans ce contrôle, PostgreSQL
    // refusait la comparaison et la création rendait 500.
    if (!isUuid(eggId)) throw new BadRequestException("Jeu indisponible.");
    const [row] = await this.db
      .select({
        id: eggs.id,
        startup: eggs.startup,
        dockerImages: eggs.dockerImages,
        enabled: eggs.enabled,
      })
      .from(eggs)
      .where(eq(eggs.id, eggId))
      .limit(1);

    // Un egg désactivé est traité comme inexistant : il n'a pas été validé par
    // un administrateur, et son script d'installation n'a donc pas été relu.
    if (!row?.enabled) throw new BadRequestException("Jeu indisponible.");

    /**
     * Image Docker par défaut : la première déclarée par l'egg.
     *
     * Le format Pterodactyl est `{ "Java 21": "ghcr.io/..." }`, un objet dont
     * l'ordre des clés porte l'intention de l'auteur — la première est celle
     * qu'il recommande.
     */
    const images = Object.values((row.dockerImages ?? {}) as Record<string, string>);
    const defaultImage = images[0];
    if (!defaultImage) {
      throw new BadRequestException("Ce jeu n'a pas d'image Docker configurée.");
    }

    return { id: row.id, startup: row.startup, defaultImage };
  }

  /**
   * Pour qui le serveur est créé.
   *
   * Seul le mode avancé désigne quelqu'un d'autre. Et même là, une règle tient :
   * un administrateur ne provisionne pas sur le compte d'un revendeur sans que
   * **celui-ci** l'ait autorisé. Un revendeur loue son propre matériel et
   * répond de ce qui y tourne ; lui imposer un serveur reviendrait à disposer
   * de sa capacité et à engager sa responsabilité à sa place.
   */
  private async resolveOwner(
    requester: Requester,
    mode: ProvisioningMode,
    requested: string | undefined,
  ): Promise<string> {
    if (!requested || requested === requester.id) return requester.id;

    if (!choosesOwner(mode)) {
      throw new ForbiddenException("Vous ne pouvez créer un serveur que sur votre propre compte.");
    }

    /*
     * Un revendeur reçoit la même réponse pour un compte qui n'existe pas et
     * pour un compte qui n'est pas à lui : deux messages lui disaient qu'un
     * identifiant désigne un compte du panel. Un identifiant illisible est
     * refusé avant la base, qui répondait 500.
     */
    const horsPerimetre = new ForbiddenException(
      "Ce compte n'est pas l'un de vos clients : il ne peut pas recevoir de serveur de votre part.",
    );
    const inconnu =
      mode === "assisted" ? horsPerimetre : new BadRequestException("Compte destinataire inconnu.");
    if (!isUuid(requested)) throw inconnu;

    const [target] = await this.db
      .select({
        id: users.id,
        role: users.role,
        allows: users.platformAccess,
      })
      .from(users)
      .where(eq(users.id, requested))
      .limit(1);

    if (!target) throw inconnu;

    /*
     * Un revendeur ne sert que ses propres comptes : la règle de la clé de
     * sa boutique (`ResellerScopeService.requireRecipient`), et la même.
     *
     * Poser un serveur à un compte le fait entrer dans son périmètre — et de
     * là, sa console, ses fichiers et un lien de connexion à son nom. Cet
     * écran ne vérifiait que les serveurs possédés ailleurs : un compte
     * invité sur le serveur d'un autre, un compte suspendu, un administrateur
     * ou un autre revendeur recevaient un serveur, après quoi la clé de la
     * boutique lisait la fiche et ouvrait la session. Une seule règle, pour
     * les deux portes.
     *
     * Le refus est dit ici en clair : c'est l'écran du revendeur, qui a
     * désigné ce compte lui-même. Il ne dit pas si le compte existe.
     */
    if (mode === "assisted") {
      try {
        await new ResellerScopeService(this.db).requireRecipient(requester.id, target.id);
      } catch (error) {
        if (error instanceof NotFoundException) throw horsPerimetre;
        throw error;
      }
    }

    if (target.role === "reseller" && !platformMayProvision(platformAccessOf(target.allows))) {
      throw new ForbiddenException(
        "Ce revendeur n'autorise pas l'administration de la plateforme à créer des " +
          "serveurs sur son compte. Il peut l'activer depuis son espace.",
      );
    }

    return target.id;
  }

  /**
   * Mode guidé : l'offre décide des ressources, la localisation du node.
   *
   * Rien de ce qui vient du navigateur ne dimensionne quoi que ce soit — seul
   * un identifiant d'offre est lu. C'est la garantie qui empêche un client de
   * s'attribuer le node entier en modifiant une requête.
   */
  private async placeGuided(
    requester: Requester,
    input: CreateServerInput,
  ): Promise<{ plan: CataloguePlan; nodeId: string; resellerId: string | null }> {
    if (!input.planId || !input.locationId) {
      throw new BadRequestException("Offre et localisation sont obligatoires.");
    }

    const plan = (await this.catalogue.plans()).find((p) => p.id === input.planId);
    if (!plan) throw new BadRequestException("Offre inconnue.");

    /*
     * Une commande passée pour un revendeur se place dans **son** parc.
     *
     * Le répartiteur public écarte volontairement les nodes attribués à un
     * revendeur ; l'employer ici enverrait la commande de sa boutique sur le
     * matériel de la plateforme — hébergé par nous, facturé par lui.
     */
    const nodeId = requester.onBehalfOf
      ? await this.catalogue.pickNodeForReseller(
          requester.onBehalfOf,
          input.locationId,
          plan.memoryMb,
          plan.diskMb,
        )
      : await this.catalogue.pickNode(input.locationId, plan.memoryMb, plan.diskMb);

    if (!nodeId) {
      throw new ServiceUnavailableException(
        "Aucun node disponible dans cette localisation pour cette offre. Choisissez-en une autre.",
      );
    }

    return { plan, nodeId, resellerId: this.attribution(requester, null) };
  }

  /**
   * À quel revendeur ce serveur se rattache.
   *
   * La règle elle-même vit dans les contrats, avec les autres règles de
   * provisionnement : elle décide de ce que le quota refuse, de ce que la part
   * d'un node compte et de ce qu'une clé applicative voit, et ces trois-là
   * doivent s'accorder. Ici, on ne fait que la traduire en termes de demandeur.
   */
  private attribution(requester: Requester, nodeOwnerId: string | null): string | null {
    return attributedReseller({
      role: requester.role,
      id: requester.id,
      onBehalfOf: requester.onBehalfOf,
      nodeOwnerId,
    });
  }

  /**
   * Modes assisté et avancé : quantités explicites sur un node désigné.
   *
   * Trois contrôles, et aucun n'est décoratif :
   *
   * 1. **les bornes**, partagées avec l'interface, qui écartent l'absurde ;
   * 2. **la propriété du node**, qui empêche un revendeur de provisionner
   *    ailleurs que chez lui ;
   * 3. **la capacité restante, relue maintenant**, parce qu'entre l'affichage
   *    du formulaire et l'envoi, quelqu'un d'autre a pu remplir le node.
   */
  private async placeExplicit(
    requester: Requester,
    mode: ProvisioningMode,
    input: CreateServerInput,
  ): Promise<{ plan: CataloguePlan; nodeId: string; resellerId: string | null }> {
    if (!input.nodeId || !input.resources) {
      throw new BadRequestException("Node et ressources sont obligatoires.");
    }

    const problems = checkResources(input.resources);
    if (problems.length > 0) {
      throw new BadRequestException(describeResourceProblems(problems));
    }

    /*
     * La capacité est demandée **pour le demandeur**.
     *
     * Deux choses en découlent, et elles étaient toutes deux fausses avant :
     *
     * - un node qu'il n'a pas le droit de désigner ne remonte pas, ce qui rend
     *   le contrôle de propriété inutile — et celui-ci ne regardait que
     *   `owner_id`, si bien qu'un revendeur titulaire d'une **part** sur une
     *   machine de la plateforme se voyait répondre « Node inconnu » alors que
     *   l'assistant venait de la lui proposer ;
     * - la capacité rendue est **la sienne** : sur une part de 8 Go, il était
     *   jusqu'ici validé contre les 128 Go du matériel.
     *
     * Un 400 « inconnu » plutôt qu'un 403 : la liste des nodes d'autrui n'a pas
     * à se deviner un identifiant à la fois.
     */
    /*
     * Quand la plateforme agit pour un revendeur, la capacité est évaluée
     * **comme la sienne**. Sans cela, sa boutique désignerait n'importe quelle
     * machine du parc et serait validée contre le matériel entier au lieu de sa
     * part.
     */
    const pour: Requester = requester.onBehalfOf
      ? { id: requester.onBehalfOf, role: "reseller" }
      : requester;

    const node = await this.catalogue.nodeCapacity(input.nodeId, pour);
    if (!node) throw new BadRequestException("Node inconnu.");

    if (node.maintenanceMode) {
      throw new ConflictException(
        "Ce node est en maintenance : aucun serveur ne peut y être créé.",
      );
    }
    if (node.freePorts < input.resources.allocations) {
      throw new ConflictException(
        `Ce node n'a plus que ${node.freePorts} port(s) libre(s), il en faut ${input.resources.allocations}.`,
      );
    }
    if (input.resources.memoryMb > node.freeMemoryMb) {
      throw new ConflictException(
        `Il ne reste que ${node.freeMemoryMb} Mo de mémoire sur ce node.`,
      );
    }
    if (input.resources.diskMb > node.freeDiskMb) {
      throw new ConflictException(`Il ne reste que ${node.freeDiskMb} Mo de disque sur ce node.`);
    }

    // L'enveloppe du revendeur est vérifiée par `create`, pour les deux
    // placements à la fois.
    const resellerId = this.attribution(requester, node.ownerId);

    /**
     * Une offre synthétique porte les quantités choisies.
     *
     * Le reste de la création ne connaît que des offres, et lui apprendre un
     * second chemin le ferait diverger. L'identifiant dit d'où elle vient : il
     * apparaîtra tel quel dans le journal d'audit.
     */
    return {
      plan: {
        id: mode === "advanced" ? "sur-mesure:admin" : "sur-mesure:revendeur",
        name: "Sur mesure",
        priceLabel: "—",
        ...input.resources,
      },
      nodeId: node.id,
      resellerId,
    };
  }

  private async assertUnderQuota(ownerId: string): Promise<void> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(servers)
      .where(eq(servers.ownerId, ownerId));

    if ((row?.n ?? 0) >= SERVERS_PER_USER) {
      throw new ConflictException(
        `Vous avez atteint la limite de ${SERVERS_PER_USER} serveurs. Contactez le support pour l'augmenter.`,
      );
    }
  }
}
