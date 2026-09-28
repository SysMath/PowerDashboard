import { parseSshPublicKey, passwordStanding, verifyPassword } from "@gamedashboard/auth";
import {
  ROLE_PRESETS,
  type ServerPermission,
  type SftpAuthRequest,
  type SftpAuthResponse,
  type SubuserRolePreset,
} from "@gamedashboard/contracts";
import { type Database, serverSubusers, servers, users } from "@gamedashboard/db";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { DATABASE } from "../../common/database.provider";
import { SshKeyRepository } from "../auth/ssh-key.repository";

/**
 * Authentification SFTP, déléguée au panel par Wings.
 *
 * **Code d'isolation, pas route ordinaire (§5.5).** Wings ne vérifie rien de
 * lui-même : il transmet le nom d'utilisateur et la preuve, et applique ce que
 * le panel répond. Un défaut ici ne se traduit pas par une erreur affichée
 * mais par l'accès aux fichiers du serveur de quelqu'un d'autre — mots de
 * passe RCON et clés d'API compris.
 *
 * Trois règles en découlent, tenues tout du long :
 *
 * - **un seul refus**. Compte inconnu, mot de passe faux, serveur inexistant,
 *   serveur d'un autre node : tout rend `null`. Distinguer les cas ferait du
 *   SFTP un outil d'énumération des comptes et des serveurs.
 * - **rien n'est accordé par défaut**. Chaque étape doit dire oui ; l'absence
 *   de réponse est un refus.
 * - **la permission décide, pas le rôle**. Un administrateur du panel n'obtient
 *   pas d'accès SFTP aux serveurs des autres : il a déjà le gestionnaire de
 *   fichiers, qui journalise. Un accès SFTP au nom d'un tiers, lui, ne laisse
 *   qu'une ligne « connexion acceptée ».
 */

/** Permissions de fichier attendues par Wings — ses propres chaînes, pas les nôtres. */
const WINGS_FILE_READ = "file.read";
const WINGS_FILE_READ_CONTENT = "file.read-content";
const WINGS_FILE_CREATE = "file.create";
const WINGS_FILE_UPDATE = "file.update";
const WINGS_FILE_DELETE = "file.delete";

/**
 * Fenêtre et plafond des tentatives ratées, par adresse.
 *
 * Wings s'attend à être freiné par le panel — il le dit dans son propre code.
 * Sans ce frein, le SFTP devient le chemin le plus commode pour éprouver des
 * mots de passe : pas de formulaire, pas de second facteur, et autant d'essais
 * qu'on veut.
 *
 * En mémoire, et assumé : l'API est un seul processus, et un compteur partagé
 * en base coûterait deux écritures par tentative ratée — soit exactement ce
 * qu'un attaquant cherche à provoquer.
 */
const ATTEMPT_WINDOW_MS = 10 * 60_000;
const MAX_ATTEMPTS_PER_IP = 20;
/** Par couple adresse + identifiant, dans la même fenêtre. */
const MAX_ATTEMPTS_PER_PAIR = 10;
/**
 * Par identifiant seul, toutes adresses confondues.
 *
 * Plus large que les deux autres : il ne sert qu'à voir une attaque répartie
 * sur de nombreuses adresses, que les compteurs par adresse ne voient pas.
 * Le prix est connu — quelqu'un peut, de loin, fermer le SFTP d'un compte
 * pour dix minutes — et c'est celui de tout verrou par compte ; le
 * gestionnaire de fichiers du panel reste ouvert.
 */
const MAX_ATTEMPTS_PER_USERNAME = 30;
/** Au-delà, les plus anciens compteurs sont oubliés : la mémoire reste bornée. */
const MAX_TRACKED = 50_000;

/**
 * États où les fichiers ne doivent pas être touchés, même par leur propriétaire.
 *
 * `transferring` y manquait : pendant qu'un node archive les fichiers pour un
 * autre, une écriture SFTP se perd, ou arrive à moitié de l'autre côté.
 *
 * `restoring` est posé par `BackupsService.restore` et relâché par le compte
 * rendu de Wings (`POST /backups/:uuid/restore`) : le panel refuse le SFTP
 * pendant une restauration, sans s'en remettre au seul drapeau du daemon
 * (`IsInProtectedState`).
 */
const CLOSED_STATES = new Set([
  "installing",
  "restoring",
  "transferring",
  "install_failed",
  "suspended",
]);

@Injectable()
export class SftpAuthService {
  private readonly logger = new Logger(SftpAuthService.name);
  private readonly failures = new Map<string, { count: number; since: number }>();
  /** Dernier ménage des compteurs expirés. */
  private lastSweep = 0;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(SshKeyRepository) private readonly sshKeys: SshKeyRepository,
  ) {}

  /**
   * Décide d'une connexion SFTP.
   *
   * `null` vaut refus, sans autre précision — c'est le contrôleur qui le
   * traduit dans la forme attendue par le daemon.
   */
  async authenticate(nodeId: string, request: SftpAuthRequest): Promise<SftpAuthResponse | null> {
    /*
     * Trois compteurs : l'adresse seule, le couple adresse + identifiant, et
     * l'identifiant seul.
     *
     * Le deuxième est le plus strict, comme chez Pterodactyl : dix essais sur
     * un même compte depuis une même adresse suffisent à dire qu'on ne connaît
     * pas le mot de passe. Le premier attrape une adresse qui parcourt les
     * comptes ; le troisième, un compte éprouvé depuis de nombreuses adresses,
     * un essai chacune — que les deux autres ne voyaient pas. L'adresse vient
     * du daemon, qui la tient de la connexion : un node compromis peut la
     * falsifier, mais il peut de toute façon se passer de cette route.
     */
    const username = `user|${request.username.toLowerCase()}`;
    const pair = `${request.ip}|${request.username.toLowerCase()}`;
    if (
      this.throttled(request.ip) ||
      this.throttled(pair, MAX_ATTEMPTS_PER_PAIR) ||
      this.throttled(username, MAX_ATTEMPTS_PER_USERNAME)
    ) {
      this.logger.warn(`SFTP : trop de tentatives depuis ${request.ip}, refus sans vérification.`);
      return null;
    }
    const refuse = (): null => {
      this.refuse(request.ip);
      this.refuse(username);
      return this.refuse(pair);
    };

    const split = splitUsername(request.username);
    if (!split) return refuse();

    /*
     * Le serveur est cherché **sur ce node**, pas sur la plateforme.
     *
     * L'identité du node vient de son jeton vérifié. Sans cette condition, un
     * node compromis demanderait l'authentification d'un serveur hébergé
     * ailleurs et se ferait remettre les permissions correspondantes.
     */
    const [server] = await this.db
      .select({
        id: servers.id,
        ownerId: servers.ownerId,
        state: servers.state,
      })
      .from(servers)
      .where(
        and(
          eq(servers.nodeId, nodeId),
          // `uuid_short` porte les huit premiers caractères de l'UUID, et c'est
          // ce que l'écran affiche au client. La colonne plutôt qu'un `left()`
          // sur l'identifiant : elle est indexée, la troncature ne l'est pas.
          eq(servers.uuidShort, split.shortId),
        ),
      )
      .limit(1);

    if (!server) return refuse();

    const [account] = await this.db
      .select({
        id: users.id,
        email: users.email,
        passwordHash: users.passwordHash,
        passwordExpiresAt: users.passwordExpiresAt,
        suspendedAt: users.suspendedAt,
      })
      .from(users)
      .where(sql`lower(${users.email}) = ${split.label.toLowerCase()}`)
      .limit(1);

    if (!account) return refuse();
    /*
     * Compte suspendu : refus, avant même de regarder la preuve.
     *
     * Le SFTP est la porte qui ne passe ni par une session ni par une clé
     * d'API ; sans ce contrôle, un compte suspendu garderait l'accès complet
     * aux fichiers de ses serveurs. Le refus est le même que pour un mot de
     * passe faux : le protocole ne sait rien dire d'autre, et en dire plus
     * renseignerait sur l'état du compte.
     */
    if (account.suspendedAt !== null) return refuse();

    const proof = await this.verify(account, request);
    if (!proof) return refuse();

    const permissions = await this.permissionsFor(account.id, server);
    // Compte reconnu mais sans droit sur ce serveur : refus au même titre que
    // le reste. Répondre « permissions vides » ouvrirait une session dont
    // chaque commande échouerait, sans jamais dire pourquoi.
    if (permissions.length === 0) return refuse();

    /*
     * Un serveur en cours d'installation ou suspendu n'ouvre pas.
     *
     * Wings refuse déjà chaque opération dans ces états, mais il le fait
     * *après* avoir ouvert la session : le client voit une connexion réussie
     * puis des erreurs sur chaque fichier. Refuser ici donne le seul message
     * que le protocole sait transmettre — l'échec d'authentification — mais au
     * moins il arrive tout de suite.
     */
    if (server.state && CLOSED_STATES.has(server.state)) return refuse();

    if (proof.keyId) void this.sshKeys.markUsed(proof.keyId);
    // Le compteur par identifiant reste : un succès depuis une adresse ne dit
    // rien des essais venus d'ailleurs, et l'effacer laisserait l'attaque
    // répartie reprendre à zéro à chaque connexion de son titulaire.
    this.failures.delete(request.ip);
    this.failures.delete(pair);

    return { server: server.id, user: account.id, permissions };
  }

  /**
   * Vérifie la preuve : mot de passe, ou possession d'une clé enregistrée.
   *
   * Les deux chemins rendent la même chose et coûtent le même refus. Le
   * `keyId` ne sert qu'à noter l'usage de la clé.
   */
  private async verify(
    account: { id: string; passwordHash: string | null; passwordExpiresAt?: string | null },
    request: SftpAuthRequest,
  ): Promise<{ keyId: string | null } | null> {
    if (request.type === "password") {
      /*
       * Un compte sans mot de passe local — créé par authentification unique —
       * n'a rien à vérifier ici.
       *
       * Il lui reste les clés SSH, qui sont le bon moyen : un mot de passe de
       * SFTP se confie à un client tiers, alors qu'une clé ne quitte pas la
       * machine de son porteur.
       */
      if (!account.passwordHash) return null;
      /*
       * Un mot de passe provisoire échu ne vaut plus rien, ici non plus
       * (ASVS 2.3.1) : la connexion au panel le refuse, et le SFTP l'acceptait
       * encore, ce qui en faisait le mot de passe durable du compte. Les clés
       * SSH, choisies par leur porteur, ne sont pas concernées.
       */
      if (passwordStanding(account.passwordExpiresAt ?? null) === "expired") return null;
      // Le mot de passe suffit, double authentification ou non : le protocole
      // n'a aucune étape pour un code. Écart assumé et documenté (ADR 0001).
      return (await verifyPassword(account.passwordHash, request.password))
        ? { keyId: null }
        : null;
    }

    const parsed = parseSshPublicKey(request.password);
    if (typeof parsed === "string") return null;

    // L'empreinte est recalculée depuis la clé proposée, jamais lue dans la
    // requête : c'est elle qui désigne le porteur.
    const key = await this.sshKeys.findByFingerprint(account.id, parsed.fingerprint);
    return key ? { keyId: key.id } : null;
  }

  /**
   * Permissions de fichier de ce compte sur ce serveur, traduites pour Wings.
   *
   * Le propriétaire a tout. Un sous-utilisateur n'obtient que ce que sa
   * délégation porte, et seulement s'il a `files.sftp` : voir les fichiers dans
   * le panel — qui journalise chaque geste — et pouvoir les emporter par SFTP
   * ne se donnent pas au même monde.
   */
  private async permissionsFor(
    userId: string,
    server: { id: string; ownerId: string },
  ): Promise<string[]> {
    if (server.ownerId === userId) {
      return [
        WINGS_FILE_READ,
        WINGS_FILE_READ_CONTENT,
        WINGS_FILE_CREATE,
        WINGS_FILE_UPDATE,
        WINGS_FILE_DELETE,
      ];
    }

    const [subuser] = await this.db
      .select({ preset: serverSubusers.rolePreset, permissions: serverSubusers.permissions })
      .from(serverSubusers)
      .where(
        and(
          eq(serverSubusers.serverId, server.id),
          eq(serverSubusers.userId, userId),
          // Une invitation non acceptée n'est pas une délégation : elle ne
          // porte encore le consentement de personne.
          isNotNull(serverSubusers.acceptedAt),
        ),
      )
      .limit(1);

    if (!subuser) return [];
    return toWingsPermissions(effectivePermissions(subuser));
  }

  /** Enregistre l'échec pour cette clé, puis refuse. */
  private refuse(key: string): null {
    const now = Date.now();
    this.sweep(now);
    const current = this.failures.get(key);

    if (!current || now - current.since > ATTEMPT_WINDOW_MS) {
      this.failures.set(key, { count: 1, since: now });
    } else {
      current.count += 1;
    }

    return null;
  }

  /**
   * Oublie les compteurs dont la fenêtre est écoulée.
   *
   * Un compteur ne se vidait qu'au retour de la même adresse : chaque adresse
   * de passage — un balayage d'Internet en compte des milliers — restait en
   * mémoire pour toujours. Le ménage passe une fois par fenêtre, ou plus tôt
   * si la table déborde ; et si elle déborde encore, les plus anciens
   * compteurs partent en premier (ordre d'insertion de la `Map`).
   */
  private sweep(now: number): void {
    if (now - this.lastSweep < ATTEMPT_WINDOW_MS && this.failures.size < MAX_TRACKED) return;
    this.lastSweep = now;

    for (const [key, entry] of this.failures) {
      if (now - entry.since > ATTEMPT_WINDOW_MS) this.failures.delete(key);
    }
    for (const key of this.failures.keys()) {
      if (this.failures.size < MAX_TRACKED) break;
      this.failures.delete(key);
    }
  }

  private throttled(key: string, limit: number = MAX_ATTEMPTS_PER_IP): boolean {
    const current = this.failures.get(key);
    if (!current) return false;

    // Fenêtre écoulée : le compteur repart de zéro plutôt que de se vider peu
    // à peu. Un bureau derrière une seule adresse publique ne doit pas rester
    // bloqué parce qu'un de ses postes s'est trompé vingt fois la veille.
    if (Date.now() - current.since > ATTEMPT_WINDOW_MS) {
      this.failures.delete(key);
      return false;
    }

    return current.count >= limit;
  }
}

/**
 * Sépare `<identifiant>.<huit caractères>`.
 *
 * Wings impose déjà cette forme avant d'appeler le panel, mais elle est
 * revérifiée : ce qui arrive ici vient du réseau, et se fier au contrôle d'un
 * appelant est exactement ce qu'on ne fait pas dans du code d'isolation.
 *
 * La coupure se fait au **dernier** point : une adresse e-mail en contient, et
 * couper au premier donnerait « matheo » pour « matheo.leduc@…. ».
 */
export function splitUsername(username: string): { label: string; shortId: string } | null {
  const cut = username.lastIndexOf(".");
  if (cut <= 0) return null;

  const label = username.slice(0, cut);
  const shortId = username.slice(cut + 1).toLowerCase();

  if (label === "" || !/^[a-f0-9]{8}$/.test(shortId)) return null;
  return { label, shortId };
}

/**
 * Permissions effectives d'une délégation.
 *
 * La liste stockée fait foi ; le preset n'est qu'une étiquette d'origine, et
 * le relire élargirait rétroactivement les droits de gens invités il y a des
 * mois, le jour où l'on retouche un preset (§6.4).
 */
function effectivePermissions(subuser: { preset: string | null; permissions: string[] }): string[] {
  if (subuser.permissions.length > 0) return subuser.permissions;
  const preset = subuser.preset as SubuserRolePreset | null;
  return preset && preset in ROLE_PRESETS ? [...ROLE_PRESETS[preset]] : [];
}

/**
 * Traduit nos permissions dans celles que Wings vérifie.
 *
 * La correspondance n'est pas terme à terme, et c'est voulu : Wings distingue
 * lister un dossier de lire un fichier, quand le panel n'a qu'un seul droit de
 * lecture. On donne donc les deux — l'inverse laisserait un client SFTP voir
 * les noms sans jamais pouvoir ouvrir quoi que ce soit.
 *
 * Sans `files.sftp`, la liste est vide : c'est ce droit qui ouvre la porte,
 * les autres ne disent que ce qu'on peut faire une fois entré.
 */
export function toWingsPermissions(granted: readonly string[]): string[] {
  if (!granted.includes("files.sftp" satisfies ServerPermission)) return [];

  const wings: string[] = [];
  if (granted.includes("files.read")) wings.push(WINGS_FILE_READ, WINGS_FILE_READ_CONTENT);
  if (granted.includes("files.write")) wings.push(WINGS_FILE_CREATE, WINGS_FILE_UPDATE);
  if (granted.includes("files.delete")) wings.push(WINGS_FILE_DELETE);

  // `files.sftp` seul n'ouvre rien : entrer sans pouvoir lire ni écrire n'est
  // pas un accès, c'est une session qui échoue à chaque commande.
  return wings;
}
