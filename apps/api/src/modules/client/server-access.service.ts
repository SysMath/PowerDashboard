import {
  isSupportPermission,
  type PlatformAccess,
  platformAccessOf,
  platformMayManage,
  platformMaySee,
  ROLE_PRESETS,
  reinstallBlocked,
  type ServerPermission,
  SUPPORT_SERVER_PERMISSIONS,
  type SubuserRolePreset,
  serverBlock,
} from "@gamedashboard/contracts";
import { type Database, serverSubusers, servers, users } from "@gamedashboard/db";
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, isNotNull } from "drizzle-orm";
import { DATABASE } from "../../common/database.provider";
import { type RequestOrigin, requestOrigin } from "../../common/request-origin";
import { DenialLogService } from "../activity/denial-log.service";

/**
 * Qui demande, et sous quelle restriction.
 *
 * Un objet plutôt que deux paramètres : le type oblige chaque appelant à dire
 * explicitement s'il agit sous des portées. Un `scopes` optionnel aurait laissé
 * passer les oublis, et un oubli ici donne à une clé restreinte les droits
 * complets de son propriétaire.
 */
/*
 * Pourquoi un serveur ne peut pas obéir : la liste vit dans les contrats.
 *
 * Elle y a été déplacée parce qu'elle existait ici seule, et que l'interface
 * en ignorait tout : les boutons d'alimentation ne lisaient que l'état du
 * conteneur, si bien que « Start » restait actif pendant une installation et
 * que le refus n'arrivait qu'après le clic.
 *
 * Le déplacement a révélé un manque : `transferring` n'y figurait pas. Un
 * serveur en cours de transfert acceptait donc d'être démarré — sur une copie
 * incomplète, pendant que l'autre machine écrivait encore.
 */

export interface AccessPrincipal {
  id: string;
  /** `null` = session de navigateur, sans restriction. Voir `AuthenticatedRequest`. */
  scopes: string[] | null;
  /**
   * Route et adresse de la demande, pour le journal des refus seulement.
   * Absente, le refus est consigné quand même, sans elles.
   */
  origin?: RequestOrigin;
  /**
   * Vrai pour l'application mobile (ADR 0010). Elle agit avec les droits du
   * compte, mais jamais avec ceux du personnel sur les serveurs d'autrui :
   * ce qui en est ouvert à l'application passe par `APP_STAFF_ROUTES`.
   */
  appDevice?: boolean;
}

/** Qui demande, tel que la garde l'a posé sur la requête. */
export function accessPrincipal(request: {
  user: { id: string };
  scopes: string[] | null;
  appDeviceId?: string;
}): AccessPrincipal {
  return {
    id: request.user.id,
    scopes: request.scopes,
    origin: requestOrigin(request),
    ...(request.appDeviceId !== undefined ? { appDevice: true } : {}),
  };
}

/** Origine d'une demande dont l'appelant n'a rien dit. */
const UNKNOWN_ORIGIN: RequestOrigin = { ip: null, route: "?" };

/**
 * Droits d'un utilisateur sur un serveur.
 *
 * Un point de passage unique, appelé par toutes les routes serveur. La règle
 * d'accès existe ainsi en un seul exemplaire : deux implémentations finiraient
 * par diverger, et c'est toujours la plus permissive qu'on oublie de resserrer.
 */
@Injectable()
export class ServerAccessService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(DenialLogService) private readonly denials: DenialLogService,
  ) {}

  /**
   * Vérifie l'accès et la permission demandée.
   *
   * Lève `NotFoundException` quand l'utilisateur n'a aucun droit : il ne doit
   * pas pouvoir distinguer « ce serveur n'existe pas » de « il ne vous
   * appartient pas », sans quoi il pourrait énumérer les serveurs des autres.
   *
   * Lève `ForbiddenException` quand il a accès mais pas *cette* permission :
   * la distinction est alors légitime, puisqu'il sait déjà que le serveur
   * existe et qu'il y a accès.
   *
   * **Chaque refus est consigné** (NC-12) : un compte qui essayait les
   * identifiants de serveur un à un, ou un sous-utilisateur qui forçait une
   * action retirée, ne laissait rien. La réponse, elle, ne change pas — un
   * 404 d'inconnu reste un 404 — et la trace part sans être attendue.
   */
  async require(
    principal: AccessPrincipal,
    serverId: string,
    permission: ServerPermission,
  ): Promise<{ isOwner: boolean }> {
    try {
      return await this.decide(principal, serverId, permission);
    } catch (error) {
      if (error instanceof NotFoundException || error instanceof ForbiddenException) {
        void this.denials.record({
          event: "access.denied",
          actorId: principal.id,
          actorType: principal.scopes === null ? "user" : "api_key",
          origin: principal.origin ?? UNKNOWN_ORIGIN,
          properties: { server: serverId, permission, status: error.getStatus() },
        });
      }
      throw error;
    }
  }

  /** La décision elle-même : voir `require`. */
  private async decide(
    principal: AccessPrincipal,
    serverId: string,
    permission: ServerPermission,
  ): Promise<{ isOwner: boolean }> {
    const { id: userId, scopes } = principal;

    /**
     * Une clé d'API ne peut jamais dépasser ses portées, même quand son
     * propriétaire possède le serveur.
     *
     * Le contrôle vient en premier : c'est la seule place où il ne dépend
     * d'aucune lecture, donc la seule où l'oublier serait visible. Le placer
     * après le cas propriétaire aurait donné à toute clé d'un propriétaire les
     * pleins pouvoirs sur ses serveurs — c'est-à-dire exactement ce que les
     * portées servent à empêcher.
     */
    if (scopes !== null && !scopes.includes(permission)) {
      // Le nom de la portée manquante figure dans le message : c'est la seule
      // information qui permette à l'auteur d'un script de la corriger sans
      // deviner. Elle ne révèle rien — il tient déjà la clé.
      throw new ForbiddenException(`Cette clé d'API n'a pas la portée « ${permission} ».`);
    }

    const [owned] = await this.db
      .select({ id: servers.id })
      .from(servers)
      .where(and(eq(servers.id, serverId), eq(servers.ownerId, userId)))
      .limit(1);

    // Le propriétaire a tout, sans exception à énumérer : lui retirer une
    // permission n'aurait pas de sens puisqu'il peut se la redonner.
    if (owned) return { isOwner: true };

    const [subuser] = await this.db
      .select({ preset: serverSubusers.rolePreset, permissions: serverSubusers.permissions })
      .from(serverSubusers)
      .where(
        and(
          eq(serverSubusers.serverId, serverId),
          eq(serverSubusers.userId, userId),
          // Une invitation en attente ne donne aucun droit.
          isNotNull(serverSubusers.acceptedAt),
        ),
      )
      .limit(1);

    /*
     * Le personnel de la plateforme, quand il n'est ni propriétaire ni invité.
     *
     * **Relevé en exploitation** : un administrateur qui ouvrait la console
     * d'un serveur client se voyait répondre « Serveur introuvable ». C'est la
     * bonne réponse pour un inconnu — elle ne révèle pas qu'un serveur existe —
     * mais elle est fausse pour quelqu'un qui peut, par ailleurs, tout changer
     * de ce serveur depuis l'administration. Le panel se contredisait.
     *
     * L'ordre compte : le rôle est consulté **après** le sous-utilisateur, pour
     * qu'une invitation nominative reste la voie normale, et **après** le
     * contrôle des portées de clé, qui borne déjà tout le reste.
     */
    if (!subuser) {
      /*
       * Le rôle ne joue que pour une session de navigateur. Une clé d'API d'un
       * membre du personnel, à portée « fichiers » par exemple, aurait sinon
       * cette portée sur **tous** les serveurs de la plateforme — ce que
       * l'écran de création n'annonce pas. Par clé, le personnel n'atteint que
       * ce qu'il possède ou ce à quoi il est invité, comme tout le monde.
       */
      const staff =
        scopes === null && !principal.appDevice
          ? await this.staffAccess(userId, serverId, permission)
          : null;
      if (staff) return staff;
      throw new NotFoundException("Serveur introuvable.");
    }

    if (!granted(subuser).includes(permission)) {
      throw new ForbiddenException(`Permission « ${permission} » requise.`);
    }
    return { isOwner: false };
  }

  /**
   * Le serveur est-il en état d'obéir ?
   *
   * **Relevé en exploitation** : rien n'empêchait de cliquer « Démarrer »
   * pendant que le panel remplaçait le jar. Le daemon aurait lancé un serveur
   * sur un fichier à moitié écrit — et la panne qui suit ne ressemble en rien
   * à sa cause.
   *
   * Le contrôle est **distinct** des permissions, et c'est délibéré : avoir le
   * droit de démarrer un serveur et pouvoir le démarrer maintenant sont deux
   * questions différentes. Les mêler ferait répondre « permission requise » à
   * quelqu'un qui a tous les droits et attend simplement la fin d'une
   * installation.
   *
   * Quatre états, quatre raisons, toutes dites :
   *
   * - `installing` : le panel ou le daemon écrit dans ce serveur ;
   * - `restoring` : une sauvegarde est en cours de restauration, et démarrer
   *   par-dessus écraserait ce qu'on est en train de rendre ;
   * - `install_failed` : il n'y a rien à lancer — une réinstallation, oui, un
   *   démarrage, non ;
   * - `suspended` : décision administrative, que son propriétaire ne lève pas.
   */
  async requireOperable(serverId: string): Promise<void> {
    const [row] = await this.db
      .select({ state: servers.state })
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);

    // Pas de ligne : `require` a déjà tranché avant nous. Ne rien dire ici
    // évite de transformer un 404 en 409.
    if (!row?.state) return;

    const blocage = serverBlock(row.state);
    if (blocage) throw new ConflictException(blocage.body);
  }

  /**
   * La réinstallation, qui ne se refuse pas comme le reste.
   *
   * `requireOperable` dirait non sur les cinq états. Or `install_failed` est
   * précisément celui que la réinstallation répare, et le message de ce
   * blocage dit lui-même « relancez une installation » : refuser ici
   * enverrait quelqu'un appuyer sur le seul bouton que l'on vient de lui
   * désactiver.
   *
   * Les quatre autres restent fermés. Réinstaller pendant une installation en
   * lancerait une seconde par-dessus la première, et le daemon ne s'y oppose
   * pas — son garde d'état ne couvre que SFTP.
   */
  async requireReinstallable(serverId: string): Promise<void> {
    const [row] = await this.db
      .select({ state: servers.state })
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);

    if (!reinstallBlocked(row?.state)) return;
    // Le message reste celui du blocage : il nomme la situation, pas la route.
    const blocage = serverBlock(row?.state);
    if (blocage) throw new ConflictException(blocage.body);
  }

  /**
   * Ce que le rôle d'un compte lui donne sur un serveur qui n'est pas le sien.
   *
   * Deux rôles, deux portées, et la différence est de nature :
   *
   * - **administrateur** : tout. Il peut déjà changer l'image du conteneur et
   *     la commande de démarrage depuis l'administration ; lui refuser la
   *     console serait une barrière qui n'arrête rien et gêne un diagnostic.
   * - **assistance** : la lecture seule de `SUPPORT_SERVER_PERMISSIONS`. Voir
   *     pour comprendre, sans agir — un incident résolu en modifiant le serveur
   *     d'un client à son insu est un incident qu'on ne peut plus lui expliquer.
   *
   * `null` pour tout le reste, et l'appelant répond alors « introuvable ».
   */
  private async staffAccess(
    userId: string,
    serverId: string,
    permission: ServerPermission,
  ): Promise<{ isOwner: boolean } | null> {
    const [account] = await this.db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    /*
     * Le revendeur, sur les serveurs qu'il héberge — et sur ceux-là seuls.
     *
     * Il répond de ces machines : quand un de ses clients l'appelle parce que
     * son serveur ne démarre plus, il doit pouvoir ouvrir la console et les
     * fichiers. Le lui refuser revenait à lui vendre un parc qu'il ne peut pas
     * exploiter — il voyait ses serveurs dans son espace, et se faisait
     * répondre « introuvable » en cliquant dessus.
     *
     * Le périmètre est lu sur le **serveur**, jamais sur le compte du client :
     * un client peut acheter chez deux revendeurs, et c'est le serveur qui dit
     * de qui il relève. La condition est dans la requête, de sorte qu'un
     * serveur hors de son parc ne remonte simplement pas.
     */
    if (account?.role === "reseller") {
      const [sien] = await this.db
        .select({ id: servers.id })
        .from(servers)
        .where(and(eq(servers.id, serverId), eq(servers.resellerId, userId)))
        .limit(1);

      // `isOwner` au sens des droits : il exploite la machine, il peut tout y
      // faire. Un demi-accès obligerait à énumérer ce qu'un hébergeur a le
      // droit de dépanner, et la liste serait fausse au premier incident.
      return sien ? { isOwner: true } : null;
    }

    if (account?.role === "admin" || account?.role === "support") {
      /*
       * Sur le parc d'un revendeur, c'est **lui** qui fixe la limite.
       *
       * Un administrateur avait jusqu'ici tous les droits partout, y compris
       * sur les serveurs des clients d'un revendeur — console, fichiers,
       * suppression. Le revendeur pouvait refuser qu'on *crée* chez lui, rien
       * de plus. Il répond pourtant de ces machines devant ses clients : c'est
       * à lui de dire ce que l'hébergeur de l'hébergeur peut en faire.
       *
       * Un serveur qui ne relève d'aucun revendeur reste plein et entier à la
       * plateforme : c'est le sien.
       */
      const niveau = await this.platformAccessFor(serverId);

      if (!platformMaySee(niveau)) {
        // Invisible veut dire introuvable, sans distinction possible : le
        // contraire apprendrait qu'il existe un serveur ici.
        return null;
      }

      const gere = account.role === "admin" && platformMayManage(niveau);
      if (gere) {
        // `isOwner` au sens des droits, pas de la propriété : c'est ce drapeau
        // qui décide si le jeton de console porte `*`.
        return { isOwner: true };
      }

      /*
       * Lecture seule, pour l'assistance **et** pour l'administration quand le
       * revendeur n'accorde pas la gestion. Le même jeu de permissions sert les
       * deux : « voir pour comprendre, sans agir » ne dépend pas du titre de
       * celui qui regarde.
       */
      if (!isSupportPermission(permission)) {
        throw new ForbiddenException(
          account.role === "support"
            ? `L'assistance n'exerce pas « ${permission} » sur le serveur d'un client.`
            : `Ce revendeur n'accorde à la plateforme qu'un accès en lecture : « ${permission} » lui est refusée.`,
        );
      }
      return { isOwner: false };
    }

    return null;
  }

  /**
   * Le niveau d'accès que le revendeur de ce serveur accorde à la plateforme.
   *
   * `provision` pour un serveur sans revendeur : il est à la plateforme, et
   * rien ne justifierait qu'elle s'y limite elle-même.
   */
  private async platformAccessFor(serverId: string): Promise<PlatformAccess> {
    const [row] = await this.db
      .select({ niveau: users.platformAccess })
      .from(servers)
      .innerJoin(users, eq(users.id, servers.resellerId))
      .where(eq(servers.id, serverId))
      .limit(1);

    return row ? platformAccessOf(row.niveau) : "provision";
  }

  /**
   * Permissions effectives d'un sous-utilisateur, pour les sceller dans un
   * jeton remis au navigateur.
   *
   * Renvoie une liste vide quand l'utilisateur n'est pas sous-utilisateur : le
   * propriétaire passe par un autre chemin, et un inconnu n obtient rien.
   */
  async permissionsFor(userId: string, serverId: string): Promise<string[]> {
    const [subuser] = await this.db
      .select({ preset: serverSubusers.rolePreset, permissions: serverSubusers.permissions })
      .from(serverSubusers)
      .where(
        and(
          eq(serverSubusers.serverId, serverId),
          eq(serverSubusers.userId, userId),
          isNotNull(serverSubusers.acceptedAt),
        ),
      )
      .limit(1);

    if (subuser) return granted(subuser);

    /*
     * Le personnel n'est pas sous-utilisateur, et son jeton de console doit
     * quand même porter ce qu'il a le droit de faire. Sans cela, un compte
     * d'assistance ouvrirait un websocket vide : Wings lui refuserait tout,
     * après que le panel lui a dit oui.
     */
    const [account] = await this.db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    return account?.role === "support" ? [...SUPPORT_SERVER_PERMISSIONS] : [];
  }
}

/**
 * Permissions effectives d'un sous-utilisateur.
 *
 * La liste stockée fait foi, le preset n'est qu'une étiquette d'origine : il
 * sert de repli pour les lignes anciennes, mais ne recalcule jamais les droits
 * d'une invitation déjà acceptée. Sinon, redéfinir un preset élargirait
 * rétroactivement les droits de gens invités des mois plus tôt (§6.4).
 */
function granted(subuser: { preset: string | null; permissions: string[] }): string[] {
  if (subuser.permissions.length > 0) return subuser.permissions;
  const preset = subuser.preset as SubuserRolePreset | null;
  return preset && preset in ROLE_PRESETS ? [...ROLE_PRESETS[preset]] : [];
}
