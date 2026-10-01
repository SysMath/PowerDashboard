import { checkResources, type ResourceRequest, serverBlock } from "@gamedashboard/contracts";
import { type Database, servers } from "@gamedashboard/db";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DATABASE } from "../../common/database.provider";
import { ResellerQuotaService } from "../reseller/reseller-quota.service";
import { WebhookEmitterService } from "../webhooks/webhook-emitter.service";
import { WingsClientService } from "../wings/wings-client.service";
import { CatalogueService } from "./catalogue.service";
import { describeResourceProblems, type Requester } from "./server-provisioning.service";

/** Ce qu'on demande de changer. Tout est optionnel : absent veut dire « ne touche pas ». */
export interface ResizeInput {
  memoryMb?: number;
  diskMb?: number;
  cpuPct?: number;
  swapMb?: number;
  allocations?: number;
  backups?: number;
  databases?: number;
  /** `null` rend la limite par défaut du node (ADR 0009). */
  snapshots?: number | null;
}

/**
 * Changer les limites d'un serveur existant.
 *
 * **Rien, nulle part, ne le faisait.** Un serveur naissait avec son offre et
 * la gardait : ni l'administration, ni l'espace revendeur, ni l'API
 * applicative ne pouvaient toucher à sa mémoire. Une montée en gamme — soit
 * l'événement le plus ordinaire de l'hébergement — n'avait qu'un chemin :
 * supprimer et recréer, c'est-à-dire perdre le monde du client.
 *
 * Un seul service pour les trois portes. La facturation d'un tiers, le
 * revendeur qui ajuste à la main et l'administrateur qui dépanne posent la
 * même question ; trois copies de la réponse auraient fini par dire trois
 * choses, et c'est le quota qui en aurait souffert en premier.
 *
 * Trois contrôles, dans cet ordre, parce qu'ils ne se remplacent pas :
 *
 * 1. les **bornes** — pur, sans la base, et il refuse une mémoire négative ;
 * 2. la **machine** — ce que le matériel restant peut porter ;
 * 3. l'**enveloppe** — ce que le revendeur a le droit de vendre.
 *
 * Le daemon applique la mémoire et le processeur **à chaud** : il reçoit le
 * `sync`, met le conteneur à jour sur place et ne redémarre rien. Si cette
 * mise à jour immédiate échoue, il le note et le prochain démarrage rétablit
 * la limite — c'est son propre commentaire, et c'est pourquoi l'écran promet
 * « immédiat ou au prochain démarrage » plutôt que l'un des deux.
 */
@Injectable()
export class ServerResizeService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CatalogueService) private readonly catalogue: CatalogueService,
    @Inject(WingsClientService) private readonly wings: WingsClientService,
    @Inject(ResellerQuotaService) private readonly quotas: ResellerQuotaService,
    @Inject(WebhookEmitterService) private readonly webhooks: WebhookEmitterService,
  ) {}

  async resize(
    requester: Requester,
    serverId: string,
    input: ResizeInput,
  ): Promise<ResourceRequest> {
    const [row] = await this.db
      .select({
        id: servers.id,
        name: servers.name,
        nodeId: servers.nodeId,
        ownerId: servers.ownerId,
        resellerId: servers.resellerId,
        state: servers.state,
        memoryMb: servers.memoryMb,
        diskMb: servers.diskMb,
        cpuPct: servers.cpuPct,
        swapMb: servers.swapMb,
        allocationLimit: servers.allocationLimit,
        backupLimit: servers.backupLimit,
        databaseLimit: servers.databaseLimit,
        snapshotLimit: servers.snapshotLimit,
      })
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);

    if (!row) throw new NotFoundException("Serveur introuvable.");

    /*
     * Ce qui se termine tout seul fait attendre ; le reste, non.
     *
     * Pendant une installation, une restauration ou un transfert, le daemon
     * travaille avec la configuration actuelle : la changer sous lui donnerait
     * un conteneur dont personne ne sait quelles limites il porte, et pour un
     * transfert, deux machines qui ne s'accordent plus sur ce qu'elles
     * copient.
     *
     * Un serveur **suspendu** se redimensionne, lui, et c'est voulu : le
     * client paie son offre supérieure, on ajuste puis on rétablit. Exiger
     * l'ordre inverse ferait tourner un serveur à l'ancienne taille entre les
     * deux gestes, ou obligerait à rétablir avant d'avoir de quoi le porter.
     */
    const blocage = serverBlock(row.state);
    if (blocage?.transient) throw new ConflictException(blocage.body);

    const actuel: ResourceRequest = {
      memoryMb: row.memoryMb,
      diskMb: row.diskMb,
      cpuPct: row.cpuPct,
      swapMb: row.swapMb,
      allocations: row.allocationLimit,
      backups: row.backupLimit,
      databases: row.databaseLimit,
      snapshots: row.snapshotLimit,
    };

    const suivant: ResourceRequest = {
      memoryMb: input.memoryMb ?? actuel.memoryMb,
      diskMb: input.diskMb ?? actuel.diskMb,
      cpuPct: input.cpuPct ?? actuel.cpuPct,
      swapMb: input.swapMb ?? actuel.swapMb,
      allocations: input.allocations ?? actuel.allocations,
      backups: input.backups ?? actuel.backups,
      databases: input.databases ?? actuel.databases,
      // `null` a un sens ici (la limite du node) : seule l'absence ne touche pas.
      snapshots: input.snapshots === undefined ? actuel.snapshots : input.snapshots,
    };

    const problems = checkResources(suivant);
    if (problems.length > 0) throw new BadRequestException(describeResourceProblems(problems));

    // Rien à faire plutôt qu'un aller-retour chez le daemon pour rien : un
    // appel de facturation répété à l'identique ne doit pas agiter la machine.
    const inchange = (Object.keys(suivant) as (keyof ResourceRequest)[]).every(
      (clef) => suivant[clef] === actuel[clef],
    );
    if (inchange) return actuel;

    const croissance = {
      memoryMb: suivant.memoryMb - actuel.memoryMb,
      diskMb: suivant.diskMb - actuel.diskMb,
    };

    const grandit = croissance.memoryMb > 0 || croissance.diskMb > 0;
    if (grandit) await this.assertNodeRoom(requester, row.nodeId, row.resellerId, croissance);

    await this.db.transaction(async (tx) => {
      /*
       * La ligne du serveur d'abord, relue sous verrou : deux redimensionnements
       * du même serveur partiraient sinon de la même taille « actuelle », et la
       * croissance comptée par le second serait fausse de celle du premier.
       * Le plus lent attend, relit, et voit la taille que l'autre a écrite.
       */
      const [verrouille] = await tx
        .select({ memoryMb: servers.memoryMb, diskMb: servers.diskMb })
        .from(servers)
        .where(eq(servers.id, serverId))
        .for("update");
      if (!verrouille) throw new NotFoundException("Serveur introuvable.");

      /*
       * L'enveloppe du revendeur **auquel le serveur se rattache**, et non du
       * demandeur : un agrandissement fait par la plateforme sur la machine
       * d'un revendeur est compté dans sa consommation, il doit donc l'être
       * aussi dans son refus.
       *
       * **Dans la transaction qui écrit**, sous le verrou de l'enveloppe
       * (`assertGrowth`) : contrôlé avant, il laissait N agrandissements
       * simultanés de serveurs différents lire tous la même consommation, et
       * passer tous là où un seul tenait.
       */
      if (row.resellerId) {
        const reelle = {
          memoryMb: suivant.memoryMb - verrouille.memoryMb,
          diskMb: suivant.diskMb - verrouille.diskMb,
        };
        if (reelle.memoryMb > 0 || reelle.diskMb > 0) {
          await this.quotas.assertGrowth(row.resellerId, reelle, tx);
        }
      }

      await tx
        .update(servers)
        .set({
          memoryMb: suivant.memoryMb,
          diskMb: suivant.diskMb,
          cpuPct: suivant.cpuPct,
          swapMb: suivant.swapMb,
          allocationLimit: suivant.allocations,
          backupLimit: suivant.backups,
          databaseLimit: suivant.databases,
          snapshotLimit: suivant.snapshots ?? null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(servers.id, serverId));
    });

    /*
     * Sans attendre l'issue, comme partout ailleurs : un node injoignable ne
     * doit pas empêcher d'enregistrer la décision. Il relira sa configuration
     * à son prochain démarrage, et la nouvelle limite s'appliquera alors.
     */
    await this.wings.syncServer(serverId).catch(() => undefined);

    await this.webhooks.emit("server.resized", {
      serverId: row.id,
      name: row.name,
      ownerId: row.ownerId,
      nodeId: row.nodeId,
      before: actuel,
      after: suivant,
    });

    return suivant;
  }

  /**
   * La place restante sur la machine, vue par celui dont c'est la part.
   *
   * Le node est interrogé **pour le revendeur qui héberge** quand il y en a
   * un : sur une part de 8 Go, valider contre les 128 Go du matériel laisserait
   * un revendeur déborder de sa tranche sur celle de son voisin. C'est la même
   * règle qu'à la création, et elle est écrite ici pour la même raison.
   */
  private async assertNodeRoom(
    requester: Requester,
    nodeId: string,
    resellerId: string | null,
    croissance: { memoryMb: number; diskMb: number },
  ): Promise<void> {
    const pour: Requester = resellerId ? { id: resellerId, role: "reseller" } : requester;
    const node = await this.catalogue.nodeCapacity(nodeId, pour);

    // Une machine que le demandeur ne peut pas voir : on ne dit pas laquelle.
    if (!node) throw new ConflictException("La machine de ce serveur est indisponible.");

    if (croissance.memoryMb > node.freeMemoryMb) {
      throw new ConflictException(
        `Il ne reste que ${node.freeMemoryMb} Mo de mémoire sur cette machine, et il en faut ${croissance.memoryMb} de plus.`,
      );
    }
    if (croissance.diskMb > node.freeDiskMb) {
      throw new ConflictException(
        `Il ne reste que ${node.freeDiskMb} Mo de disque sur cette machine, et il en faut ${croissance.diskMb} de plus.`,
      );
    }
  }
}
