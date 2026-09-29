import { SERVER_PERMISSIONS, type ServerPermission } from "@gamedashboard/contracts";
import { type Database, serverSubusers, servers, users } from "@gamedashboard/db";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { DATABASE } from "../../common/database.provider";
import { NotificationsService } from "../notifications/notifications.service";
import { closeSessions } from "../wings/close-sessions";
import { WingsClientService } from "../wings/wings-client.service";
import { WingsTokenService } from "../wings/wings-token.service";
import { type ServerInvite, ServerInvitesService } from "./server-invites.service";

/**
 * Seconde vue de `users`, pour nommer celui qui invite sans se confondre avec
 * l'invité — les deux sont des comptes, et la même table les porte.
 */
const inviter = alias(users, "inviter");

/** Invitation qu'un compte n'a pas encore tranchée. */
export interface PendingInvitation {
  serverId: string;
  serverName: string;
  permissions: string[];
  invitedAt: string;
  /** Adresse de qui a invité. Vide si ce compte a été supprimé depuis. */
  invitedBy: string;
}

export interface ClientSubuser {
  id: string;
  userId: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  permissions: string[];
  acceptedAt: string | null;
  createdAt: string;
}

/**
 * Personnes ayant accès à un serveur sans en être propriétaires.
 *
 * C'est le module qui distribue du pouvoir, et il en distribue à des gens que
 * le propriétaire ne contrôle pas. Deux règles le gouvernent, appliquées ici et
 * pas dans l'interface : on ne peut accorder que ce qu'on possède, et retirer
 * un accès doit aussi fermer les portes déjà ouvertes.
 */
@Injectable()
export class SubusersService {
  private readonly logger = new Logger(SubusersService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(WingsClientService) private readonly wings: WingsClientService,
    @Inject(WingsTokenService) private readonly tokens: WingsTokenService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Inject(ServerInvitesService) private readonly invites: ServerInvitesService,
  ) {}

  async list(serverId: string): Promise<ClientSubuser[]> {
    const rows = await this.db
      .select({
        id: serverSubusers.id,
        userId: users.id,
        nameFirst: users.nameFirst,
        nameLast: users.nameLast,
        email: users.email,
        avatarUrl: users.avatarUrl,
        permissions: serverSubusers.permissions,
        acceptedAt: serverSubusers.acceptedAt,
        createdAt: serverSubusers.createdAt,
      })
      .from(serverSubusers)
      .innerJoin(users, eq(serverSubusers.userId, users.id))
      .where(eq(serverSubusers.serverId, serverId));

    return rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      name: `${row.nameFirst} ${row.nameLast}`.trim(),
      email: row.email,
      avatarUrl: row.avatarUrl,
      permissions: row.permissions,
      acceptedAt: row.acceptedAt,
      createdAt: row.createdAt,
    }));
  }

  /**
   * Invite quelqu'un.
   *
   * Deux chemins, selon que l'adresse porte déjà un compte ou non.
   *
   * **Compte existant** : l'accès est créé en attente, la personne le voit dans
   * sa liste et l'accepte. Sans cette étape, n'importe qui ferait apparaître un
   * serveur inconnu chez un tiers.
   *
   * **Adresse inconnue** : un lien part par courriel, et c'est lui qui fait
   * foi. Ce cas était refusé jusqu'ici, faute de jeton, d'envoi et de page
   * d'acceptation ; ils existent désormais, et la règle qui justifiait le refus
   * reste appliquée là où elle compte — sans serveur d'envoi configuré, le
   * refus revient, parce qu'une invitation qui ne part pas est une ligne « en
   * attente » éternelle.
   *
   * Le filtrage des permissions a lieu **avant** l'aiguillage : ce qu'on ne
   * peut pas accorder à un compte existant, on ne peut pas non plus le promettre
   * dans un courriel.
   */
  async invite(
    serverId: string,
    actorId: string,
    email: string,
    permissions: string[],
    host: string | null = null,
  ): Promise<ClientSubuser | { pendingInvite: ServerInvite }> {
    const granted = await this.grantable(serverId, actorId, permissions);

    const [invitee] = await this.db
      .select({ id: users.id, nameFirst: users.nameFirst, nameLast: users.nameLast })
      .from(users)
      .where(sql`lower(${users.email}) = lower(${email.trim()})`)
      .limit(1);

    if (!invitee) {
      const { invite } = await this.invites.create(serverId, actorId, email, granted, host);
      return { pendingInvite: invite };
    }

    const [owner] = await this.db
      .select({ ownerId: servers.ownerId })
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);

    // Le propriétaire a déjà tout : en faire un sous-utilisateur créerait deux
    // sources de droits pour la même personne, dont l'une pourrait le restreindre.
    if (owner?.ownerId === invitee.id) {
      throw new ConflictException("Cette personne est propriétaire du serveur.");
    }

    const [row] = await this.db
      .insert(serverSubusers)
      .values({ serverId, userId: invitee.id, permissions: granted, invitedBy: actorId })
      .onConflictDoNothing()
      .returning();

    if (!row) throw new ConflictException("Cette personne a déjà accès à ce serveur.");

    const [created] = await this.list(serverId).then((all) => all.filter((s) => s.id === row.id));
    if (!created) throw new NotFoundException("Accès introuvable.");

    /*
     * L'invité est prévenu, sinon l'invitation attend qu'il passe par hasard.
     *
     * Le cas ordinaire est quelqu'un qui n'a **aucun** serveur chez nous : il
     * n'ouvre pas le panel de lui-même, et une invitation muette resterait en
     * attente jusqu'à ce que le propriétaire demande pourquoi.
     */
    const [target] = await this.db
      .select({ name: servers.name })
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);

    await this.notifications.notify({
      userId: invitee.id,
      type: "subuser.invited",
      level: "info",
      title: "Invitation à gérer un serveur",
      body: `On vous propose l'accès au serveur « ${target?.name ?? "?"} ». Acceptez-la depuis la liste de vos serveurs.`,
      serverId,
    });

    return created;
  }

  /**
   * Invitations qu'un compte n'a pas encore tranchées.
   *
   * **C'est la moitié qui manquait.** Une invitation naissait en attente,
   * quatre endroits exigeaient `accepted_at is not null` pour accorder quoi que
   * ce soit, et rien au monde ne remplissait cette colonne : l'invité ne voyait
   * jamais le serveur, ne pouvait pas accepter, et le propriétaire le voyait
   * « en attente » indéfiniment. La délégation d'accès ne marchait pas du tout.
   */
  async pendingFor(userId: string): Promise<PendingInvitation[]> {
    return this.db
      .select({
        serverId: serverSubusers.serverId,
        serverName: servers.name,
        permissions: serverSubusers.permissions,
        invitedAt: serverSubusers.createdAt,
        // Qui invite : sans ce nom, on accepte un accès demandé par un inconnu.
        invitedBy: sql<string>`coalesce(${inviter.email}, '')`,
      })
      .from(serverSubusers)
      .innerJoin(servers, eq(servers.id, serverSubusers.serverId))
      .leftJoin(inviter, eq(inviter.id, serverSubusers.invitedBy))
      .where(and(eq(serverSubusers.userId, userId), isNull(serverSubusers.acceptedAt)));
  }

  /**
   * Accepte une invitation.
   *
   * Les deux conditions sont **dans la requête** : c'est bien son invitation, et
   * elle est bien en attente. Lire puis écrire laisserait une fenêtre où deux
   * acceptations concurrentes passeraient toutes les deux, et où une invitation
   * retirée entre-temps serait tout de même acceptée.
   */
  async accept(userId: string, serverId: string): Promise<void> {
    const accepted = await this.db
      .update(serverSubusers)
      .set({ acceptedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(serverSubusers.userId, userId),
          eq(serverSubusers.serverId, serverId),
          isNull(serverSubusers.acceptedAt),
        ),
      )
      .returning({ id: serverSubusers.id });

    if (accepted.length === 0) throw new NotFoundException("Invitation introuvable.");
  }

  /**
   * Refuse une invitation : la ligne part.
   *
   * Effacée plutôt que marquée refusée. Garder la trace d'un refus dirait au
   * propriétaire « cette personne ne veut pas », ce qui ne le regarde pas — et
   * l'empêcherait de réinviter après un accord verbal.
   */
  async decline(userId: string, serverId: string): Promise<void> {
    const removed = await this.db
      .delete(serverSubusers)
      .where(
        and(
          eq(serverSubusers.userId, userId),
          eq(serverSubusers.serverId, serverId),
          // Seulement en attente : un accès déjà accepté se retire depuis
          // l'écran du serveur, et passer par ici contournerait ce chemin.
          isNull(serverSubusers.acceptedAt),
        ),
      )
      .returning({ id: serverSubusers.id });

    if (removed.length === 0) throw new NotFoundException("Invitation introuvable.");
  }

  /**
   * Redéfinit les permissions d'un sous-utilisateur.
   *
   * Les jetons de console déjà remis sont révoqués : ils portent les anciennes
   * permissions, scellées à l'émission, et resteraient valables dix minutes.
   * Retirer le droit d'envoyer des commandes sans cela laisserait la personne
   * en envoyer pendant tout ce temps.
   */
  async update(
    serverId: string,
    actorId: string,
    subuserId: string,
    permissions: string[],
  ): Promise<ClientSubuser> {
    const granted = await this.grantable(serverId, actorId, permissions);
    const existing = await this.mustFind(serverId, subuserId);

    await this.db
      .update(serverSubusers)
      // Le preset d'origine est effacé : la liste écrite fait foi seule, et
      // plus rien ne peut y replier.
      .set({ permissions: granted, rolePreset: null, updatedAt: new Date().toISOString() })
      .where(eq(serverSubusers.id, subuserId));

    await this.revoke(serverId, existing.userId);

    const updated = await this.list(serverId).then((all) => all.find((s) => s.id === subuserId));
    if (!updated) throw new NotFoundException("Accès introuvable.");
    return updated;
  }

  /**
   * Retire l'accès, et ferme ce que la personne tient encore ouvert.
   *
   * Les consoles, par la révocation de ses jetons. **Sa session SFTP aussi**,
   * par `deauthorizeUser` : la base refuse désormais toute connexion, mais un
   * client SFTP déjà connecté gardait les fichiers du serveur jusqu'à ce
   * qu'il se déconnecte de lui-même.
   *
   * Un node qui ne répond pas n'empêche pas le retrait : la réponse dit
   * seulement que la session n'a pas pu être fermée.
   */
  async remove(serverId: string, subuserId: string): Promise<{ sessionClosed: boolean }> {
    const existing = await this.mustFind(serverId, subuserId);
    await this.db.delete(serverSubusers).where(eq(serverSubusers.id, subuserId));
    await this.revoke(serverId, existing.userId);
    const restes = await closeSessions(
      this.wings,
      serverId,
      [existing.userId],
      this.logger,
      "Retrait d'un sous-utilisateur",
    );
    return { sessionClosed: restes.length === 0 };
  }

  /**
   * Filtre les permissions demandées par celles que l'auteur possède.
   *
   * Sans cette règle, un sous-utilisateur ayant `subusers.create` pourrait
   * s'inviter un second compte avec tous les droits, puis s'y connecter : la
   * permission de gérer les accès deviendrait la permission de tout faire.
   *
   * Le propriétaire n'est pas concerné — il possède déjà tout, et se restreindre
   * lui-même n'aurait pas de sens.
   *
   * Un refus explicite plutôt qu'un silence : retirer discrètement les
   * permissions excédentaires laisserait l'auteur croire qu'il les a accordées.
   */
  private async grantable(
    serverId: string,
    actorId: string,
    requested: string[],
  ): Promise<string[]> {
    const unknown = requested.filter((p) => !SERVER_PERMISSIONS.includes(p as ServerPermission));
    if (unknown.length > 0) {
      throw new BadRequestException(`Permission inconnue : ${unknown.join(", ")}.`);
    }
    // Une liste vide n'est pas « aucun droit » : les lignes anciennes
    // retombent alors sur leur preset, qui peut être plus large que ce que
    // l'auteur détient. Un accès sans permission se retire, il ne se vide pas.
    if (requested.length === 0) {
      throw new BadRequestException("Choisissez au moins une permission, ou retirez l'accès.");
    }

    const [owner] = await this.db
      .select({ ownerId: servers.ownerId })
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);
    if (!owner) throw new NotFoundException("Serveur introuvable.");
    if (owner.ownerId === actorId) return [...new Set(requested)];

    const [actor] = await this.db
      .select({ permissions: serverSubusers.permissions })
      .from(serverSubusers)
      .where(and(eq(serverSubusers.serverId, serverId), eq(serverSubusers.userId, actorId)))
      .limit(1);

    const held = actor?.permissions ?? [];
    const excess = requested.filter((p) => !held.includes(p));
    if (excess.length > 0) {
      throw new ForbiddenException(
        `Vous ne pouvez pas accorder une permission que vous n'avez pas : ${excess.join(", ")}.`,
      );
    }
    return [...new Set(requested)];
  }

  /** Révoque auprès du daemon, sans faire échouer le retrait s'il ne répond pas. */
  private async revoke(serverId: string, userId: string): Promise<void> {
    const jtis = this.tokens.revocableFor(serverId, userId);
    // L'accès est retiré en base quoi qu'il arrive : remonter l'échec du daemon
    // laisserait l'appelant croire que la personne a toujours accès, alors
    // qu'elle ne peut déjà plus rien rouvrir.
    await this.wings.denyWebsocketTokens(serverId, jtis).catch(() => undefined);
  }

  private async mustFind(serverId: string, subuserId: string) {
    const [row] = await this.db
      .select({ id: serverSubusers.id, userId: serverSubusers.userId })
      .from(serverSubusers)
      .where(and(eq(serverSubusers.id, subuserId), eq(serverSubusers.serverId, serverId)))
      .limit(1);

    if (!row) throw new NotFoundException("Accès introuvable.");
    return row;
  }
}
