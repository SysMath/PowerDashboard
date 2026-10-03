import { provisioningMode } from "@gamedashboard/contracts";
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { PlatformSettingsService } from "../admin/platform-settings.service";
import { ImpersonationReadOnlyGuard } from "../auth/impersonation.guard";
import type { AuthenticatedRequest } from "../auth/session.guard";
import { isBrowserSession, SessionGuard } from "../auth/session.guard";
import { BillingService } from "../billing/billing.service";
import { NodeCapabilitiesService } from "../node-agent/node-capabilities.service";
import { ResellerQuotaService } from "../reseller/reseller-quota.service";
import { CatalogueService } from "./catalogue.service";
import { ClientNodesService } from "./client-nodes.service";
import { type ClientServer, ClientServersService } from "./client-servers.service";
import { accessPrincipal, ServerAccessService } from "./server-access.service";
import { ServerProvisioningService } from "./server-provisioning.service";
import { SubusersService } from "./subusers.service";

/**
 * Corps de création, tous modes confondus.
 *
 * Les champs des modes avancés sont **facultatifs** ici et non interdits : les
 * refuser au parsing obligerait à connaître le rôle à cet endroit, et la règle
 * vivrait alors à deux endroits. Le service tranche, seul.
 */
const CreateServerBody = z.object({
  eggId: z.string().min(1, "Jeu manquant."),
  name: z.string().min(1, "Nom manquant."),
  variables: z.record(z.string(), z.string()).optional(),
  planId: z.string().optional(),
  locationId: z.string().optional(),
  nodeId: z.string().optional(),
  ownerId: z.string().optional(),
  resources: z
    .object({
      memoryMb: z.number(),
      diskMb: z.number(),
      cpuPct: z.number(),
      swapMb: z.number(),
      allocations: z.number(),
      backups: z.number(),
      databases: z.number(),
    })
    .optional(),
});

/** Posé par `SessionGuard`, jamais lu depuis l'URL ou le corps. */
type ClientRequest = AuthenticatedRequest;

@Controller("api/v1/client")
@UseGuards(SessionGuard, ImpersonationReadOnlyGuard)
export class ClientController {
  constructor(
    @Inject(ClientServersService) private readonly servers: ClientServersService,
    @Inject(ClientNodesService) private readonly nodes: ClientNodesService,
    @Inject(CatalogueService) private readonly catalogue: CatalogueService,
    @Inject(ServerProvisioningService) private readonly provisioning: ServerProvisioningService,
    @Inject(ResellerQuotaService) private readonly quotas: ResellerQuotaService,
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(PlatformSettingsService) private readonly platform: PlatformSettingsService,
    @Inject(SubusersService) private readonly subusers: SubusersService,
    // Le point de passage unique des droits sur un serveur : c'est lui qui
    // connaît le propriétaire, le sous-utilisateur, le personnel et le
    // revendeur qui héberge.
    @Inject(ServerAccessService) private readonly access: ServerAccessService,
    // Ce que la machine du serveur offre par son agent (ADR 0008, 0009).
    @Inject(NodeCapabilitiesService) private readonly capabilities: NodeCapabilitiesService,
  ) {}

  /**
   * Services facturés du client connecté, lus chez le facturier relié.
   *
   * Sous `client` et non sous une route publique : ce sont **ses** échéances,
   * et la garde de session est ce qui garantit qu il ne voit que les siennes.
   */
  @Get("billing")
  async billingSummary(@Req() request: ClientRequest) {
    return { data: await this.billing.summaryFor(request.user.id) };
  }

  @Get("nodes")
  async listNodes() {
    return { data: await this.nodes.publicNodes() };
  }

  @Get("servers")
  async listServers(@Req() request: ClientRequest): Promise<{ data: ClientServer[] }> {
    return { data: await this.servers.forUser(request.user.id) };
  }

  /**
   * Catalogue de création : jeux, offres, localisations.
   *
   * Servi en une réponse plutôt qu'en trois : l'assistant en a besoin des trois
   * dès le premier écran pour griser les offres trop petites, et trois
   * aller-retours feraient apparaître le formulaire par morceaux.
   */
  @Get("catalogue")
  async catalogueForCreation(@Req() request: ClientRequest) {
    const mode = provisioningMode(request.user.role);
    const [games, plans, locations, nodes, quota] = await Promise.all([
      this.catalogue.games(),
      this.catalogue.plans(),
      this.catalogue.locations(),
      // Vide pour un client : il ne désigne pas de node, et lui envoyer la
      // carte du parc lui apprendrait la capacité de chaque machine.
      this.catalogue.nodesFor(request.user),
      /**
       * L'enveloppe du revendeur, pour que l'assistant sache ce qui reste.
       *
       * `null` pour les autres rôles, et non une enveloppe illimitée : la
       * notion ne s'applique pas à eux, et leur envoyer un objet ferait croire
       * à un plafond qui n'existe pas. Un client ordinaire a d'ailleurs sa
       * propre limite, qui n'a rien à voir.
       */
      mode === "assisted" ? this.quotas.report(request.user.id) : null,
    ]);
    return { data: { mode, games, plans, locations, nodes, quota } };
  }

  /* --- Invitations reçues -------------------------------------------------- */

  /**
   * Invitations qu'on m'a faites et que je n'ai pas tranchées.
   *
   * Sous `client` et non sous un serveur : par définition, je n'ai pas encore
   * accès à ce serveur, et une route sous son identifiant me serait refusée par
   * le contrôle d'accès avant même d'être lue.
   */
  @Get("invitations")
  async invitations(@Req() request: ClientRequest) {
    return { data: await this.subusers.pendingFor(request.user.id) };
  }

  @Post("invitations/:serverId/accept")
  async acceptInvitation(@Req() request: ClientRequest, @Param("serverId") serverId: string) {
    await this.subusers.accept(request.user.id, serverId);
    return { data: { accepted: serverId } };
  }

  @Post("invitations/:serverId/decline")
  async declineInvitation(@Req() request: ClientRequest, @Param("serverId") serverId: string) {
    await this.subusers.decline(request.user.id, serverId);
    return { data: { declined: serverId } };
  }

  /**
   * Fonctions ouvertes sur ce panel, pour ce compte.
   *
   * Servie au client parce que ses écrans doivent cesser de proposer ce que
   * l'API refusera : une entrée de navigation qui mène à un écran capable de
   * dire seulement non est pire qu'une entrée absente.
   *
   * Ce n'est **pas** une décision de sécurité — celle-ci est prise sur chaque
   * route. C'est ce qui permet à l'écran d'être d'accord avec elle.
   */
  @Get("features")
  async features(@Req() request: ClientRequest) {
    const [marketplace, creation] = await Promise.all([
      this.platform.flag("marketplace"),
      this.platform.flag("server-creation"),
    ]);

    return {
      data: {
        marketplace,
        // Le libre-service ne concerne que les comptes ordinaires : un
        // revendeur provisionne sur ses machines quoi qu'il arrive.
        serverCreation: provisioningMode(request.user.role) === "guided" ? creation : true,
      },
    };
  }

  /**
   * Crée un serveur.
   *
   * Refusé à une clé d'API : la création engage des ressources et, à terme, une
   * facturation. Elle doit rester un geste fait par une personne connectée, pas
   * une boucle qu'un script mal écrit peut lancer mille fois.
   */
  @Post("servers")
  async createServer(@Req() request: ClientRequest, @Body() body: unknown) {
    if (request.scopes !== null) {
      throw new ForbiddenException(
        "Les clés d'API ne peuvent pas créer de serveur. Connectez-vous au panel.",
      );
    }
    // Ni l'application mobile : le formulaire de création reste sur le web.
    if (!isBrowserSession(request)) {
      throw new ForbiddenException("Un serveur se crée dans le panel, depuis un navigateur.");
    }

    /*
     * Le libre-service peut être fermé, et le drapeau le dit vraiment.
     *
     * Il ne vise que les **clients** : un revendeur qui provisionne sur ses
     * propres machines fait son métier, et une administration qui crée un
     * serveur répond à une commande. Fermer le libre-service veut dire « les
     * comptes ordinaires passent par la boutique », pas « plus personne ne
     * crée de serveur ».
     */
    if (
      provisioningMode(request.user.role) === "guided" &&
      !(await this.platform.flag("server-creation"))
    ) {
      throw new ForbiddenException(
        "La création de serveur en libre-service est fermée sur ce panel. Passez par la boutique.",
      );
    }

    const parsed = CreateServerBody.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? "Requête invalide.");
    }

    /**
     * Le corps est relayé tel quel : c'est le service qui décide de ce qu'il en
     * retient, selon le rôle.
     *
     * Filtrer ici selon le mode ferait exister deux endroits où la règle est
     * écrite, et le jour où l'un change sans l'autre, c'est le plus permissif
     * qui gagne.
     */
    return {
      data: await this.provisioning.create(request.user, {
        ...parsed.data,
        variables: parsed.data.variables ?? {},
      }),
    };
  }

  /**
   * Un serveur précis.
   *
   * L'accès passe par `ServerAccessService`, comme **toutes** les autres routes
   * de ce serveur — et c'est le correctif : cette route-ci consultait la liste
   * « mes serveurs », qui ne connaît que la propriété et l'invitation. Un
   * administrateur et un revendeur se voyaient donc répondre « introuvable » à
   * l'ouverture d'un serveur dont toutes les autres routes leur obéissaient
   * ensuite. Le panel se contredisait, une deuxième fois et au même endroit.
   *
   * `console.read` est la permission demandée : c'est la moins étendue de
   * celles qui laissent regarder un serveur, et ouvrir sa fiche n'est rien de
   * plus que le regarder.
   */
  @Get("servers/:id")
  async server(
    @Req() request: ClientRequest,
    @Param("id") id: string,
  ): Promise<{ data: ClientServer & { snapshots: boolean } }> {
    // Lève 404 pour un inconnu — même réponse que « n'existe pas », pour qu'on
    // ne puisse pas énumérer les serveurs des autres.
    await this.access.require(accessPrincipal(request), id, "console.read");

    const server = await this.servers.byId(id, request.user.id);
    if (!server) throw new NotFoundException("Serveur introuvable.");
    // L'onglet « Instantanés » n'existe que là où la machine les offre : une
    // entrée ailleurs mènerait à un écran qui ne peut que répondre 404.
    const nodeId = await this.servers.nodeOf(id);
    const snapshots =
      nodeId !== null && (await this.capabilities.forNode(nodeId)).instantanes.offered;
    return { data: { ...server, snapshots } };
  }

  /**
   * Commandes du jeu, pour l'autocomplétion de la console (PLAN §10.2).
   *
   * `console.read` et non `console.send` : la liste ne donne aucun pouvoir, et
   * celui qui lit la console sans pouvoir y écrire doit pouvoir savoir ce que
   * les commandes qu'il y voit passer veulent dire.
   */
  @Get("servers/:id/commands")
  async consoleCommands(
    @Req() request: ClientRequest,
    @Param("id") id: string,
  ): Promise<{ data: { commands: string[] } }> {
    await this.access.require(accessPrincipal(request), id, "console.read");
    return { data: { commands: await this.servers.consoleCommands(id) } };
  }
}
