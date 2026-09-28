import { type Database, resellerBrandings, servers, users } from "@gamedashboard/db";
import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { DATABASE } from "../../common/database.provider";
import { isUuid } from "../../common/uuid";
import { PlatformSettingsService } from "../admin/platform-settings.service";
import { AuthTokenRepository } from "./auth-token.repository";

/**
 * Le lien par lequel un client entre dans le panel.
 *
 * **C'est le chemin d'entrée ordinaire**, et non une commodité ajoutée à côté
 * du formulaire de connexion. Le client de GameDashboard n'a pas de mot de
 * passe ici : il a un compte chez le système de facturation, où il a commandé
 * et où il paie. Le plugin installé là-bas lui montre un bouton « Gérer mon
 * serveur », demande ce lien à l'API applicative, et le redirige. Il arrive
 * connecté sans avoir rien saisi.
 *
 * Le panel n'est donc **pas un serveur OAuth** : ni `/authorize`, ni écran de
 * consentement, ni portées révocables. Ce serait le protocole d'une relation
 * entre deux parties qui se méfient l'une de l'autre, alors qu'ici le facturier
 * détient déjà les clés applicatives — il peut créer, suspendre et supprimer
 * des serveurs. Lui demander en plus le consentement du client pour ouvrir sa
 * session serait une cérémonie sans contenu.
 *
 * Trois refus le tiennent, et chacun ferme une porte réelle :
 *
 * 1. **Le compte doit exister.** Le plugin le crée à la commande ; le panel ne
 *    fabrique personne sur présentation d'un identifiant. Rien n'apparaît ici
 *    qui n'ait été commandé.
 * 2. **Jamais un compte du personnel ni d'un revendeur.** Une clé
 *    applicative qui fuite doit pouvoir provisionner, pas devenir
 *    administrateur du panel ni revendeur à la place d'un revendeur. Ce sont
 *    les escalades que ce chemin rendrait possibles, et elles sont fermées
 *    d'emblée.
 * 3. **Le lien vit deux minutes et ne sert qu'une fois**, comme un jeton de
 *    réinitialisation — parce que c'en est un, techniquement, et qu'il ouvre
 *    davantage.
 */

/** Rôles qui n'entrent jamais par ce chemin. Voir le refus n° 2. */
const PERSONNEL = new Set(["admin", "support"]);

export interface BillingSsoLink {
  url: string;
  expiresAt: string;
}

/**
 * Le refus de l'absence, et celui de tout compte qui n'est pas à la clé : les
 * deux doivent se confondre.
 */
const AUCUN_COMPTE =
  "Aucun compte ne correspond. Créez-le d'abord par POST /api/v1/application/users : " +
  "le panel n'ouvre pas de session pour un client qu'il ne connaît pas.";

@Injectable()
export class BillingSsoService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AuthTokenRepository) private readonly tokens: AuthTokenRepository,
    @Inject(PlatformSettingsService) private readonly settings: PlatformSettingsService,
  ) {}

  /**
   * Émet un lien de connexion pour un client du facturier.
   *
   * Le client est désigné **par son identifiant chez le facturier**
   * (`externalId`) ou par celui du panel. Le premier est celui qui sert : le
   * facturier connaît ses propres clients, et le forcer à retenir nos
   * identifiants l'obligerait à tenir une table de correspondance qui se
   * désynchronise.
   */
  async issue(
    criteria: { userId?: string; externalId?: string },
    /**
     * Revendeur auquel la clé appelante est bornée, ou `null` pour la
     * plateforme.
     *
     * Le contrôle est fait **ici** et non seulement dans le contrôleur : cette
     * méthode ouvre une session au nom de quelqu'un, et c'est la dernière
     * chose qu'on veut voir appelée un jour depuis un second endroit qui
     * aurait oublié de vérifier.
     */
    resellerId: string | null = null,
  ): Promise<BillingSsoLink> {
    const cible =
      criteria.userId !== undefined
        ? // Un identifiant illisible ne désigne personne ; la base l'aurait
          // refusé par une erreur 500. `false` : aucune ligne, donc le 404
          // ci-dessous, comme pour un compte inconnu.
          isUuid(criteria.userId)
          ? eq(users.id, criteria.userId)
          : sql`false`
        : criteria.externalId !== undefined
          ? eq(users.externalId, criteria.externalId)
          : null;

    if (cible === null) {
      throw new NotFoundException("Indiquez le client, par son identifiant externe ou interne.");
    }

    const [compte] = await this.db
      .select({
        id: users.id,
        role: users.role,
        email: users.email,
        suspendedAt: users.suspendedAt,
      })
      .from(users)
      .where(cible)
      .limit(1);

    if (!compte) {
      // Message explicite : c'est l'erreur que fera tout intégrateur qui croit
      // que le panel crée le compte à la volée. Lui dire quoi faire ici épargne
      // une lecture de la documentation au moment où il est bloqué.
      throw new NotFoundException(AUCUN_COMPTE);
    }

    /*
     * **Pour une clé de revendeur, le périmètre d'abord.**
     *
     * Les refus qui suivent (compte suspendu, personnel, revendeur) disent
     * quelque chose du compte. Rendus avant le périmètre, ils apprenaient à
     * une clé qu'un compte qui n'est pas à elle existe, et qu'il est suspendu
     * ou qu'il appartient au personnel. Hors de son périmètre, elle ne reçoit
     * que le refus de l'absence ; le personnel et les revendeurs, qui ne sont
     * jamais les clients d'un revendeur, en sont hors par nature.
     */
    if (resellerId !== null) {
      if (compte.role !== "user") {
        throw new NotFoundException(AUCUN_COMPTE);
      }

      /*
       * Une clé de revendeur n'ouvre que les comptes **entièrement** à lui.
       *
       * Le rattachement se lit sur les serveurs — un compte n'appartient à
       * personne, ce sont ses serveurs qui relèvent d'un revendeur. Un compte
       * tout neuf, créé à la commande mais pas encore servi, n'est donc à
       * personne : la session lui sera ouverte au premier serveur livré. C'est
       * la bonne direction pour se tromper.
       *
       * Tous les serveurs, et non un seul : la session ouverte gère le compte
       * entier — serveurs chez un confrère ou à la plateforme, clés d'API,
       * clés SSH. Un seul serveur suffisait, et un revendeur entrait ainsi chez
       * le client partagé d'un autre (NC-01). C'est la règle que `origine`
       * applique déjà au choix du domaine ; un `reseller_id` nul (serveur resté
       * à la plateforme) compte comme un parc distinct.
       *
       * Le message reprend celui de l'absence : distinguer « pas à vous » de
       * « n'existe pas » apprendrait à un revendeur qui sont les clients des
       * autres.
       */
      const parcs = await this.db
        .selectDistinct({ resellerId: servers.resellerId })
        .from(servers)
        .where(eq(servers.ownerId, compte.id));

      /*
       * Le chemin en deux temps (donner un serveur à un compte qui n'est à
       * personne, puis demander sa session) est fermé à la création :
       * `requireRecipient` n'accepte qu'un compte que ce revendeur servait
       * déjà ou avait créé.
       */
      if (parcs.length !== 1 || parcs[0]?.resellerId !== resellerId) {
        throw new NotFoundException(AUCUN_COMPTE);
      }
    }

    /*
     * Un compte suspendu ne reçoit pas de lien.
     *
     * La session serait de toute façon refusée à la consommation
     * (`SessionIssuerService`) ; le dire dès l'émission épargne au facturier
     * de rediriger son client vers une page d'erreur, et lui donne une raison
     * lisible à afficher de son côté.
     */
    if (compte.suspendedAt !== null) {
      throw new ForbiddenException(
        "Ce compte est suspendu dans le panel : aucun lien de connexion n'est émis tant qu'il n'est pas réactivé.",
      );
    }

    if (PERSONNEL.has(compte.role)) {
      throw new ForbiddenException(
        "Ce compte appartient au personnel du panel : il ne se connecte pas depuis la facturation.",
      );
    }

    /*
     * Ni un compte revendeur, quelle que soit la clé.
     *
     * Sa session ouvre son espace de revendeur : ses clients, ses machines,
     * sa marque, ses clés. Une clé de confrère qui le sert entièrement
     * l'obtenait (tous ses serveurs chez elle), et une clé de plateforme
     * aussi. Comme pour le personnel, un revendeur se connecte par ses
     * propres moyens, second facteur compris.
     */
    if (compte.role === "reseller") {
      throw new ForbiddenException(
        "Ce compte est celui d'un revendeur : il ne se connecte pas depuis la facturation.",
      );
    }

    const emis = await this.tokens.issue(compte.id, "billing_sso", null);
    if (!emis) {
      // Le plafond horaire est atteint. 503 et non 429 : du point de vue du
      // plugin, le panel refuse temporairement de rendre un service, et le
      // geste à faire est de réessayer plus tard.
      throw new ServiceUnavailableException(
        "Trop de liens de connexion demandés pour ce compte dans l'heure. Réessayez plus tard.",
      );
    }

    return {
      url: `${await this.origine(compte.id)}/sso/${emis.token}`,
      expiresAt: emis.expiresAt,
    };
  }

  /**
   * Domaine sur lequel le client doit atterrir.
   *
   * **Jamais fourni par l'appelant.** Laisser le plugin choisir le domaine
   * ferait du panel une fabrique de liens : celui qui détient une clé
   * applicative pourrait envoyer un jeton valable vers un hôte qu'il contrôle,
   * et récolter des sessions ouvertes. Le domaine est une propriété du panel,
   * pas de la requête.
   *
   * Il n'est pas pour autant toujours celui de la plateforme. Le client d'un
   * revendeur doit arriver **chez son revendeur** : c'est le nom qu'il connaît,
   * la marque qu'il a payée, et le seul endroit où le cookie de session qu'on
   * vient de lui poser vaudra quelque chose — un cookie `__Host-` ne franchit
   * pas les domaines.
   *
   * Le rattachement se lit sur les **serveurs**, parce que c'est là qu'il vit :
   * un compte n'appartient à personne, ce sont ses serveurs qui appartiennent
   * à un revendeur. La règle est donc prudente : le domaine d'un revendeur
   * n'est employé que si **tous** les serveurs du client sont chez lui et que
   * son domaine est vérifié. Un client servi par deux revendeurs — cas rare,
   * mais possible — retombe sur la plateforme, faute d'une réponse qui ne
   * soit pas arbitraire.
   */
  private async origine(userId: string): Promise<string> {
    const chezRevendeur = await this.domaineDuRevendeur(userId);
    if (chezRevendeur !== null) return `https://${chezRevendeur}`;

    const domaine = (await this.settings.text("brand.domain")).trim();
    if (domaine === "") {
      throw new ServiceUnavailableException(
        "Le domaine de la plateforme n'est pas renseigné : impossible de fabriquer un lien de connexion. " +
          "Renseignez-le dans Réglages → Marque.",
      );
    }
    return `https://${domaine.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
  }

  /**
   * Le domaine vérifié du revendeur unique de ce client, s'il y en a un.
   *
   * `null` dès qu'il y a le moindre doute : aucun serveur, plusieurs
   * revendeurs, un serveur resté à la plateforme, ou un domaine que le
   * revendeur n'a pas encore prouvé posséder. Envoyer une session ouverte vers
   * un domaine non vérifié serait exactement ce que la vérification existe
   * pour empêcher.
   */
  private async domaineDuRevendeur(userId: string): Promise<string | null> {
    const parcs = await this.db
      .selectDistinct({ resellerId: servers.resellerId })
      .from(servers)
      .where(eq(servers.ownerId, userId));

    if (parcs.length !== 1) return null;

    const resellerId = parcs[0]?.resellerId;
    if (!resellerId) return null;

    const [marque] = await this.db
      .select({ domain: resellerBrandings.domain })
      .from(resellerBrandings)
      .where(
        and(
          eq(resellerBrandings.userId, resellerId),
          isNotNull(resellerBrandings.domainVerifiedAt),
          isNotNull(resellerBrandings.domain),
        ),
      )
      .limit(1);

    const domaine = marque?.domain?.trim() ?? "";
    return domaine === "" ? null : domaine;
  }

  /**
   * Consomme le lien et rend le compte à connecter.
   *
   * Ne pose pas la session lui-même : c'est `AuthController` qui le fait, pour
   * **tous** les chemins d'entrée. Un second endroit qui fabriquerait des
   * sessions finirait par oublier le cookie durci, la trace de dernière
   * connexion, ou la méthode d'authentification consignée.
   */
  async consume(token: string): Promise<{ userId: string } | null> {
    if (typeof token !== "string" || token.length < 16) return null;
    return this.tokens.consume(token, "billing_sso");
  }
}
