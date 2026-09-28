import { type Database, servers, users } from "@gamedashboard/db";
import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { DATABASE } from "../../common/database.provider";
import { isUuid } from "../../common/uuid";

/** Ce que le périmètre lit d'un compte, en une requête. */
interface Rattachement {
  role: string;
  suspendu: boolean;
  /** Possède au moins un serveur hébergé par ce revendeur. */
  possedeIci: boolean;
  /** A été créé par une clé de ce revendeur (`reseller_customers`). */
  creeIci: boolean;
  /** Possède au moins un serveur hébergé ailleurs : confrère ou plateforme. */
  possedeAilleurs: boolean;
  /** Est sous-utilisateur d'au moins un serveur hébergé ailleurs. */
  inviteAilleurs: boolean;
}

/**
 * Le périmètre d'une clé applicative.
 *
 * Une clé portait des **portées sans périmètre** : elle disait ce qu'on pouvait
 * faire, jamais sur qui. Tant que la seule clé du panel était celle de
 * l'exploitant, cela suffisait. Dès qu'un revendeur branche sa propre boutique,
 * c'est l'inverse qui compte : il doit pouvoir créer et suspendre, mais
 * seulement chez lui.
 *
 * **Le rattachement se lit sur les serveurs**, parce que c'est là qu'il vit :
 * un compte n'appartient à personne, ce sont ses serveurs qui appartiennent à
 * un revendeur. « Ce client est à moi » se traduit donc par « ce client possède
 * au moins un serveur que j'héberge » — et non l'inverse, qui supposerait une
 * colonne que le modèle n'a pas et qui mentirait dès qu'un client achète
 * ailleurs.
 *
 * **Sauf le compte qu'il a créé** (`reseller_customers`), que les serveurs ne
 * disent pas encore : celui que sa boutique vient d'ouvrir pour une commande.
 * Un compte est donc à ce revendeur s'il le **sert** (un serveur chez lui) ou
 * s'il l'a **créé**, et à aucun autre titre. Avant, un compte sans serveur
 * était à qui voulait lui en donner un : la clé créait un serveur chez un
 * compte qui n'était à personne, puis lui ouvrait une session.
 */
@Injectable()
export class ResellerScopeService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Refuse si ce compte ne relève pas du périmètre de la clé — en lecture.
   *
   * Une clé de plateforme (`resellerId` nul) passe sans contrôle : c'est son
   * rôle, et c'est le comportement qu'avaient toutes les clés jusqu'ici.
   *
   * Un compte qu'il sert ou qu'il a créé. **Seul un compte client** en relève. Un membre du personnel ou un
   * revendeur qui posséderait un serveur chez ce revendeur n'est pas son
   * client pour autant, et sa fiche ne lui est pas lisible.
   *
   * Le message ne distingue pas « ce client n'existe pas » de « ce client n'est
   * pas à vous ». La distinction n'intéresse que celui qui cherche à savoir
   * qui sont les clients des autres revendeurs, et il n'a pas à l'apprendre
   * d'ici.
   */
  async requireUser(resellerId: string | null, userId: string): Promise<void> {
    // Avant la sortie de la clé de plateforme : un identifiant illisible
    // partait sinon jusqu'à PostgreSQL, qui répondait 500.
    if (!isUuid(userId)) throw new NotFoundException("Compte introuvable.");
    if (resellerId === null) return;

    const compte = await this.rattachement(resellerId, userId);
    if (compte?.role !== "user" || !(compte.possedeIci || compte.creeIci)) {
      throw new NotFoundException("Compte introuvable.");
    }
  }

  /**
   * Refuse de modifier un compte qui n'est pas **entièrement** à ce revendeur.
   *
   * Lire le client qu'on partage avec un confrère est normal ; le modifier ne
   * l'est pas. Son identifiant externe, en particulier, est celui par lequel
   * la facturation de l'autre le retrouve : une clé qui le réécrivait lui
   * coupait le lien de connexion. C'est la règle du lien de connexion
   * (NC-01) : tous les serveurs possédés sont chez ce revendeur.
   */
  async requireOwnedUser(resellerId: string | null, userId: string): Promise<void> {
    if (!isUuid(userId)) throw new NotFoundException("Compte introuvable.");
    if (resellerId === null) return;

    const compte = await this.rattachement(resellerId, userId);
    if (
      compte?.role !== "user" ||
      !(compte.possedeIci || compte.creeIci) ||
      compte.possedeAilleurs ||
      // Même règle que le destinataire d'un serveur : créé ici mais sans
      // serveur ici, et invité chez un confrère, le compte sert ailleurs.
      // Le supprimer retirait au passage l'accès de l'équipe du confrère.
      (compte.inviteAilleurs && !compte.possedeIci)
    ) {
      throw new NotFoundException("Compte introuvable.");
    }
  }

  /** Même règle pour un serveur : il doit être hébergé par ce revendeur. */
  async requireServer(resellerId: string | null, serverId: string): Promise<void> {
    if (!isUuid(serverId)) throw new NotFoundException("Serveur introuvable.");
    if (resellerId === null) return;

    const [lien] = await this.db
      .select({ id: servers.id })
      .from(servers)
      .where(and(eq(servers.id, serverId), eq(servers.resellerId, resellerId)))
      .limit(1);

    if (!lien) {
      throw new NotFoundException("Serveur introuvable.");
    }
  }

  /**
   * Refuse de donner un serveur à un compte qui n'est pas à ce revendeur — à
   * la création comme au changement de titulaire.
   *
   * **Donner un serveur fait entrer le compte dans le périmètre** : ensuite,
   * la clé le lit, le modifie et lui ouvre une session. La création ne
   * vérifiait pas le destinataire, et une clé de revendeur annexait ainsi le
   * client d'un confrère ou un administrateur, dont elle lisait puis
   * réécrivait la fiche.
   *
   * Le destinataire doit donc être un compte client, non suspendu, **déjà à
   * ce revendeur avant la requête** — un client qu'il sert, ou un compte que
   * sa clé a créé — et rattaché à personne d'autre : aucun serveur possédé
   * ailleurs, et, s'il n'est pas encore servi ici, aucune invitation sur un
   * serveur d'ailleurs. Le compte que la boutique vient de créer pour une
   * commande ou un changement de titulaire passe ainsi ; un compte sans
   * serveur qui n'est à personne, non : c'était la première marche du chemin
   * vers `users.sso`.
   *
   * Refusés, avec le même 404 que l'absence :
   *
   * - le personnel et les revendeurs, qui ne sont jamais les clients d'un
   *   revendeur ;
   * - le client d'un confrère ou de la plateforme, y compris celui qu'on
   *   partage : lui donner un serveur de plus, c'est prendre pied chez
   *   l'autre ;
   * - un compte que ce revendeur ne sert pas et n'a pas créé : inscrit de
   *   lui-même, ouvert par l'administration ou par un confrère ;
   * - un compte qui n'est pas encore servi ici et qui est invité sur le
   *   serveur d'un autre : la session qu'on pourrait lui ouvrir ensuite
   *   donnerait aussi cet accès-là.
   *
   * **Le propre client de la boutique, invité ailleurs, reçoit.** La clé lit
   * déjà sa fiche et lui ouvre déjà sa session, invitations comprises : lui
   * refuser un serveur de plus ne protégeait personne, et empêchait
   * seulement une vente ou un transfert entre ses propres clients.
   *
   * **Un compte suspendu est refusé**, qu'un revendeur n'a pas à réactiver de
   * fait en lui livrant un serveur. Quand c'est son propre compte, qu'il lit
   * déjà, le refus le dit : « introuvable » pour un compte que la boutique
   * vient de trouver l'aurait envoyée chercher ailleurs.
   *
   * Une clé de plateforme passe, comme partout : les garde-fous de
   * l'administration s'appliquent ensuite.
   */
  async requireRecipient(resellerId: string | null, userId: string): Promise<void> {
    if (resellerId === null) return;

    const compte = await this.rattachement(resellerId, userId);
    if (
      compte?.role !== "user" ||
      !(compte.possedeIci || compte.creeIci) ||
      compte.possedeAilleurs ||
      (compte.inviteAilleurs && !compte.possedeIci)
    ) {
      throw new NotFoundException("Compte introuvable.");
    }
    if (compte.suspendu) {
      if (compte.possedeIci || compte.creeIci) {
        throw new ForbiddenException(
          "Ce compte est suspendu dans le panel : aucun serveur ne lui est livré tant qu'il n'est pas réactivé.",
        );
      }
      throw new NotFoundException("Compte introuvable.");
    }
  }

  /**
   * Le rattachement d'un compte vu de ce revendeur, en une seule requête.
   *
   * « Ailleurs » se lit `is distinct from` : un serveur resté à la plateforme
   * (`reseller_id` nul) est un parc distinct, et une comparaison ordinaire
   * l'aurait laissé passer, `null <> x` n'étant jamais vrai.
   *
   * Les sous-requêtes nomment leurs tables en toutes lettres : drizzle rend
   * les colonnes d'une sélection sur une seule table sans leur préfixe, et
   * `id` devenait ambigu dès qu'un `servers` entrait dans la requête.
   */
  private async rattachement(resellerId: string, userId: string): Promise<Rattachement | null> {
    if (!isUuid(userId)) return null;

    const [compte] = await this.db
      .select({
        role: users.role,
        suspendu: sql<boolean>`${users.suspendedAt} is not null`,
        possedeIci: sql<boolean>`exists (
          select 1 from servers s
          where s.owner_id = users.id and s.reseller_id = ${resellerId}
        )`,
        creeIci: sql<boolean>`exists (
          select 1 from reseller_customers rc
          where rc.user_id = users.id and rc.reseller_id = ${resellerId}
        )`,
        possedeAilleurs: sql<boolean>`exists (
          select 1 from servers s
          where s.owner_id = users.id and s.reseller_id is distinct from ${resellerId}
        )`,
        inviteAilleurs: sql<boolean>`exists (
          select 1 from server_subusers su
          join servers s on s.id = su.server_id
          where su.user_id = users.id and s.reseller_id is distinct from ${resellerId}
        )`,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    return compte ?? null;
  }

  /**
   * Refuse tout net les routes qui n'ont pas de sens pour un revendeur.
   *
   * Les enveloppes de revente et la configuration d'un node relèvent de la
   * plateforme. Un revendeur qui pourrait poser sa propre enveloppe n'en aurait
   * plus ; un revendeur qui lirait la configuration d'un node repartirait avec
   * le jeton du daemon, c'est-à-dire avec la machine.
   */
  requirePlatform(resellerId: string | null, quoi: string): void {
    if (resellerId === null) return;
    throw new ForbiddenException(
      `Cette clé est bornée à un revendeur : ${quoi} relève de la plateforme.`,
    );
  }

  /**
   * Restreint une liste de serveurs au périmètre.
   *
   * Rendue comme condition SQL plutôt qu'en filtrant après coup : filtrer
   * ensuite laisse passer les compteurs, la pagination et les agrégats, qui
   * continuent de porter sur tout le parc. C'est le genre de fuite qui ne se
   * voit pas — on lit « 412 serveurs » sans remarquer qu'on n'en possède que
   * douze.
   */
  serverFilter(resellerId: string | null) {
    return resellerId === null ? undefined : eq(servers.resellerId, resellerId);
  }

  /**
   * Restreint une liste de comptes au périmètre.
   *
   * Un `exists` plutôt qu'une jointure : une jointure dupliquerait le compte
   * autant de fois qu'il a de serveurs chez ce revendeur. Même règle que
   * `requireUser` : servi ou créé par lui.
   */
  userFilter(resellerId: string | null) {
    if (resellerId === null) return undefined;
    // Tables nommées en toutes lettres, pour la raison dite à `rattachement`.
    return sql`(exists (
      select 1 from servers s
      where s.owner_id = users.id and s.reseller_id = ${resellerId}
    ) or exists (
      select 1 from reseller_customers rc
      where rc.user_id = users.id and rc.reseller_id = ${resellerId}
    ))`;
  }
}
