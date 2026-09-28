import {
  allocations,
  type Database,
  nodeResellerShares,
  nodes,
  servers,
  serverTransfers,
} from "@gamedashboard/db";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import { DATABASE } from "../../common/database.provider";
import { SubdomainsService } from "../dns/subdomains.service";
import { NotificationsService } from "../notifications/notifications.service";
import { WebhookEmitterService } from "../webhooks/webhook-emitter.service";
import { WingsClientService } from "../wings/wings-client.service";
import { WingsTokenService } from "../wings/wings-token.service";

/**
 * Déménagement d'un serveur d'un node vers un autre.
 *
 * **L'archive ne passe pas par le panel.** Le node de départ la fabrique et la
 * pousse directement vers celui d'arrivée, avec un jeton que nous signons pour
 * lui. Faire transiter plusieurs gigaoctets par le panel en ferait un goulot
 * d'étranglement, et une coupure de son côté interromprait un transfert qui ne
 * le concerne pas.
 *
 * Le panel garde les trois décisions qui comptent, et elles ne se délèguent
 * pas : **où** le serveur va, **quand** la bascule est enregistrée, et **quoi
 * faire** si elle échoue.
 *
 * La règle qui gouverne tout le reste : **rien ne bascule avant l'accusé de
 * réception**. Tant que le node d'arrivée n'a pas confirmé, la base continue de
 * désigner le node de départ, où le serveur existe encore. Inverser cet ordre —
 * écrire le nouveau node puis attendre — donnerait, en cas d'échec, un serveur
 * que le panel croit ici et qui se trouve là-bas.
 */

/**
 * Au-delà, un transfert qui n'a rien rapporté est considéré comme perdu.
 *
 * Deux heures : bien plus qu'il n'en faut pour un serveur ordinaire, et assez
 * pour ne pas déclarer mort un transfert de cent gigaoctets sur une liaison
 * lente. Sans ce garde-fou, un daemon qui meurt en plein travail laisserait le
 * serveur bloqué en « transfert » pour toujours — inutilisable, et sans que
 * personne puisse le débloquer autrement qu'en base.
 */
export const TRANSFER_STALE_MS = 2 * 60 * 60 * 1000;

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Motif conservé pour un transfert clos faute de nouvelles. */
export const STALE_REASON = "Aucun compte rendu des daemons en deux heures : transfert abandonné.";

export interface TransferView {
  id: string;
  serverId: string;
  fromNodeName: string;
  toNodeName: string;
  state: string;
  failureReason: string | null;
  startedAt: string;
}

@Injectable()
export class ServerTransferService {
  private readonly logger = new Logger(ServerTransferService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(WingsClientService) private readonly wings: WingsClientService,
    @Inject(WingsTokenService) private readonly tokens: WingsTokenService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Inject(WebhookEmitterService) private readonly webhooks: WebhookEmitterService,
    @Inject(SubdomainsService) private readonly subdomains: SubdomainsService,
  ) {}

  /**
   * Lance un transfert.
   *
   * Le port d'arrivée est **réservé avant de partir**, et c'est le point
   * délicat : il est pris sur le node de destination au moment où l'on décide,
   * pas à l'arrivée de l'archive. Attendre la fin pour chercher un port libre
   * ferait échouer un transfert de quarante minutes sur un node qui s'est
   * rempli entre-temps — et laisserait un serveur nulle part.
   */
  async start(serverId: string, toNodeId: string): Promise<TransferView> {
    const [server] = await this.db
      .select({
        id: servers.id,
        name: servers.name,
        ownerId: servers.ownerId,
        resellerId: servers.resellerId,
        state: servers.state,
        fromNodeId: servers.nodeId,
        fromNodeName: nodes.name,
      })
      .from(servers)
      .innerJoin(nodes, eq(servers.nodeId, nodes.id))
      .where(eq(servers.id, serverId))
      .limit(1);

    if (!server) throw new NotFoundException("Serveur introuvable.");
    if (server.fromNodeId === toNodeId) {
      throw new BadRequestException("Ce serveur est déjà sur ce node.");
    }
    /*
     * Un serveur occupé ne se déménage pas.
     *
     * « En installation » veut dire qu'un script écrit dans son disque à
     * l'instant même : l'archiver donnerait une copie prise au milieu d'une
     * écriture. « Suspendu » relève d'une décision administrative qu'un
     * déplacement ne doit pas contourner discrètement.
     */
    if (server.state !== null) {
      throw new ConflictException(
        `Ce serveur est en état « ${server.state} » : le transfert attendra qu'il soit disponible.`,
      );
    }

    const [target] = await this.db
      .select({
        id: nodes.id,
        name: nodes.name,
        maintenance: nodes.maintenanceMode,
        ownerId: nodes.ownerId,
      })
      .from(nodes)
      .where(eq(nodes.id, toNodeId))
      .limit(1);

    if (!target) throw new NotFoundException("Node de destination introuvable.");
    // Un node en maintenance est annoncé indisponible : y envoyer un serveur
    // reviendrait à contredire la décision qu'on vient de prendre.
    if (target.maintenance) {
      throw new ConflictException("Ce node est en maintenance : il n'accepte pas de serveur.");
    }
    await this.assertWithinPerimeter(server.resellerId, target.id, target.ownerId);

    const transferId = await this.reserve(serverId, server.fromNodeId, toNodeId);

    /*
     * L'ordre part en dernier, une fois la base prête.
     *
     * Si le daemon répond et que rien n'était réservé, l'accusé de réception
     * arriverait sur un transfert qui n'existe pas et serait ignoré : le
     * serveur aurait déménagé sans que le panel le sache.
     */
    try {
      const grant = await this.tokens.transferGrant(serverId, toNodeId);
      await this.wings.startTransfer(serverId, grant);
    } catch (error) {
      // Le node de départ n'a pas pris l'ordre : on défait tout de suite, sinon
      // le serveur resterait bloqué en « transfert » sans que rien ne se passe.
      await this.rollback(transferId, serverId, describe(error));
      throw new ServiceUnavailableException(
        `Le node de départ n'a pas accepté le transfert : ${describe(error)}`,
      );
    }

    await this.webhooks.emit("server.transfer_started", {
      serverId,
      fromNodeId: server.fromNodeId,
      toNodeId,
    });

    return {
      id: transferId,
      serverId,
      fromNodeName: server.fromNodeName,
      toNodeName: target.name,
      state: "running",
      failureReason: null,
      startedAt: new Date().toISOString(),
    };
  }

  /**
   * Le node d'arrivée doit rester dans le périmètre du revendeur du serveur.
   *
   * Le rattachement (`servers.reseller_id`) décide de ce que voit un revendeur
   * et de la part qui compte la consommation du serveur ; le transfert ne le
   * change pas. Deux arrivées le trahiraient (audit ASVS, doute D-10) :
   *
   * - **la machine confiée en entier à un autre revendeur** : il l'administre,
   *   il lirait les disques d'un client qui n'est pas le sien. Vaut aussi pour
   *   un serveur de la plateforme ;
   * - **une machine partagée où le revendeur n'a pas de part** : plus rien ne
   *   compterait la consommation du serveur, ni contre une part ni contre le
   *   plafond qui déclenche les coupures.
   *
   * Refuser plutôt que rattacher d'office au nouveau revendeur : changer de
   * revendeur, c'est changer de fournisseur pour le client, une décision
   * commerciale qu'un déménagement technique ne prend pas en passant. Le geste
   * légitime reste possible en deux temps : poser d'abord la part.
   */
  private async assertWithinPerimeter(
    resellerId: string | null,
    toNodeId: string,
    toNodeOwnerId: string | null,
  ): Promise<void> {
    if (toNodeOwnerId !== null && toNodeOwnerId !== resellerId) {
      throw new ConflictException(
        "Ce node est confié à un autre revendeur : le serveur n'y a pas sa place.",
      );
    }
    if (resellerId === null || toNodeOwnerId === resellerId) return;

    const [share] = await this.db
      .select({ id: nodeResellerShares.id })
      .from(nodeResellerShares)
      .where(
        and(eq(nodeResellerShares.nodeId, toNodeId), eq(nodeResellerShares.resellerId, resellerId)),
      )
      .limit(1);
    if (!share) {
      throw new ConflictException(
        "Le revendeur de ce serveur n'a pas de part sur ce node : posez-lui d'abord une part.",
      );
    }
  }

  /**
   * Réserve le port d'arrivée et marque le serveur en transfert.
   *
   * Tout en une transaction : un port réservé sans ligne de transfert ne serait
   * jamais rendu, et une ligne de transfert sans port laisserait le serveur
   * arriver sans adresse.
   *
   * Le port est pris sur la destination et **rattaché tout de suite** au
   * serveur, bien qu'il tourne encore ailleurs. C'est délibéré : c'est la seule
   * façon de le mettre de côté. Le port d'origine reste lui aussi rattaché
   * jusqu'à la bascule — le serveur en porte donc deux le temps du voyage, ce
   * que rien n'interdit puisqu'ils sont sur des machines différentes.
   */
  private async reserve(serverId: string, fromNodeId: string, toNodeId: string): Promise<string> {
    return this.db.transaction(async (tx) => {
      const [reserved] = await tx
        .select({ id: allocations.id })
        .from(allocations)
        .where(and(eq(allocations.nodeId, toNodeId), isNull(allocations.serverId)))
        .orderBy(allocations.port)
        .limit(1)
        .for("update", { skipLocked: true });

      if (!reserved) {
        throw new ServiceUnavailableException("Plus aucun port libre sur le node de destination.");
      }

      await tx
        .update(allocations)
        .set({ serverId, updatedAt: new Date().toISOString() })
        .where(eq(allocations.id, reserved.id));

      const [row] = await tx
        .insert(serverTransfers)
        .values({ serverId, fromNodeId, toNodeId, state: "running" })
        .returning({ id: serverTransfers.id });

      await tx
        .update(servers)
        .set({ state: "transferring", updatedAt: new Date().toISOString() })
        .where(eq(servers.id, serverId));

      if (!row) throw new ServiceUnavailableException("Transfert non enregistré.");
      return row.id;
    });
  }

  /**
   * Le node d'arrivée a confirmé : la base bascule.
   *
   * C'est **le seul endroit** où `servers.node_id` change. L'allocation
   * d'origine est rendue au node de départ, et celle qui avait été réservée
   * devient l'allocation par défaut : le serveur change donc d'adresse, ce qui
   * est inévitable — un port appartient à une machine.
   */
  async complete(serverId: string): Promise<void> {
    const transfer = await this.pending(serverId);
    if (!transfer) {
      this.logger.warn(`Transfert confirmé pour ${serverId}, mais aucun n'était en cours.`);
      return;
    }

    const switched = await this.db.transaction(async (tx) => {
      /*
       * La ligne du transfert est verrouillée, et relue « en cours ».
       *
       * Le balayage des transferts perdus peut clore celui-ci à l'instant où
       * l'accusé de réception arrive. Sans verrou, les deux passeraient : la
       * bascule rattacherait le serveur au port d'arrivée, puis le retour en
       * arrière rendrait ce même port — un serveur sans adresse. Le premier
       * arrivé gagne, le second ne trouve plus rien à faire.
       */
      if (!(await lockRunning(tx, transfer.id))) return false;

      const [arrival] = await tx
        .select({ id: allocations.id })
        .from(allocations)
        .where(and(eq(allocations.serverId, serverId), eq(allocations.nodeId, transfer.toNodeId)))
        .orderBy(allocations.port)
        .limit(1);

      if (!arrival) {
        throw new ServiceUnavailableException("Le port réservé à l'arrivée a disparu.");
      }

      // Les ports du node de départ sont rendus **avant** la bascule : après,
      // la condition « allocation du node de départ » ne désignerait plus rien
      // d'autre que des lignes qu'on aurait laissées derrière soi.
      await tx
        .update(allocations)
        .set({ serverId: null, updatedAt: new Date().toISOString() })
        .where(
          and(eq(allocations.serverId, serverId), eq(allocations.nodeId, transfer.fromNodeId)),
        );

      await tx
        .update(servers)
        .set({
          nodeId: transfer.toNodeId,
          allocationId: arrival.id,
          state: null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(servers.id, serverId));

      await tx
        .update(serverTransfers)
        .set({ state: "completed", updatedAt: new Date().toISOString() })
        .where(eq(serverTransfers.id, transfer.id));

      return true;
    });

    if (!switched) {
      this.logger.warn(`Transfert confirmé pour ${serverId}, mais il venait d'être clos.`);
      return;
    }

    // L'adresse a changé : le sous-domaine la suit, sans retenir la bascule.
    void this.subdomains.refresh(serverId);

    /*
     * La copie de départ est retirée, et **après** la bascule.
     *
     * Ni le panel ni le daemon ne le faisaient : le volume restait sur la
     * machine d'origine après un transfert réussi. De l'espace occupé que plus
     * rien ne rattache à personne, et une copie des fichiers du client là où
     * il ne s'attend plus à les trouver. Relevé en déplaçant un serveur entre
     * deux daemons.
     *
     * L'ordre compte : tant que la base n'a pas basculé, effacer chez le
     * départ détruirait le seul exemplaire que le panel sait retrouver.
     *
     * Et l'échec ne défait rien. Le serveur **est** arrivé, ses fichiers sont
     * sur la nouvelle machine, son adresse a changé : revenir en arrière pour
     * un volume qui traîne coûterait bien plus que ce qu'il occupe. On le
     * consigne, et quelqu'un le balaiera.
     */
    await this.wings.deleteServerOnNode(serverId, transfer.fromNodeId).catch((error: unknown) => {
      this.logger.warn(
        `Transfert de ${serverId} : le node de départ n'a pas retiré sa copie — ${describe(error)}. ` +
          "Le serveur a bien été déplacé ; le volume d'origine reste à effacer à la main.",
      );
    });

    await this.notifications.notifyServerOwner(serverId, {
      type: "server.transferred",
      level: "success",
      title: "Serveur déplacé",
      body: "Votre serveur a changé de machine. Son adresse a changé : relevez-la dans ses paramètres avant de la communiquer à vos joueurs.",
    });

    await this.webhooks.emit("server.transfer_completed", {
      serverId,
      fromNodeId: transfer.fromNodeId,
      toNodeId: transfer.toNodeId,
    });
  }

  /**
   * Le transfert a échoué : tout revient en place.
   *
   * Le serveur n'a jamais quitté son node d'origine du point de vue de la base,
   * et il y tourne toujours : il n'y a donc rien à restaurer, seulement à
   * rendre ce qui avait été mis de côté. Le node d'arrivée nettoie ses propres
   * fichiers de son côté.
   *
   * La raison est **conservée**, et c'est le plus utile : « échoué » sans motif
   * oblige à fouiller les journaux de deux machines.
   */
  async fail(serverId: string, reason: string, reportedBy?: string): Promise<void> {
    const transfer = await this.pending(serverId);
    if (!transfer) {
      this.logger.warn(
        `Échec de transfert rapporté pour ${serverId}, mais aucun n'était en cours.`,
      );
      return;
    }

    // Seuls les deux bouts du transfert peuvent le faire échouer : un autre
    // node n'a rien à en dire, et pourrait sinon annuler ceux des autres.
    if (
      reportedBy !== undefined &&
      reportedBy !== transfer.fromNodeId &&
      reportedBy !== transfer.toNodeId
    ) {
      this.logger.warn(
        `Échec de transfert rapporté pour ${serverId} par un node qui n'y participe pas : ignoré.`,
      );
      return;
    }

    if (!(await this.rollback(transfer.id, serverId, reason))) return;

    await this.notifications.notifyServerOwner(serverId, {
      type: "server.transfer_failed",
      level: "danger",
      title: "Déplacement interrompu",
      body: "Votre serveur n'a pas pu changer de machine. Il continue de fonctionner là où il était.",
    });

    await this.webhooks.emit("server.transfer_failed", {
      serverId,
      fromNodeId: transfer.fromNodeId,
      toNodeId: transfer.toNodeId,
      reason,
    });
  }

  /**
   * Rend le port réservé et remet le serveur en état.
   *
   * Appelé aussi bien quand le daemon refuse l'ordre que lorsqu'il rapporte un
   * échec : dans les deux cas, ce qu'il faut défaire est exactement le même.
   */
  private async rollback(transferId: string, serverId: string, reason: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      // Même verrou que la bascule : un transfert déjà conclu dans un sens ne
      // se conclut pas dans l'autre. Rendre le port d'un serveur qui vient
      // d'arriver lui retirerait sa seule adresse.
      const transfer = await lockRunning(tx, transferId);
      if (!transfer) return false;

      await tx
        .update(allocations)
        .set({ serverId: null, updatedAt: new Date().toISOString() })
        .where(and(eq(allocations.serverId, serverId), eq(allocations.nodeId, transfer.toNodeId)));

      await tx
        .update(serverTransfers)
        .set({
          state: "failed",
          failureReason: reason.slice(0, 500),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(serverTransfers.id, transferId));

      /*
       * L'état de gestion est **effacé**, pas remis à une valeur choisie.
       *
       * `null` veut dire « rien de particulier », ce qui est exact : le serveur
       * est là où il a toujours été, disponible. Écrire autre chose laisserait
       * une marque qu'il faudrait penser à retirer ensuite.
       */
      await tx
        .update(servers)
        .set({ state: null, updatedAt: new Date().toISOString() })
        .where(and(eq(servers.id, serverId), eq(servers.state, "transferring")));

      return true;
    });
  }

  /**
   * Clôt les transferts dont aucun daemon n'a rapporté l'issue.
   *
   * **Ce qui manquait.** Un daemon mort en pleine copie, un compte rendu
   * perdu : rien ne concluait le transfert. `TRANSFER_STALE_MS` retirait au
   * node d'arrivée le droit de lire la configuration, mais le serveur restait
   * en « transfert » pour toujours — toute action refusée, au client comme à
   * l'administration, et la seule sortie était une requête écrite à la main
   * en base.
   *
   * Passé le délai, le transfert est traité comme un échec rapporté : même
   * retour en arrière, même notification, même webhook. C'est sans risque pour
   * les fichiers — la base n'a jamais cessé de désigner le node de départ, qui
   * garde sa copie jusqu'à la bascule. Et c'est cohérent avec le délai : une
   * réussite annoncée plus tard serait de toute façon refusée
   * (`isTransferTarget`).
   *
   * Rend le nombre de transferts clos.
   */
  async expireStale(now: Date = new Date()): Promise<number> {
    const threshold = new Date(now.getTime() - TRANSFER_STALE_MS).toISOString();
    const stale = await this.db
      .select({ serverId: serverTransfers.serverId })
      .from(serverTransfers)
      .where(and(eq(serverTransfers.state, "running"), lt(serverTransfers.createdAt, threshold)));

    for (const { serverId } of stale) {
      this.logger.warn(`Transfert de ${serverId} sans compte rendu depuis deux heures : clos.`);
      await this.fail(serverId, STALE_REASON);
    }
    return stale.length;
  }

  /**
   * Le transfert en cours d'un serveur, s'il y en a un.
   *
   * Le plus récent seulement : un serveur a pu être déplacé plusieurs fois, et
   * les anciennes lignes racontent son histoire sans concerner le présent.
   */
  private async pending(serverId: string): Promise<{
    id: string;
    fromNodeId: string;
    toNodeId: string;
  } | null> {
    const [row] = await this.db
      .select({
        id: serverTransfers.id,
        fromNodeId: serverTransfers.fromNodeId,
        toNodeId: serverTransfers.toNodeId,
      })
      .from(serverTransfers)
      .where(and(eq(serverTransfers.serverId, serverId), eq(serverTransfers.state, "running")))
      .orderBy(desc(serverTransfers.createdAt))
      .limit(1);

    return row ?? null;
  }

  /**
   * Le node d'arrivée a-t-il le droit de lire la configuration de ce serveur ?
   *
   * Question posée par les routes que le daemon appelle. Pendant un transfert,
   * la base désigne encore le node de départ — délibérément — mais celui
   * d'arrivée doit pouvoir installer le serveur qu'il reçoit, et donc en
   * connaître la configuration. Sans cette exception, il obtiendrait un 404 et
   * le transfert échouerait à la dernière étape, sans raison lisible.
   *
   * L'exception reste étroite : ce node précis, ce serveur précis, et seulement
   * tant que le transfert court.
   */
  async isTransferTarget(serverId: string, nodeId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: serverTransfers.id })
      .from(serverTransfers)
      .where(
        and(
          eq(serverTransfers.serverId, serverId),
          eq(serverTransfers.toNodeId, nodeId),
          eq(serverTransfers.state, "running"),
          // Un transfert qu'on n'a plus vu depuis des heures n'ouvre plus rien :
          // sans cette borne, une ligne oubliée en base laisserait un node lire
          // indéfiniment un serveur qui ne lui appartient pas.
          sql`${serverTransfers.createdAt} > now() - ${`${TRANSFER_STALE_MS} milliseconds`}::interval`,
        ),
      )
      .limit(1);

    return row !== undefined;
  }
}

/**
 * Verrouille la ligne d'un transfert **encore en cours**, et la rend.
 *
 * `null` si le transfert n'est plus en cours : quelqu'un d'autre l'a conclu
 * entre la lecture et la transaction.
 */
async function lockRunning(
  tx: Transaction,
  transferId: string,
): Promise<{ toNodeId: string } | null> {
  const [row] = await tx
    .select({ toNodeId: serverTransfers.toNodeId })
    .from(serverTransfers)
    .where(and(eq(serverTransfers.id, transferId), eq(serverTransfers.state, "running")))
    .limit(1)
    .for("update");
  return row ?? null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
