import type { ResourceRequest } from "@gamedashboard/contracts";
import {
  allocations,
  type Database,
  eggs,
  locations,
  nests,
  nodeResellerShares,
  nodes,
  servers,
  users,
} from "@gamedashboard/db";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, count, eq, isNull, or, sql } from "drizzle-orm";
import { DATABASE } from "../../common/database.provider";
import { isUuid } from "../../common/uuid";
import { CatalogueService } from "../client/catalogue.service";
import { ServerProvisioningService } from "../client/server-provisioning.service";
import { WebhookEmitterService } from "../webhooks/webhook-emitter.service";

/**
 * Demandeur synthétique des créations faites par un système tiers.
 *
 * Ce n'est pas un compte et cela ne doit jamais en devenir un : la valeur
 * n'est pas un UUID, donc elle ne peut correspondre à aucune ligne de `users`.
 * C'est ce qui garantit que `resolveOwner` prendra la branche « je crée pour
 * quelqu'un d'autre » — celle qui vérifie qu'un revendeur a bien autorisé la
 * plateforme à provisionner chez lui. Un demandeur égal au destinataire
 * sauterait ce contrôle.
 */
const PLATFORM_ACTOR = { id: "application:platform", role: "admin" } as const;

export interface ApplicationUser {
  id: string;
  email: string;
  nameFirst: string;
  nameLast: string;
  role: string;
  externalId: string | null;
  servers: number;
  createdAt: string;
}

export interface ApplicationServer {
  id: string;
  shortId: string;
  name: string;
  ownerId: string;
  nodeId: string;
  node: string;
  eggId: string;
  egg: string;
  state: string | null;
  suspendedReason: string | null;
  memoryMb: number;
  diskMb: number;
  cpuPct: number;
  createdAt: string;
}

/**
 * Le service de l'API applicative.
 *
 * Les lectures ont leurs propres requêtes plutôt que de réemployer celles de
 * l'administration, et ce n'est pas de la duplication gratuite : la forme
 * d'une réponse d'API publique est un engagement envers l'intégrateur. Servir
 * ce que l'écran d'administration affiche ferait qu'ajouter une colonne à un
 * tableau casse la facturation d'un client.
 *
 * Les écritures, elles, ne sont jamais réécrites : elles délèguent aux services
 * qui portent déjà la règle — provisionnement, quotas, suspension. Une seconde
 * implémentation de « créer un serveur » finirait par diverger sur le contrôle
 * qui compte.
 */
@Injectable()
export class ApplicationService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CatalogueService) private readonly catalogue: CatalogueService,
    @Inject(ServerProvisioningService) private readonly provisioning: ServerProvisioningService,
    @Inject(WebhookEmitterService) private readonly webhooks: WebhookEmitterService,
  ) {}

  /* --- Comptes -------------------------------------------------------------- */

  /**
   * Retrouve un compte par son identifiant local, son adresse ou son
   * identifiant sur le site client.
   *
   * La recherche par `externalId` est celle qui sert vraiment : le système de
   * facturation connaît ses propres clients, pas les identifiants du panel. Le
   * forcer à retenir les nôtres l'obligerait à tenir une table de
   * correspondance, qui se désynchronise.
   */
  async findUser(criteria: {
    id?: string;
    email?: string;
    externalId?: string;
  }): Promise<ApplicationUser | null> {
    // Un identifiant illisible ne désigne personne : PostgreSQL l'aurait
    // refusé par une erreur 500.
    if (criteria.id !== undefined && !isUuid(criteria.id)) return null;

    const where =
      criteria.id !== undefined
        ? eq(users.id, criteria.id)
        : criteria.email !== undefined
          ? sql`lower(${users.email}) = lower(${criteria.email})`
          : criteria.externalId !== undefined
            ? eq(users.externalId, criteria.externalId)
            : null;

    if (where === null) throw new BadRequestException("Aucun critère de recherche fourni.");

    const [row] = await this.db
      .select(this.userColumns())
      .from(users)
      .leftJoin(servers, eq(servers.ownerId, users.id))
      .where(where)
      .groupBy(users.id)
      .limit(1);

    return row ?? null;
  }

  /**
   * Crée un compte client.
   *
   * **Aucun mot de passe n'est accepté.** Le compte naît sans secret local,
   * comme un compte créé par SSO : c'est le site client qui authentifie, et
   * lui faire transiter un mot de passe par cette API le ferait exister en
   * clair dans ses journaux, dans les nôtres et dans tout ce qui se trouve
   * entre les deux. L'utilisateur se connectera par le SSO, ou définira son
   * mot de passe lui-même depuis la procédure d'oubli.
   */
  async createUser(input: {
    email: string;
    nameFirst: string;
    nameLast: string;
    externalId?: string | null;
  }): Promise<ApplicationUser> {
    const email = input.email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new BadRequestException("Adresse e-mail invalide.");
    }

    const nameFirst = input.nameFirst.trim();
    const nameLast = input.nameLast.trim();
    if (nameFirst === "" || nameLast === "") {
      throw new BadRequestException("Nom et prénom sont obligatoires.");
    }

    // Vérification explicite plutôt que de laisser l'index unique parler : une
    // erreur SQL brute remonterait des noms de colonnes à un système tiers, et
    // ne lui dirait pas quoi faire.
    const [taken] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = lower(${email})`)
      .limit(1);

    if (taken) throw new ConflictException("Un compte existe déjà pour cette adresse.");

    if (input.externalId) {
      const [collision] = await this.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.externalId, input.externalId))
        .limit(1);
      if (collision) {
        throw new ConflictException("Un compte est déjà rattaché à cet identifiant externe.");
      }
    }

    const [created] = await this.db
      .insert(users)
      .values({
        email,
        // Voir le commentaire de la méthode : jamais de secret local ici.
        passwordHash: null,
        nameFirst,
        nameLast,
        externalId: input.externalId ?? null,
        /**
         * Le rôle n'est pas paramétrable depuis cette API.
         *
         * Un système de facturation compromis pourrait sinon se fabriquer un
         * administrateur, et de là tout le reste. Élever un compte reste un
         * geste fait depuis le panel, par une personne.
         */
        role: "user",
      })
      .returning({ id: users.id });

    if (!created) throw new ConflictException("Le compte n'a pas pu être créé.");

    const user = await this.findUser({ id: created.id });
    if (!user) throw new ConflictException("Le compte n'a pas pu être relu.");

    /**
     * Le rappel part même quand c'est le tiers qui a créé le compte.
     *
     * Il reçoit donc l'écho de sa propre demande, et c'est voulu : plusieurs
     * systèmes peuvent être abonnés — une boutique et un outil de support, par
     * exemple — et filtrer selon l'auteur reviendrait à en priver un sur deux.
     * Le doublon se dédoublonne à la réception ; l'absence, elle, ne se
     * rattrape pas.
     */
    /*
     * À la plateforme, y compris quand c'est la boutique d'un revendeur qui
     * crée le compte.
     *
     * Le compte n'a encore aucun serveur : il n'est donc à personne, et le
     * rattacher à qui l'a créé serait une propriété que le modèle ne reconnaît
     * pas — c'est déjà pour cette raison que `POST users` n'a pas de périmètre.
     * Le revendeur ne perd rien : il vient d'obtenir l'identifiant en réponse à
     * son propre appel, et l'écho ne lui apprendrait rien.
     */
    await this.webhooks.emit(
      "user.created",
      { userId: user.id, email: user.email, externalId: user.externalId },
      { reseller: null },
    );

    return user;
  }

  /**
   * Met à jour l'état civil d'un compte.
   *
   * Ni le rôle, ni le mot de passe, ni l'adresse : le rôle appartient au panel,
   * le mot de passe à son porteur, et changer l'adresse par cette voie
   * permettrait de détourner un compte vers une boîte contrôlée par l'appelant.
   * Le changement d'adresse reste un geste vérifié, fait par l'intéressé.
   */
  async updateUser(
    userId: string,
    patch: { nameFirst?: string; nameLast?: string; externalId?: string | null },
  ): Promise<ApplicationUser> {
    const values: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (patch.nameFirst !== undefined) {
      const value = patch.nameFirst.trim();
      if (value === "") throw new BadRequestException("Prénom vide.");
      values.nameFirst = value;
    }
    if (patch.nameLast !== undefined) {
      const value = patch.nameLast.trim();
      if (value === "") throw new BadRequestException("Nom vide.");
      values.nameLast = value;
    }
    if (patch.externalId !== undefined) {
      /*
       * Contrôlé ici, comme à la création : l'index unique répondait par une
       * erreur 500, qui disait surtout qu'une autre facturation emploie cet
       * identifiant.
       */
      if (patch.externalId !== null) {
        const [collision] = await this.db
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.externalId, patch.externalId), sql`${users.id} <> ${userId}`))
          .limit(1);
        if (collision) {
          throw new ConflictException("Un compte est déjà rattaché à cet identifiant externe.");
        }
      }
      values.externalId = patch.externalId;
    }

    const [updated] = await this.db
      .update(users)
      .set(values)
      .where(eq(users.id, userId))
      .returning({ id: users.id });

    if (!updated) throw new NotFoundException("Compte introuvable.");

    const user = await this.findUser({ id: updated.id });
    if (!user) throw new NotFoundException("Compte introuvable.");
    return user;
  }

  /* --- Serveurs ------------------------------------------------------------- */

  /**
   * Les serveurs, filtrés.
   *
   * `resellerId` n'est pas un critère de recherche comme les autres : il ne
   * vient pas de la requête mais de la clé, et il s'ajoute aux autres au lieu
   * de les remplacer. Il est appliqué **en SQL** et non après coup — filtrer
   * ensuite laisserait les compteurs et la pagination porter sur tout le parc,
   * et c'est le genre de fuite qui ne se voit pas.
   */
  async servers(filter: {
    ownerId?: string;
    serverId?: string;
    resellerId?: string | null;
  }): Promise<ApplicationServer[]> {
    // Même raison que `findUser` : un identifiant illisible ne filtre sur rien
    // qui existe, et la base l'aurait refusé par une erreur 500.
    if (filter.ownerId !== undefined && filter.ownerId !== "" && !isUuid(filter.ownerId)) return [];
    if (filter.serverId !== undefined && !isUuid(filter.serverId)) return [];

    const conditions = [
      filter.ownerId ? eq(servers.ownerId, filter.ownerId) : undefined,
      filter.serverId ? eq(servers.id, filter.serverId) : undefined,
      filter.resellerId ? eq(servers.resellerId, filter.resellerId) : undefined,
    ].filter((condition) => condition !== undefined);

    const rows = await this.db
      .select({
        id: servers.id,
        shortId: servers.uuidShort,
        name: servers.name,
        ownerId: servers.ownerId,
        nodeId: servers.nodeId,
        node: nodes.name,
        eggId: servers.eggId,
        egg: eggs.name,
        state: servers.state,
        suspendedReason: servers.suspendedReason,
        memoryMb: servers.memoryMb,
        diskMb: servers.diskMb,
        cpuPct: servers.cpuPct,
        createdAt: servers.createdAt,
      })
      .from(servers)
      .innerJoin(nodes, eq(servers.nodeId, nodes.id))
      .innerJoin(eggs, eq(servers.eggId, eggs.id))
      // `and()` sans condition rend `undefined`, que Drizzle traite comme
      // « aucun filtre » : c'est exactement le cas « tous les serveurs ».
      .where(and(...conditions))
      .orderBy(servers.createdAt);

    return rows;
  }

  /**
   * Un serveur, à condition qu'il soit dans le périmètre.
   *
   * Hors périmètre, la réponse est « introuvable » et non « interdit » : la
   * distinction n'intéresse que celui qui cherche à savoir ce qu'hébergent les
   * autres revendeurs, et il n'a pas à l'apprendre d'ici.
   */
  async server(serverId: string, resellerId: string | null = null): Promise<ApplicationServer> {
    const [row] = await this.servers({ serverId, resellerId });
    if (!row) throw new NotFoundException("Serveur introuvable.");
    return row;
  }

  /**
   * Crée un serveur pour le compte d'un client.
   *
   * Deux façons de dire la même chose, selon ce que l'appelant connaît :
   *
   * - une **offre** et une localisation, et le panel place ;
   * - un **node** et des quantités, et l'appelant place.
   *
   * La première est ramenée à la seconde avant de déléguer, de sorte qu'il
   * n'existe qu'un seul chemin de création — celui qui contrôle les bornes, la
   * capacité du node, le consentement du revendeur et son enveloppe. Une
   * seconde voie « simplifiée » finirait par en oublier un.
   *
   * `ownerId` est **obligatoire**. Une clé applicative n'appartient à personne :
   * sans destinataire explicite, il n'existe aucun compte sur lequel rattacher
   * le serveur, et le deviner serait pire que de le demander.
   */
  async createServer(
    input: {
      ownerId: string;
      eggId: string;
      name: string;
      variables?: Record<string, string>;
      planId?: string;
      locationId?: string;
      nodeId?: string;
      resources?: ResourceRequest;
    },
    /**
     * Le revendeur de la clé, s'il y en a un.
     *
     * Il ne restreint pas seulement : **il attribue**. Le serveur créé par la
     * boutique d'un revendeur se rattache à lui, faute de quoi il naîtrait hors
     * de son propre périmètre — et il ne pourrait plus ni le lire, ni le
     * suspendre, ni le supprimer une seconde après l'avoir vendu.
     */
    resellerId: string | null = null,
  ): Promise<ApplicationServer> {
    // Le mot du chemin de création pour un compte inconnu ; la base aurait
    // rendu une erreur 500 pour une valeur qu'elle ne sait pas convertir.
    if (!isUuid(input.ownerId)) throw new BadRequestException("Compte destinataire inconnu.");

    const placement = await this.resolvePlacement(input, resellerId);

    /**
     * La limite de cinq serveurs par compte ne s'applique pas ici.
     *
     * Elle existe tant que rien n'arbitre côté commercial ; or c'est
     * précisément ce que fait le système qui appelle. Lui opposer une limite
     * du panel reviendrait à refuser une commande déjà payée.
     */
    const created = await this.provisioning.create(
      /*
       * Le demandeur reste la plateforme, agissant **pour** le revendeur.
       *
       * L'abaisser au rôle « revendeur » lui retirerait le droit de choisir le
       * destinataire — que seul l'administrateur a — et sa boutique ne pourrait
       * plus créer un serveur pour un client. C'est pourtant tout ce qu'elle
       * fait.
       */
      { ...PLATFORM_ACTOR, onBehalfOf: resellerId },
      {
        eggId: input.eggId,
        name: input.name,
        variables: input.variables ?? {},
        ownerId: input.ownerId,
        nodeId: placement.nodeId,
        resources: placement.resources,
      },
    );

    return this.server(created.id, resellerId);
  }

  /**
   * Ramène une demande « offre + localisation » à un node et des quantités.
   *
   * Le répartiteur est celui du catalogue, le même que pour un client du
   * panel : une seconde règle de placement ferait qu'un serveur commandé par
   * la boutique n'atterrit pas où il serait allé autrement.
   */
  private async resolvePlacement(
    input: {
      planId?: string;
      locationId?: string;
      nodeId?: string;
      resources?: ResourceRequest;
    },
    resellerId: string | null,
  ): Promise<{ nodeId: string; resources: ResourceRequest }> {
    if (input.nodeId && input.resources) {
      return { nodeId: input.nodeId, resources: input.resources };
    }

    if (!input.planId || !input.locationId) {
      throw new BadRequestException(
        "Fournissez soit « planId » et « locationId », soit « nodeId » et « resources ».",
      );
    }

    const plan = (await this.catalogue.plans()).find((p) => p.id === input.planId);
    if (!plan) throw new BadRequestException("Offre inconnue.");

    // Une commande passée pour un revendeur se place dans son parc, jamais sur
    // le matériel de la plateforme : il le facturerait sans l'héberger.
    const nodeId =
      resellerId === null
        ? await this.catalogue.pickNode(input.locationId, plan.memoryMb, plan.diskMb)
        : await this.catalogue.pickNodeForReseller(
            resellerId,
            input.locationId,
            plan.memoryMb,
            plan.diskMb,
          );

    if (nodeId === null) {
      // 409 et non 400 : la demande est valide, c'est le parc qui est plein.
      // La distinction décide de ce que fait l'appelant — corriger sa requête,
      // ou réessayer plus tard.
      throw new ConflictException(
        "Aucun node disponible dans cette localisation pour cette offre.",
      );
    }

    return {
      nodeId,
      resources: {
        memoryMb: plan.memoryMb,
        diskMb: plan.diskMb,
        cpuPct: plan.cpuPct,
        swapMb: plan.swapMb,
        allocations: plan.allocations,
        backups: plan.backups,
        databases: plan.databases,
      },
    };
  }

  /* --- Infrastructure, en lecture seule ------------------------------------- */

  /**
   * Nodes disponibles, avec ce qu'il **reste**.
   *
   * Les nodes d'un revendeur sont exclus : la boutique de la plateforme n'a
   * rien à y placer, et les exposer apprendrait à un système tiers la capacité
   * d'un parc qui ne lui appartient pas.
   */
  async nodes(resellerId: string | null = null) {
    /*
     * Pour un revendeur, ce sont **ses** machines, mesurées comme les siennes.
     *
     * Trois choses changent ensemble, et n'en changer qu'une mentirait :
     *
     * - la liste : ses machines dédiées **et** celles où il détient une part ;
     * - la capacité annoncée : sur une part, la part et non le matériel —
     *   annoncer 128 Go quand il en a huit le ferait composer une commande que
     *   la création refuserait ensuite ;
     * - la consommation : ses serveurs seulement, sans quoi il lirait la charge
     *   des autres revendeurs de la même machine.
     */
    const consommation =
      resellerId === null
        ? eq(servers.nodeId, nodes.id)
        : and(eq(servers.nodeId, nodes.id), eq(servers.resellerId, resellerId));

    const perimetre =
      resellerId === null
        ? isNull(nodes.ownerId)
        : or(eq(nodes.ownerId, resellerId), eq(nodeResellerShares.resellerId, resellerId));

    /*
     * La capacité annoncée : le matériel quand la machine est à lui, sa part
     * sinon.
     *
     * `is not distinct from` plutôt que `=` : la plateforme est désignée par
     * `null` des deux côtés, et `null = null` ne vaut pas « vrai ». Une seule
     * expression couvre donc les trois cas — plateforme, machine dédiée, part —
     * au lieu de trois branches qui finiraient par ne plus dire la même chose.
     */
    const capaciteMemoire = sql<number>`case
      when ${nodes.ownerId} is not distinct from ${resellerId}::uuid then ${nodes.memoryMb}
      else coalesce(${nodeResellerShares.memoryMb}, 0) end`;
    const capaciteDisque = sql<number>`case
      when ${nodes.ownerId} is not distinct from ${resellerId}::uuid then ${nodes.diskMb}
      else coalesce(${nodeResellerShares.diskMb}, 0) end`;

    return (
      this.db
        .select({
          id: nodes.id,
          name: nodes.name,
          locationId: nodes.locationId,
          location: locations.short,
          maintenance: nodes.maintenanceMode,
          memoryMb: capaciteMemoire,
          diskMb: capaciteDisque,
          allocatedMemoryMb: sql<number>`coalesce(sum(${servers.memoryMb}), 0)::int`,
          allocatedDiskMb: sql<number>`coalesce(sum(${servers.diskMb}), 0)::int`,
          servers: sql<number>`count(distinct ${servers.id})::int`,
        })
        .from(nodes)
        .innerJoin(locations, eq(nodes.locationId, locations.id))
        /*
         * La part est jointe dans les deux cas, et c'est voulu : une jointure
         * conditionnelle ferait deux requêtes au lieu d'une, donc deux formes de
         * réponse à tenir d'accord. Pour la plateforme, `= null` n'apparie rien
         * et la jointure ne rend simplement aucune part ; restreinte au revendeur
         * demandé, elle ne peut pas dupliquer la ligne du node.
         */
        .leftJoin(
          nodeResellerShares,
          and(
            eq(nodeResellerShares.nodeId, nodes.id),
            sql`${nodeResellerShares.resellerId} = ${resellerId}::uuid`,
          ),
        )
        .leftJoin(servers, consommation)
        .where(perimetre)
        .groupBy(
          nodes.id,
          locations.short,
          nodeResellerShares.memoryMb,
          nodeResellerShares.diskMb,
          nodeResellerShares.resellerId,
        )
        .orderBy(nodes.name)
    );
  }

  /** Localisations ouvertes à la commande, avec le stock de ports restant. */
  async locations() {
    return this.catalogue.locations();
  }

  /** Offres du catalogue, telles que l'assistant du panel les propose. */
  async plans() {
    return this.catalogue.plans();
  }

  /** Jeux activés, avec leurs variables : de quoi composer une commande. */
  async eggs() {
    return this.db
      .select({
        id: eggs.id,
        name: eggs.name,
        nest: nests.name,
        description: eggs.description,
        enabled: eggs.enabled,
      })
      .from(eggs)
      .innerJoin(nests, eq(eggs.nestId, nests.id))
      .where(eq(eggs.enabled, true))
      .orderBy(nests.name, eggs.name);
  }

  /** Ports libres d'un node, pour savoir si une commande peut encore y tenir. */
  async freePorts(nodeId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(allocations)
      .where(and(eq(allocations.nodeId, nodeId), isNull(allocations.serverId)));
    return row?.n ?? 0;
  }

  /* --- Fabrique de colonnes ------------------------------------------------- */

  private userColumns() {
    return {
      id: users.id,
      email: users.email,
      nameFirst: users.nameFirst,
      nameLast: users.nameLast,
      role: users.role,
      externalId: users.externalId,
      servers: sql<number>`count(${servers.id})::int`,
      createdAt: users.createdAt,
    };
  }

  /** Combien de serveurs appartiennent encore à ce compte. */
  async ownedServers(userId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(servers)
      .where(eq(servers.ownerId, userId));
    return row?.n ?? 0;
  }
}
