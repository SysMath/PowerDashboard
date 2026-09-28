import { hashPassword, provisionalPassword } from "@gamedashboard/auth";
import {
  allocations,
  backups,
  type Database,
  eggs,
  nodes,
  servers,
  users,
} from "@gamedashboard/db";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, count, eq, sql } from "drizzle-orm";
import { DATABASE } from "../../common/database.provider";
import { SessionRepository } from "../auth/session.repository";
import { S3Service } from "../storage/s3.service";
import { WebhookEmitterService } from "../webhooks/webhook-emitter.service";
import { WingsClientService, WingsUnavailableError } from "../wings/wings-client.service";
import { WingsTokenService } from "../wings/wings-token.service";
import { isAdminRole } from "./admin.guard";

/** Rôles attribuables. `owner` n'en est pas : il n'existe qu'à l'installation. */
const ASSIGNABLE_ROLES = new Set(["user", "support", "admin", "reseller"]);

@Injectable()
export class AdminActionsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(WingsClientService) private readonly wings: WingsClientService,
    @Inject(SessionRepository) private readonly sessions: SessionRepository,
    @Inject(WebhookEmitterService) private readonly webhooks: WebhookEmitterService,
    @Inject(WingsTokenService) private readonly tokens: WingsTokenService,
    @Inject(S3Service) private readonly s3: S3Service,
  ) {}

  /* --- Utilisateurs -------------------------------------------------------- */

  /**
   * Crée un compte depuis le panel.
   *
   * Deux façons d'y entrer, et le choix tient à ce qu'on a sous la main :
   *
   * - **mot de passe provisoire** : tiré au sort, rendu **une seule fois** à
   *   l'administrateur, qui le transmet. Il ne repasse jamais par le panel —
   *   seul son condensat est gardé.
   * - **connexion externe seule** : aucun mot de passe local. Le compte
   *   n'ouvre que par le fournisseur d'identité.
   *
   * L'adresse est marquée vérifiée dans le premier cas et pas dans le second,
   * et cette asymétrie est le sujet : un administrateur qui crée un compte et
   * en transmet le mot de passe **répond de l'adresse** ; un compte destiné à
   * une connexion externe attend que le fournisseur l'atteste, ce qu'il fait
   * lui-même à la première ouverture.
   *
   * Le panel n'envoie aucun courriel : il n'a pas de client SMTP, seulement des
   * réglages. Proposer ici un « envoyer un lien de vérification » créerait des
   * comptes que personne ne pourrait activer.
   */
  async createUser(input: {
    email: string;
    nameFirst: string;
    nameLast: string;
    role: string;
    withPassword: boolean;
  }): Promise<{ id: string; temporaryPassword: string | null }> {
    const email = input.email.trim().toLowerCase();
    // 254 caractères au plus (RFC 5321), vérifiés avant l'expression : sur une
    // chaîne d'un mégaoctet, elle tenait la boucle d'événements des minutes.
    if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new BadRequestException("Adresse e-mail invalide.");
    }

    const nameFirst = input.nameFirst.trim();
    const nameLast = input.nameLast.trim();
    if (nameFirst === "" || nameLast === "") {
      throw new BadRequestException("Nom et prénom sont obligatoires.");
    }

    if (!ASSIGNABLE_ROLES.has(input.role)) {
      throw new BadRequestException(`Rôle inconnu : « ${input.role} ».`);
    }

    // Vérification explicite plutôt que de laisser l'index unique parler : une
    // erreur SQL brute ne dit pas quoi faire à qui remplit un formulaire.
    const [taken] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`)
      .limit(1);
    if (taken) throw new ConflictException("Un compte existe déjà pour cette adresse.");

    /*
     * Le mot de passe est **tiré au sort**, jamais saisi.
     *
     * Un champ « mot de passe » dans un formulaire d'administration reçoit,
     * dans les faits, un secret que l'administrateur connaît déjà et réutilise.
     * Le tirer au sort garantit qu'il est unique à ce compte, et l'afficher une
     * seule fois rappelle qu'il est provisoire.
     *
     * Il porte la même échéance que celui des scripts (ASVS 2.3.1) : vingt-
     * quatre heures, après quoi la connexion et le SFTP le refusent ; avant,
     * la première connexion mène à la page où l'on en choisit un autre. Sans
     * échéance, le secret lu dans un courriel ou une messagerie restait le mot
     * de passe durable du compte.
     */
    const provisional = input.withPassword ? provisionalPassword() : null;
    const temporaryPassword = provisional?.password ?? null;

    const [created] = await this.db
      .insert(users)
      .values({
        email,
        passwordHash: temporaryPassword ? await hashPassword(temporaryPassword) : null,
        passwordExpiresAt: provisional?.expiresAt?.toISOString() ?? null,
        nameFirst,
        nameLast,
        role: input.role as "user" | "support" | "admin" | "reseller",
        emailVerifiedAt: temporaryPassword ? new Date().toISOString() : null,
      })
      .returning({ id: users.id });

    if (!created) throw new ConflictException("Le compte n'a pas pu être créé.");

    // À la plateforme : un compte tout neuf n'est à personne, exactement comme
    // pour `POST /application/users`. Il entrera dans le périmètre d'un
    // revendeur au premier serveur livré, pas avant.
    await this.webhooks.emit(
      "user.created",
      { userId: created.id, email, role: input.role },
      { reseller: null },
    );

    return { id: created.id, temporaryPassword };
  }

  /**
   * Change le rôle d'un compte.
   *
   * Un administrateur ne peut pas modifier **le sien**. Ce n'est pas de la
   * paternalisme : une plateforme dont le dernier administrateur se rétrograde
   * par mégarde n'a plus personne pour le remonter, et la réparation passe par
   * un accès direct à la base.
   */
  async setUserRole(
    actorId: string,
    userId: string,
    role: string,
  ): Promise<{ previous: string; email: string }> {
    if (!ASSIGNABLE_ROLES.has(role)) throw new BadRequestException(`Rôle inconnu : « ${role} ».`);
    if (actorId === userId) {
      throw new ConflictException("Vous ne pouvez pas modifier votre propre rôle.");
    }

    // Le rôle d'avant est rendu pour le journal : « devenu administrateur »
    // ne se lit pas pareil selon qu'il était client ou support.
    const [current] = await this.db
      .select({ role: users.role, email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!current) throw new NotFoundException("Compte introuvable.");

    const [updated] = await this.db
      .update(users)
      .set({ role: role as "user" | "support" | "admin", updatedAt: new Date().toISOString() })
      .where(eq(users.id, userId))
      .returning({ id: users.id });

    if (!updated) throw new NotFoundException("Compte introuvable.");
    return { previous: current.role, email: current.email };
  }

  /**
   * Ferme toutes les sessions d'un compte.
   *
   * Les lignes sont **révoquées**, pas supprimées : l'intéressé doit pouvoir
   * constater depuis son espace que ses appareils ont été déconnectés, et à
   * quel moment (§5.1).
   */
  async revokeUserSessions(userId: string): Promise<{ revoked: number }> {
    // Sans jeton courant : l'administrateur n'est pas la personne visée, il n'y
    // a donc aucune session à épargner. La révocation elle-même vit dans
    // `SessionRepository`, pour qu'il n'existe qu'une façon de fermer une
    // session — et donc qu'un seul endroit à relire le jour où « fermée »
    // voudra dire autre chose.
    return { revoked: await this.sessions.revokeOthers(userId) };
  }

  /**
   * Vérifie qu'un compte peut être pris en main, et rend de quoi le nommer.
   *
   * Deux refus, et ils ne se recouvrent pas :
   *
   * - **soi-même** : sans effet utile, et la session de retour pointerait vers
   *   celle qu'on vient de remplacer ;
   * - **un autre membre du personnel** : devenir un second administrateur
   *   contournerait toute séparation des rôles. Que la prise en main soit en
   *   lecture seule n'y change rien — lire l'espace d'administration d'un
   *   confrère, c'est déjà lire tout le parc sous son nom.
   */
  async impersonationTarget(
    actorId: string,
    userId: string,
  ): Promise<{ id: string; email: string }> {
    if (actorId === userId) {
      throw new BadRequestException("Vous êtes déjà sur votre propre compte.");
    }

    const [target] = await this.db
      .select({
        id: users.id,
        email: users.email,
        role: users.role,
        suspendedAt: users.suspendedAt,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!target) throw new NotFoundException("Compte inconnu.");
    // Un compte suspendu ne s'ouvre pas, pas même en lecture : la session
    // empruntée serait de toute façon refusée à la première requête, et
    // l'agent se retrouverait déconnecté des deux côtés.
    if (target.suspendedAt !== null) {
      throw new ConflictException(
        "Ce compte est suspendu : il ne peut pas être pris en main. Réactivez-le d'abord si le diagnostic l'exige.",
      );
    }
    if (isAdminRole(target.role)) {
      throw new ForbiddenException(
        "La prise en main ne vaut que pour un compte client : un membre du personnel ne se regarde pas depuis le compte d'un autre.",
      );
    }
    /*
     * Un revendeur non plus.
     *
     * Son compte gouverne le parc de ses clients : consentement au
     * provisionnement par la plateforme, clés de sa boutique, suppression de
     * serveurs. L'espace revendeur est désormais en lecture seule pendant une
     * prise en main, mais la lecture elle-même montre les clients d'un tiers
     * sous son nom ; l'administration voit déjà ce parc depuis `/admin`, sous
     * le sien.
     */
    if (target.role === "reseller") {
      throw new ForbiddenException(
        "La prise en main ne vaut que pour un compte client : le parc d'un revendeur se consulte depuis l'administration.",
      );
    }

    return { id: target.id, email: target.email };
  }

  /**
   * Supprime un compte.
   *
   * Refusé s'il possède des serveurs. La contrainte existe déjà en base
   * (`servers.owner_id` en `restrict`), mais elle produirait une erreur SQL
   * illisible ; la vérifier ici permet de dire combien de serveurs bloquent et
   * donc quoi faire — les transférer, ou les supprimer d'abord.
   */
  async deleteUser(actorId: string, userId: string): Promise<{ email: string }> {
    if (actorId === userId) {
      throw new ConflictException("Vous ne pouvez pas supprimer votre propre compte.");
    }

    const [owned] = await this.db
      .select({ n: count() })
      .from(servers)
      .where(eq(servers.ownerId, userId));

    if ((owned?.n ?? 0) > 0) {
      throw new ConflictException(
        `Ce compte possède ${owned?.n} serveur(s). Transférez-les ou supprimez-les d'abord.`,
      );
    }

    const [deleted] = await this.db
      .delete(users)
      .where(eq(users.id, userId))
      .returning({ id: users.id, email: users.email, externalId: users.externalId });

    if (!deleted) throw new NotFoundException("Compte introuvable.");

    // L'identifiant externe est rendu avec le rappel : c'est celui que le
    // système tiers reconnaît. Le nôtre ne lui sert à rien une fois la ligne
    // disparue.
    /*
     * À la plateforme, explicitement.
     *
     * Un compte n'appartient à personne, et celui-ci n'a plus aucun serveur —
     * la suppression l'exige. Il ne relève donc d'aucun revendeur, et le dire
     * ici évite que la déduction ait à trancher un cas qu'elle ne peut pas
     * connaître.
     */
    await this.webhooks.emit(
      "user.deleted",
      { userId: deleted.id, email: deleted.email, externalId: deleted.externalId },
      { reseller: null },
    );

    // Rendue pour le journal : une fois la ligne partie, l'identifiant seul
    // ne dirait plus à personne quel compte a été supprimé.
    return { email: deleted.email };
  }

  /* --- Serveurs ------------------------------------------------------------ */

  /**
   * Suspend ou rétablit un serveur.
   *
   * Le daemon est prévenu par une resynchronisation : c'est lui qui refuse
   * démarrage et console pour un serveur suspendu. Sans cet appel, la base
   * dirait « suspendu » pendant que le serveur continuerait de tourner.
   */
  async setServerSuspended(serverId: string, suspended: boolean, reason: string): Promise<void> {
    const [updated] = await this.db
      .update(servers)
      .set({
        state: suspended ? "suspended" : null,
        suspendedReason: suspended ? reason.trim() || "Suspendu par un administrateur." : null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(servers.id, serverId))
      .returning({ id: servers.id });

    if (!updated) throw new NotFoundException("Serveur introuvable.");

    // L'échec du daemon n'annule pas la décision : la base fait foi, et le
    // node relira sa configuration au démarrage suivant.
    await this.wings.syncServer(serverId).catch(() => undefined);

    // Les consoles ouvertes sont fermées avec la suspension : un jeton de
    // websocket vit dix minutes, et Wings ne relit pas l'état pour le
    // refuser en cours de route.
    if (suspended) {
      const jtis = this.tokens.revocableForServer(serverId);
      await this.wings.denyWebsocketTokens(serverId, jtis).catch(() => undefined);
    }

    /**
     * Le système tiers est prévenu, **y compris quand c'est lui qui a demandé**.
     *
     * Cela paraît redondant : il vient d'appeler la route, il connaît l'issue.
     * Mais la même suspension peut venir d'un administrateur depuis le panel,
     * et la boutique doit alors le savoir — sinon elle continue de facturer un
     * service coupé. Émettre à l'endroit où l'état change, et nulle part
     * ailleurs, est ce qui garantit qu'aucune origine n'est oubliée.
     */
    await this.webhooks.emit(suspended ? "server.suspended" : "server.resumed", {
      serverId,
      reason: suspended ? reason.trim() || null : null,
    });
  }

  /**
   * Supprime un serveur et son volume.
   *
   * Le daemon **d'abord** : effacer la ligne en premier ferait perdre les
   * coordonnées du node, et le volume resterait sur le disque sans que rien
   * n'y renvoie. Un node injoignable interrompt donc la suppression, à dessein.
   *
   * Le port revient au stock par la contrainte `set null` de la base ; on ne le
   * fait pas à la main pour ne pas avoir deux règles pour la même chose.
   */
  async deleteServer(serverId: string): Promise<{ name: string; ownerId: string }> {
    const [row] = await this.db
      .select({
        id: servers.id,
        ownerId: servers.ownerId,
        name: servers.name,
        resellerId: servers.resellerId,
      })
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);

    if (!row) throw new NotFoundException("Serveur introuvable.");

    /*
     * Un daemon qui ne connaît pas ce serveur n'empêche pas de le retirer.
     *
     * **Relevé en exploitation** : une création interrompue avant que le daemon
     * n'ait posé le conteneur laissait une ligne en base et un 404 côté node.
     * La suppression s'arrêtait là, et la ligne devenait ineffaçable — visible
     * dans toutes les listes, impossible à ouvrir, impossible à retirer.
     *
     * La distinction est entre « il dit que ça n'existe pas » et « il ne dit
     * rien ». Un 404 signifie qu'il n'y a rien à nettoyer de ce côté. Un node
     * injoignable, au contraire, fait refuser : supprimer la ligne laisserait
     * un conteneur tourner sur une machine sans que rien ne le rattache plus à
     * personne — ni pour l'arrêter, ni pour le facturer.
     */
    try {
      await this.wings.deleteServer(serverId);
    } catch (error) {
      if (!(error instanceof WingsUnavailableError && error.isNotFound)) throw error;
    }

    /*
     * Les archives déposées sur le compartiment partent avec le serveur.
     *
     * La base oublie ses sauvegardes en cascade, et le daemon ne connaît que
     * son disque : sans ce passage, elles resteraient facturées sans plus
     * apparaître nulle part. Un échec du compartiment est journalisé par
     * `S3Service` sans arrêter la suppression — le serveur n'existe déjà plus
     * sur le node.
     */
    const distantes = await this.db
      .select({ id: backups.id, uploadId: backups.uploadId })
      .from(backups)
      .where(and(eq(backups.serverId, serverId), eq(backups.disk, "s3")));
    for (const sauvegarde of distantes) {
      await this.s3.discard(await this.s3.keyFor(serverId, sauvegarde.id), sauvegarde.uploadId);
    }

    await this.db.delete(servers).where(eq(servers.id, serverId));

    // Le propriétaire est relevé **avant** la suppression : après, la ligne
    // n'existe plus, et le rappel ne dirait pas à qui appartenait le serveur —
    // soit la seule information dont la boutique a besoin pour clore la
    // facturation.
    //
    // Le revendeur est relevé là aussi, et pour la même raison : c'est lui qui
    // décide à qui ce rappel part. Le déduire après coup rendrait « à la
    // plateforme », et la boutique qui a vendu le serveur n'apprendrait jamais
    // sa résiliation — l'événement dont elle a le plus besoin.
    await this.webhooks.emit(
      "server.deleted",
      { serverId, ownerId: row.ownerId, name: row.name },
      { reseller: row.resellerId },
    );

    // Rendus pour le journal de qui supprime : la ligne n'existe plus, et le
    // journal ne peut plus s'y rattacher.
    return { name: row.name, ownerId: row.ownerId };
  }

  /* --- Nodes --------------------------------------------------------------- */

  /**
   * Bascule la maintenance d'un node.
   *
   * Un node en maintenance n'accueille plus de nouveau serveur — voir
   * `CatalogueService.pickNode` — mais **continue de faire tourner** les
   * siens. C'est la nuance qui rend le bouton utilisable : il prépare une
   * intervention sans couper les clients.
   */
  async setNodeMaintenance(nodeId: string, enabled: boolean): Promise<void> {
    const [updated] = await this.db
      .update(nodes)
      .set({ maintenanceMode: enabled, updatedAt: new Date().toISOString() })
      .where(eq(nodes.id, nodeId))
      .returning({ id: nodes.id });

    if (!updated) throw new NotFoundException("Node introuvable.");
  }

  /**
   * Attribue un node à un revendeur, ou le rend à la plateforme.
   *
   * C'est l'autorisation qui va dans l'autre sens : le revendeur décide si
   * l'administration peut provisionner chez lui, l'administration décide quelles
   * machines il exploite. Les deux sont nécessaires et aucune n'implique
   * l'autre.
   *
   * `null` ramène le node à la plateforme. Ce n'est pas « aucun propriétaire »
   * mais « la plateforme », qui est le cas de la grande majorité des nodes.
   */
  async setNodeOwner(nodeId: string, ownerId: string | null): Promise<void> {
    if (ownerId !== null) {
      const [target] = await this.db
        .select({ id: users.id, role: users.role })
        .from(users)
        .where(eq(users.id, ownerId))
        .limit(1);

      if (!target) throw new BadRequestException("Compte destinataire inconnu.");

      /**
       * Seul un revendeur peut posséder un node.
       *
       * Attribuer une machine à un client ordinaire lui donnerait de la
       * capacité sans lui ouvrir l'espace qui permet de la voir : le node
       * disparaîtrait de l'administration sans apparaître nulle part ailleurs.
       */
      if (target.role !== "reseller") {
        throw new ConflictException(
          "Seul un compte revendeur peut exploiter un node. Changez d'abord son rôle.",
        );
      }
    }

    const [updated] = await this.db
      .update(nodes)
      .set({ ownerId, updatedAt: new Date().toISOString() })
      .where(eq(nodes.id, nodeId))
      .returning({ id: nodes.id });

    if (!updated) throw new NotFoundException("Node introuvable.");
  }

  /* --- Eggs ---------------------------------------------------------------- */

  /**
   * Active ou désactive un egg.
   *
   * L'activation est l'acte par lequel un administrateur déclare avoir relu le
   * script d'installation (§8.3) : celui-ci s'exécute sur le node, et un egg
   * importé d'un dépôt public n'a été relu par personne tant que ce bouton n'a
   * pas été pressé.
   *
   * La désactivation ne touche pas aux serveurs existants : ils continuent de
   * fonctionner. Elle retire seulement l'egg de l'assistant de création.
   */
  async setEggEnabled(eggId: string, enabled: boolean): Promise<{ affectedServers: number }> {
    const [updated] = await this.db
      .update(eggs)
      .set({ enabled, updatedAt: new Date().toISOString() })
      .where(eq(eggs.id, eggId))
      .returning({ id: eggs.id });

    if (!updated) throw new NotFoundException("Egg introuvable.");

    const [affected] = await this.db
      .select({ n: count() })
      .from(servers)
      .where(eq(servers.eggId, eggId));

    return { affectedServers: affected?.n ?? 0 };
  }

  /* --- Ports --------------------------------------------------------------- */

  /**
   * Ajoute des ports au stock d'un node.
   *
   * Sans stock, aucun serveur ne peut être créé : c'est la première chose à
   * faire après avoir déclaré un node, et l'oublier donne un « aucun node
   * disponible » que rien n'explique.
   */
  async addAllocations(
    nodeId: string,
    ip: string,
    ports: number[],
  ): Promise<{ added: number; skipped: number }> {
    if (!/^[0-9a-fA-F:.]{3,45}$/.test(ip)) throw new BadRequestException("Adresse IP invalide.");

    const valid = [...new Set(ports)].filter(
      (port) => Number.isInteger(port) && port >= 1024 && port <= 65_535,
    );
    if (valid.length === 0) {
      // Sous 1024, un port demande des privilèges que le conteneur n'a pas :
      // l'accepter donnerait un serveur qui refuse de démarrer sans raison
      // visible depuis le panel.
      throw new BadRequestException("Aucun port exploitable (1024–65535 attendus).");
    }

    const [node] = await this.db
      .select({ id: nodes.id })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .limit(1);
    if (!node) throw new NotFoundException("Node introuvable.");

    // `onConflictDoNothing` plutôt qu'une vérification préalable : l'unicité
    // (node, ip, port) appartient à la base, et deux ajouts simultanés
    // passeraient tous deux une vérification faite en amont.
    const inserted = await this.db
      .insert(allocations)
      .values(valid.map((port) => ({ nodeId, ip, port })))
      .onConflictDoNothing()
      .returning({ id: allocations.id });

    return { added: inserted.length, skipped: valid.length - inserted.length };
  }
}
