import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mailSender } from "@gamedashboard/contracts";
import { type Database, serverInvites, serverSubusers, servers, users } from "@gamedashboard/db";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { DATABASE } from "../../common/database.provider";
import { PlatformSettingsService } from "../admin/platform-settings.service";
import { MailerService } from "../mail/mailer.service";
import { BrandingService } from "../reseller/branding.service";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Inviter quelqu'un qui n'a pas encore de compte.
 *
 * C'était la moitié manquante de la délégation d'accès. Jusqu'ici, inviter une
 * adresse inconnue était **refusé** — et le refus était honnête, le code le
 * disait : « cela exige un jeton, un envoi et une page d'acceptation qui
 * n'existent pas encore ». La table `server_invites` les attendait depuis le
 * premier jour, avec son condensat de jeton et sa date d'expiration, sans
 * qu'une seule ligne de code ne l'écrive.
 *
 * En pratique, le propriétaire devait dire à son ami « crée un compte, puis
 * redonne-moi ton adresse » — deux allers-retours pour une chose qui tient en
 * un lien.
 *
 * **Le courrier est la seule preuve d'identité ici.** Personne ne s'authentifie
 * avant de cliquer : l'invitation vaut parce qu'elle est arrivée dans une boîte
 * dont on a démontré la possession. Tout le reste en découle — le jeton est
 * long et aléatoire, il n'est gardé que condensé, il ne sert qu'une fois, il
 * expire, et l'acceptation exige que la session porte **cette** adresse.
 */

/**
 * Durée de validité d'un lien.
 *
 * Sept jours : assez pour traverser une semaine chargée, assez court pour
 * qu'une boîte compromise des mois plus tard ne donne pas accès à un serveur.
 * Au-delà, le propriétaire réinvite — c'est un clic.
 */
const VALIDITE_MS = 7 * 24 * 60 * 60_000;

/** Nombre d'invitations simultanées pour un même serveur. */
const PLAFOND = 25;

export interface ServerInvite {
  id: string;
  email: string;
  permissions: string[];
  expiresAt: string;
  createdAt: string;
  /** Adresse de qui a invité. Vide si ce compte a disparu depuis. */
  invitedBy: string;
}

/** Ce qu'une personne non connectée peut apprendre en ouvrant son lien. */
export interface InvitePreview {
  serverName: string;
  email: string;
  permissions: string[];
  expiresAt: string;
  invitedBy: string;
  /** Un compte porte-t-il déjà cette adresse ? Décide du bouton à proposer. */
  accountExists: boolean;
}

const inviter = alias(users, "inviter");

@Injectable()
export class ServerInvitesService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(MailerService) private readonly mail: MailerService,
    @Inject(PlatformSettingsService) private readonly settings: PlatformSettingsService,
    @Inject(BrandingService) private readonly branding: BrandingService,
  ) {}

  /**
   * Émet une invitation et l'envoie.
   *
   * **L'envoi conditionne l'enregistrement.** Sans SMTP, la ligne serait une
   * invitation que personne ne pourrait jamais accepter : le propriétaire la
   * verrait « en attente » pour l'éternité et croirait le message parti. Le
   * refus est explicite et dit quoi faire — c'est le même raisonnement qui
   * faisait jusqu'ici refuser toute adresse inconnue.
   *
   * Les permissions arrivent **déjà filtrées** par l'appelant, qui seul sait ce
   * que l'auteur détient. Les refiltrer ici dupliquerait la règle à deux
   * endroits, et c'est toujours la copie oubliée qui devient fausse.
   */
  async create(
    serverId: string,
    actorId: string,
    email: string,
    permissions: string[],
    host: string | null,
  ): Promise<{ invite: ServerInvite; sentTo: string }> {
    const adresse = email.trim().toLowerCase();

    if (!(await this.mail.isConfigured())) {
      throw new BadRequestException(
        "Aucun serveur d'envoi n'est configuré : une invitation par courriel ne pourrait pas partir. " +
          "Demandez à la personne de créer un compte, puis invitez son adresse.",
      );
    }

    // Une adresse déjà titulaire d'un compte ne passe pas par ici : elle a un
    // chemin plus court, qui ne fait pas transiter de pouvoir par un courriel.
    const [existant] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${adresse}`)
      .limit(1);
    if (existant) {
      throw new ConflictException("Cette adresse a déjà un compte : invitez-la directement.");
    }

    const enAttente = await this.listFor(serverId);
    if (enAttente.some((i) => i.email === adresse)) {
      throw new ConflictException("Une invitation est déjà en cours pour cette adresse.");
    }
    // Le plafond n'est pas une limite de confort : sans lui, un accès
    // `subusers.create` devient un moyen d'expédier du courrier en masse depuis
    // un domaine de confiance, et c'est la réputation d'envoi du panel qui part.
    if (enAttente.length >= PLAFOND) {
      throw new ConflictException(
        `Ce serveur a déjà ${PLAFOND} invitations en attente. Retirez-en avant d'en émettre d'autres.`,
      );
    }

    const [cible] = await this.db
      .select({ name: servers.name })
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);
    if (!cible) throw new NotFoundException("Serveur introuvable.");

    const [auteur] = await this.db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, actorId))
      .limit(1);

    const jeton = randomBytes(32).toString("base64url");
    const now = new Date();
    const [row] = await this.db
      .insert(serverInvites)
      .values({
        serverId,
        email: adresse,
        // Comme les sessions et les jetons de courrier : la base ne garde que
        // le condensat. Une copie de sauvegarde qui fuite ne remet alors aucun
        // lien utilisable entre les mains de qui la lit.
        tokenHash: condensat(jeton),
        permissions,
        invitedBy: actorId,
        expiresAt: new Date(now.getTime() + VALIDITE_MS).toISOString(),
      })
      .returning({ id: serverInvites.id, createdAt: serverInvites.createdAt });

    if (!row) throw new ConflictException("L'invitation n'a pas pu être créée.");

    const marque = await this.branding.forHost(host);
    const lien = `${await this.origine(host)}/invitation/${jeton}`;
    const { ok, error } = await this.mail.sendAndReport({
      to: adresse,
      ...mailSender(marque),
      subject: `Invitation à gérer le serveur « ${cible.name} » sur ${marque.name}`,
      text: [
        `${auteur?.email ?? "Un utilisateur"} vous propose l'accès au serveur « ${cible.name} ».`,
        "",
        "Ouvrez ce lien pour voir ce qui vous est proposé et décider :",
        lien,
        "",
        "Le lien est valable sept jours et ne sert qu'une fois. Vous devrez créer",
        "un compte avec cette adresse, ou vous y connecter, avant d'accepter.",
        "",
        "Si vous ne connaissez pas l'expéditeur, ignorez ce message : sans action",
        "de votre part, rien ne vous sera attribué.",
        "",
      ].join("\n"),
    });

    if (!ok) {
      // La ligne est retirée : la garder ferait exactement ce qu'on voulait
      // éviter, une invitation « en attente » dont le lien n'est arrivé nulle
      // part. Le jeton n'ayant jamais quitté le panel, rien n'est perdu.
      await this.db.delete(serverInvites).where(eq(serverInvites.id, row.id));
      throw new BadRequestException(`L'invitation n'a pas pu être envoyée : ${error}`);
    }

    return {
      invite: {
        id: row.id,
        email: adresse,
        permissions,
        expiresAt: new Date(now.getTime() + VALIDITE_MS).toISOString(),
        createdAt: row.createdAt,
        invitedBy: auteur?.email ?? "",
      },
      sentTo: adresse,
    };
  }

  /** Invitations en cours : ni acceptées, ni périmées. */
  async listFor(serverId: string): Promise<ServerInvite[]> {
    const rows = await this.db
      .select({
        id: serverInvites.id,
        email: serverInvites.email,
        permissions: serverInvites.permissions,
        expiresAt: serverInvites.expiresAt,
        createdAt: serverInvites.createdAt,
        invitedBy: sql<string>`coalesce(${inviter.email}, '')`,
      })
      .from(serverInvites)
      .leftJoin(inviter, eq(inviter.id, serverInvites.invitedBy))
      .where(
        and(
          eq(serverInvites.serverId, serverId),
          isNull(serverInvites.acceptedAt),
          // Les périmées ne sont pas listées : elles n'ouvrent plus rien, et
          // les afficher ferait attendre une réponse qui ne viendra pas.
          gt(serverInvites.expiresAt, new Date().toISOString()),
        ),
      );

    return rows.map((row) => ({ ...row, permissions: row.permissions as string[] }));
  }

  /** Annule une invitation. Le lien déjà parti cesse aussitôt de valoir. */
  async revoke(serverId: string, inviteId: string): Promise<void> {
    const removed = await this.db
      .delete(serverInvites)
      .where(and(eq(serverInvites.id, inviteId), eq(serverInvites.serverId, serverId)))
      .returning({ id: serverInvites.id });

    if (removed.length === 0) throw new NotFoundException("Invitation introuvable.");
  }

  /**
   * Ce que montre le lien, avant toute connexion.
   *
   * Nom du serveur, auteur, droits proposés : de quoi décider. C'est plus que
   * ce qu'une route publique dit d'ordinaire, et c'est assumé — le jeton est un
   * secret de trente-deux octets qui n'a été envoyé qu'à une seule boîte, et
   * demander de créer un compte avant de savoir à quoi il donne accès serait
   * exiger un engagement à l'aveugle.
   */
  async preview(token: string): Promise<InvitePreview> {
    const invite = await this.valide(token);

    const [cible] = await this.db
      .select({ name: servers.name })
      .from(servers)
      .where(eq(servers.id, invite.serverId))
      .limit(1);
    if (!cible) throw new GoneException("Ce serveur n'existe plus.");

    const [auteur] = await this.db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, invite.invitedBy ?? ""))
      .limit(1);

    const [compte] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${invite.email}`)
      .limit(1);

    return {
      serverName: cible.name,
      email: invite.email,
      permissions: invite.permissions as string[],
      expiresAt: invite.expiresAt,
      invitedBy: auteur?.email ?? "",
      accountExists: Boolean(compte),
    };
  }

  /**
   * Transforme l'invitation en accès.
   *
   * Trois contrôles, dont aucun n'est redondant :
   *
   * 1. la session porte **l'adresse invitée** — sans quoi le lien, une fois
   *    transféré, donnerait l'accès à n'importe quel compte connecté ;
   * 2. l'auteur détient **encore** ce qu'il a promis — les permissions ont été
   *    scellées à l'émission, et un lien valable sept jours survivrait sinon au
   *    retrait des droits de celui qui l'a émis ;
   * 3. l'invitation n'a pas déjà servi, ce que garantit la condition portée
   *    dans la requête de mise à jour plutôt que dans une lecture préalable.
   *
   * L'accès naît **accepté**, contrairement à celui d'un compte existant : la
   * personne vient précisément de dire oui. Le passage par « en attente »
   * n'existe que pour ne pas faire apparaître un serveur inconnu dans la liste
   * de quelqu'un qui n'a rien demandé.
   */
  async accept(token: string, userId: string, userEmail: string): Promise<{ serverId: string }> {
    const invite = await this.valide(token);

    if (userEmail.trim().toLowerCase() !== invite.email) {
      throw new ForbiddenException(
        `Cette invitation vise ${invite.email}. Connectez-vous avec cette adresse pour l'accepter.`,
      );
    }

    /*
     * Tout se joue sous le verrou de la ligne du serveur, celui que prend le
     * changement de titulaire (`AdminServerService.setOwner`). Sans lui, une
     * invitation de l'ancien titulaire acceptée pendant le transfert passait
     * entre la lecture du titulaire et le retrait des invités : le compte
     * invité gardait l'accès au serveur du nouveau. Avec lui, soit
     * l'acceptation passe avant et le transfert la retire, soit le transfert
     * passe avant et l'invitation n'existe plus.
     */
    return this.db.transaction(async (tx) => {
      const [cible] = await tx
        .select({ ownerId: servers.ownerId })
        .from(servers)
        .where(eq(servers.id, invite.serverId))
        .for("share")
        .limit(1);
      if (!cible) throw new GoneException("Ce serveur n'existe plus.");
      if (cible.ownerId === userId) {
        throw new ConflictException("Vous êtes déjà propriétaire de ce serveur.");
      }

      await this.auteurDetientEncore(invite, cible.ownerId, tx);

      // L'invitation est consommée **avant** l'octroi : si l'insertion échoue,
      // un lien inutilisable vaut mieux qu'un lien rejouable.
      const consumed = await tx
        .update(serverInvites)
        .set({ acceptedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
        .where(and(eq(serverInvites.id, invite.id), isNull(serverInvites.acceptedAt)))
        .returning({ id: serverInvites.id });
      if (consumed.length === 0) throw new GoneException("Cette invitation a déjà été employée.");

      const now = new Date().toISOString();
      await tx
        .insert(serverSubusers)
        .values({
          serverId: invite.serverId,
          userId,
          permissions: invite.permissions as string[],
          invitedBy: invite.invitedBy,
          acceptedAt: now,
        })
        .onConflictDoNothing();

      // Pas d'erreur si la personne avait déjà accès : le résultat voulu est
      // atteint, et « conflit » après avoir consommé le lien laisserait croire
      // que l'invitation a échoué.
      return { serverId: invite.serverId };
    });
  }

  /**
   * L'invitation, sans la consommer, pour qui doit d'abord créer son compte.
   *
   * Rend l'adresse **scellée dans l'invitation**. C'est elle qui légitime la
   * création d'un compte alors même que les inscriptions sont fermées : on
   * n'ouvre pas une porte, on honore une invitation nominative adressée à une
   * boîte dont le clic prouve la possession.
   */
  async pending(token: string): Promise<{ id: string; email: string }> {
    const invite = await this.valide(token);
    return { id: invite.id, email: invite.email };
  }

  /**
   * Retrouve l'invitation d'un jeton, ou refuse en disant pourquoi.
   *
   * La comparaison passe par `timingSafeEqual` après la recherche par index :
   * l'index unique sur le condensat rend déjà la recherche exacte, mais la
   * comparaison finale ne doit pas dépendre du contenu — c'est la même
   * discipline que pour les sessions, et elle ne coûte rien.
   */
  private async valide(token: string) {
    if (typeof token !== "string" || token.length < 16) {
      throw new NotFoundException("Lien d'invitation invalide.");
    }

    const attendu = condensat(token);
    const [invite] = await this.db
      .select()
      .from(serverInvites)
      .where(eq(serverInvites.tokenHash, attendu))
      .limit(1);

    if (!invite || !egaux(invite.tokenHash, attendu)) {
      throw new NotFoundException("Lien d'invitation inconnu ou déjà employé.");
    }
    if (invite.acceptedAt) throw new GoneException("Cette invitation a déjà été employée.");
    if (new Date(invite.expiresAt).getTime() <= Date.now()) {
      throw new GoneException("Cette invitation a expiré. Demandez-en une nouvelle.");
    }

    return invite;
  }

  /**
   * L'auteur peut-il encore accorder ce qu'il a promis ?
   *
   * Le propriétaire, toujours. Un sous-utilisateur, seulement s'il détient
   * encore chacune des permissions scellées dans l'invitation — et à condition
   * que son propre accès n'ait pas été retiré entre-temps.
   */
  private async auteurDetientEncore(
    invite: { invitedBy: string | null; permissions: unknown; serverId: string },
    ownerId: string,
    executor: Database | Transaction = this.db,
  ): Promise<void> {
    if (invite.invitedBy && invite.invitedBy === ownerId) return;

    const caduque = new ForbiddenException(
      "Cette invitation n'est plus valable : la personne qui l'a émise n'a plus les droits nécessaires.",
    );
    if (!invite.invitedBy) throw caduque;

    const [auteur] = await executor
      .select({ permissions: serverSubusers.permissions })
      .from(serverSubusers)
      .where(
        and(
          eq(serverSubusers.serverId, invite.serverId),
          eq(serverSubusers.userId, invite.invitedBy),
        ),
      )
      .limit(1);

    const detenues = auteur?.permissions ?? [];
    const perdues = (invite.permissions as string[]).filter((p) => !detenues.includes(p));
    if (perdues.length > 0) throw caduque;
  }

  /**
   * Domaine sur lequel émettre le lien.
   *
   * **La même règle que les jetons de réinitialisation**, et volontairement pas
   * une seconde : l'hôte d'arrivée vient d'un en-tête que le navigateur peut
   * forger, il ne sert donc que s'il désigne un revendeur au domaine
   * **vérifié** — ce que `forHost` n'admet que dans ce cas. Tout autre hôte
   * retombe sur le domaine de la plateforme. Sans ce garde-fou, celui qui
   * invite choisirait le domaine vers lequel pointe un courrier expédié par
   * nous, et le panel deviendrait une fabrique de liens d'hameçonnage à
   * en-tête authentique.
   */
  private async origine(host: string | null): Promise<string> {
    const branding = await this.branding.forHost(host);
    const domaine =
      host !== null && branding.resellerId !== null
        ? host
        : await this.settings.text("brand.domain");
    return `https://${domaine.replace(/\/+$/, "")}`;
  }
}

function condensat(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function egaux(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
