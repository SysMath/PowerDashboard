import {
  ChmodRequest,
  consoleCommandTrace,
  MAX_CONSOLE_COMMAND_LENGTH,
  PATH_REFUSAL_MESSAGES,
  PowerSignal,
  PRIVILEGED_PLAYER_ACTIONS,
  RenameRequest,
  refusePath,
  WINGS_RENAME_COLLISION,
} from "@gamedashboard/contracts";
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Inject,
  Logger,
  Param,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import { ActivityService } from "../activity/activity.service";
import { ImpersonationReadOnlyGuard, withImpersonator } from "../auth/impersonation.guard";
import type { AuthenticatedRequest } from "../auth/session.guard";
import { SessionGuard } from "../auth/session.guard";
import { EulaService } from "../marketplace/eula.service";
import {
  DAEMON_UNAVAILABLE_MESSAGE,
  WingsClientService,
  WingsUnavailableError,
} from "../wings/wings-client.service";
import { WingsTokenService } from "../wings/wings-token.service";
import { FileUploadService } from "./file-upload.service";
import { accessPrincipal, ServerAccessService } from "./server-access.service";
import { ServerPlayersService } from "./server-players.service";

type ClientRequest = AuthenticatedRequest & { ip?: string };

/**
 * Qui agit, et sous quelle restriction.
 *
 * Les deux champs voyagent ensemble jusqu'au contrôle d'accès : séparer
 * l'identité de ses portées ferait qu'un oubli donne à une clé d'API tous les
 * droits de son propriétaire.
 */
function principalOf(request: ClientRequest) {
  return accessPrincipal(request);
}

/** Un chemin passé en paramètre d'adresse ne s'y donne qu'une fois. */
const QUERY_PATH_MESSAGE = "Chemin invalide : un seul chemin est attendu.";

/**
 * Refuse, avant tout relais, un chemin qui remonterait au-dessus du volume ou
 * porterait un octet nul (`refusePath`). Les `paths` se lisent depuis `base`,
 * comme le daemon lit les entrées d'un `root`.
 *
 * Défense en profondeur : le confinement reste le travail de Wings (§4.3).
 * Mais le panel relayait tout, et la sûreté de chaque serveur tenait à une
 * seule ligne de défense, dans un programme qu'il ne contrôle pas.
 */
function confine(base: string, ...paths: string[]): void {
  const refus = [refusePath(base), ...paths.map((path) => refusePath(path, base))].find(
    (raison) => raison !== null,
  );
  if (refus) throw new BadRequestException(PATH_REFUSAL_MESSAGES[refus]);
}

/**
 * Ce qui ne peut venir que du daemon : état, consommation, fichiers, commandes.
 *
 * Chaque route vérifie d'abord la permission, puis relaie. L'ordre compte : une
 * vérification faite après l'appel aurait déjà laissé l'action se produire.
 */
@Controller("api/v1/client/servers/:id")
@UseGuards(SessionGuard, ImpersonationReadOnlyGuard)
export class ServerRuntimeController {
  private readonly logger = new Logger(ServerRuntimeController.name);

  constructor(
    @Inject(ServerAccessService) private readonly access: ServerAccessService,
    @Inject(WingsClientService) private readonly wings: WingsClientService,
    @Inject(EulaService) private readonly eula: EulaService,
    @Inject(WingsTokenService) private readonly tokens: WingsTokenService,
    @Inject(ActivityService) private readonly activity: ActivityService,
    // L'assembleur des envois reprenables : il garde les morceaux le temps de
    // les recoller, parce que le daemon ne sait pas écrire à un décalage.
    @Inject(FileUploadService) private readonly uploads: FileUploadService,
    @Inject(ServerPlayersService) private readonly players: ServerPlayersService,
  ) {}

  /**
   * État et consommation instantanée.
   *
   * La réponse de Wings est **filtrée**, pas transmise telle quelle : le daemon
   * y joint toute la configuration du serveur, variables d'environnement
   * comprises. C'est là que vivent les mots de passe RCON et les clés d'API des
   * eggs — les renvoyer au navigateur les exposerait à quiconque peut lire la
   * console, y compris un sous-utilisateur sans droit sur les variables de
   * démarrage.
   *
   * Les champs sont donc énumérés un par un. Un `delete configuration` ferait
   * le contraire : il laisserait passer tout champ que Wings ajouterait plus
   * tard, et c'est précisément ce genre d'ajout qui fuite sans qu'on le voie.
   */
  @Get("resources")
  async resources(@Req() request: ClientRequest, @Param("id") id: string) {
    await this.access.require(principalOf(request), id, "console.read");
    const raw = await this.relay(() => this.wings.resources(id));

    return {
      data: {
        state: raw.state,
        isSuspended: raw.is_suspended,
        cpuPct: raw.utilization.cpu_absolute,
        memoryBytes: raw.utilization.memory_bytes,
        memoryLimitBytes: raw.utilization.memory_limit_bytes,
        diskBytes: raw.utilization.disk_bytes,
        networkRxBytes: raw.utilization.network.rx_bytes,
        networkTxBytes: raw.utilization.network.tx_bytes,
        uptimeMs: raw.utilization.uptime,
      },
    };
  }

  @Post("power")
  async power(@Req() request: ClientRequest, @Param("id") id: string, @Body() body: unknown) {
    const parsed = PowerSignal.safeParse((body as { signal?: unknown })?.signal);
    if (!parsed.success) throw new BadRequestException("Signal d'alimentation inconnu.");

    // Une permission par signal : pouvoir démarrer un serveur ne doit pas
    // impliquer de pouvoir le tuer, qui fait perdre la sauvegarde en cours.
    await this.access.require(principalOf(request), id, `power.${parsed.data}` as never);
    // Avoir le droit de démarrer et pouvoir le faire maintenant sont deux
    // questions : une installation en cours empêche la seconde.
    await this.access.requireOperable(id);

    /*
     * Un serveur Minecraft dont le contrat n'est pas accepté ne démarre pas :
     * autant le dire ici plutôt que de le laisser tomber trois secondes plus
     * tard sur une ligne de console que personne ne lit.
     *
     * Seuls les signaux qui allument sont concernés — arrêter ou tuer un
     * serveur doit rester possible quoi qu'il arrive.
     */
    if (parsed.data === "start" || parsed.data === "restart") {
      await this.eula.requireAccepted(id);
    }

    await this.relay(() => this.wings.power(id, parsed.data));
    await this.log(request, id, "server.power", { signal: parsed.data });
    return { data: { signal: parsed.data } };
  }

  @Post("command")
  async command(@Req() request: ClientRequest, @Param("id") id: string, @Body() body: unknown) {
    const command = (body as { command?: unknown })?.command;
    if (typeof command !== "string" || command.trim() === "") {
      throw new BadRequestException("Commande vide.");
    }
    if (command.length > MAX_CONSOLE_COMMAND_LENGTH) {
      throw new BadRequestException(
        `Commande trop longue (${MAX_CONSOLE_COMMAND_LENGTH} caractères au plus).`,
      );
    }
    await this.access.require(principalOf(request), id, "console.send");
    await this.access.requireOperable(id);
    await this.relay(() => this.wings.sendCommand(id, command));
    // Le premier mot seulement, et la longueur du reste : « op » ou « ban »
    // sont ce qu'on veut retrouver dans un journal, mais c'est dans les
    // arguments que passent les mots de passe (`consoleCommandTrace`).
    await this.log(request, id, "server.command", { ...consoleCommandTrace(command) });
    return { data: { sent: true } };
  }

  /**
   * Joueurs connectés, lus dans la dernière sonde de jeu.
   *
   * Rien n'est demandé au daemon ni au jeu : la sonde tourne déjà chaque
   * minute, et ouvrir la page ne doit pas ajouter de trafic vers le serveur.
   */
  @Get("players")
  async listPlayers(@Req() request: ClientRequest, @Param("id") id: string) {
    await this.access.require(principalOf(request), id, "players.read");
    return { data: await this.players.view(id) };
  }

  /**
   * Expulser, bannir, gracier, gérer la liste blanche et les opérateurs.
   *
   * La commande vient de l'egg, jamais du client : il choisit une action et un
   * nom, et le panel écrit la ligne (`renderPlayerCommand`). Nommer un
   * opérateur exige en plus `console.send`, puisqu'un opérateur peut taper
   * n'importe quelle commande.
   *
   * Le journal garde l'action et le nom du joueur, contrairement aux commandes
   * libres dont seul le premier mot est consigné : ici il n'y a pas d'argument
   * libre où un mot de passe pourrait passer, et « qui a banni qui » est
   * précisément ce qu'on vient y chercher.
   */
  @Post("players")
  async playerAction(
    @Req() request: ClientRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const input = (body ?? {}) as { action?: unknown; player?: unknown; reason?: unknown };
    await this.access.require(principalOf(request), id, "players.manage");
    if (PRIVILEGED_PLAYER_ACTIONS.includes(input.action as never)) {
      await this.access.require(principalOf(request), id, "console.send");
    }
    const { action, player, command } = await this.players.command(
      id,
      input.action,
      input.player,
      input.reason,
    );
    await this.access.requireOperable(id);
    await this.relay(() => this.wings.sendCommand(id, command));
    await this.log(request, id, "server.player", { action, player });
    return { data: { action, player } };
  }

  /**
   * Autorisation d'ouvrir le websocket de console.
   *
   * Le navigateur se connecte **directement** au daemon : relayer un flux de
   * console par le panel en ferait un goulot d'étranglement, et le rendrait
   * responsable d'une panne qui n'est pas la sienne.
   *
   * Les permissions effectives sont scellées dans le jeton signé. Le navigateur
   * ne peut donc pas s'en attribuer d'autres : c'est Wings qui vérifie, avec la
   * liste que nous avons signée.
   *
   * **Le jeton ne sert qu'à lire** (`toWingsWebsocketPermissions`). Commandes
   * et signaux passent par `POST command` et `POST power`, qui vérifient que le
   * serveur peut obéir et consignent le geste ; les sceller ici en faisait une
   * seconde porte, qui ne vérifiait ni l'un ni l'autre.
   */
  @Post("websocket")
  async websocket(@Req() request: ClientRequest, @Param("id") id: string) {
    const principal = principalOf(request);
    const { isOwner } = await this.access.require(principal, id, "console.read");
    const granted = isOwner ? ["*"] : await this.access.permissionsFor(request.user.id, id);

    /*
     * Une clé d'API ne scelle jamais plus que ses portées. `require` a borné
     * cette requête, mais le jeton vit dix minutes sans repasser par ici : le
     * propriétaire y recevrait « * », donc le suivi des sauvegardes, alors que
     * sa clé ne porte que « console.read ». Les portées s'appliquent donc
     * aussi ici, en intersection pour un invité.
     */
    const permissions =
      principal.scopes === null
        ? granted
        : granted.includes("*")
          ? principal.scopes
          : granted.filter((permission) => principal.scopes?.includes(permission));

    /*
     * La sortie d'installation, pour qui a le droit de la lire.
     *
     * **Relevé dans la source de Wings** : `HasPermission` exclut les
     * permissions `admin.*` du joker — `k == "*"` ne compte que si la
     * permission demandée ne commence pas par « admin ». Un propriétaire
     * scellé avec « * » ne recevait donc **rien** de l'installation, et
     * l'écran n'avait aucune progression à montrer. Il faut la nommer.
     *
     * Elle va au propriétaire et au personnel qui héberge, et à eux seuls :
     *
     * - le **propriétaire** attend cette installation, et les variables que le
     *   script peut recopier dans sa sortie sont celles de son propre serveur ;
     * - un **sous-utilisateur**, non : il peut être invité sans voir les
     *   variables masquées de l'egg, et un script qui en recopie une les lui
     *   livrerait par la bande.
     *
     * `isOwner` vaut ici « tous les droits », ce qui couvre le personnel
     * autorisé à gérer — c'est le même drapeau qui décide du joker.
     */
    const withInstall = isOwner ? [...permissions, "admin.websocket.install"] : permissions;

    // La session qui demande est rangée avec le jeton : sa déconnexion fermera
    // cette console (NC-43). Une clé d'API n'en a pas.
    return {
      data: await this.tokens.websocketGrant(
        id,
        request.user.id,
        withInstall,
        request.sessionToken ?? null,
      ),
    };
  }

  @Get("files")
  async files(
    @Req() request: ClientRequest,
    @Param("id") id: string,
    @Query("directory") directory?: unknown,
  ) {
    const dossier = directory ?? "/";
    // Un paramètre répété (`?directory=a&directory=b`) arrive en tableau : il
    // faisait tomber `refusePath` en erreur 500 au lieu d'un refus.
    if (typeof dossier !== "string") throw new BadRequestException(QUERY_PATH_MESSAGE);
    // Wings confine le chemin au volume du serveur, et c'est lui qui fait foi
    // (§4.3). Le panel refuse seulement ce qui n'a rien à y faire — sortie du
    // volume, octet nul —, en seconde ligne.
    confine(dossier);
    await this.access.require(principalOf(request), id, "files.read");
    return { data: await this.relay(() => this.wings.listDirectory(id, dossier)) };
  }

  @Get("files/contents")
  async fileContents(
    @Req() request: ClientRequest,
    @Param("id") id: string,
    @Query("file") file?: unknown,
  ) {
    if (!file) throw new BadRequestException("Chemin de fichier manquant.");
    if (typeof file !== "string") throw new BadRequestException(QUERY_PATH_MESSAGE);
    confine(file);
    await this.access.require(principalOf(request), id, "files.read");
    return { data: { content: await this.relay(() => this.wings.readFile(id, file)) } };
  }

  /**
   * Écriture d'un fichier.
   *
   * Permission distincte de la lecture : donner à quelqu'un le droit de
   * consulter les journaux ne doit pas lui donner celui de réécrire la
   * configuration du serveur.
   */
  @Post("files/write")
  async writeFile(
    @Req() request: ClientRequest,
    @Param("id") id: string,
    @Query("file") file: unknown,
    @Body() body: unknown,
  ) {
    if (!file) throw new BadRequestException("Chemin de fichier manquant.");
    if (typeof file !== "string") throw new BadRequestException(QUERY_PATH_MESSAGE);
    const content = (body as { content?: unknown })?.content;
    if (typeof content !== "string") throw new BadRequestException("Contenu manquant.");
    confine(file);

    await this.access.require(principalOf(request), id, "files.write");
    await this.access.requireOperable(id);
    await this.relay(() => this.wings.writeFile(id, file, content));
    await this.log(request, id, "files.write", { file });
    return { data: { written: true } };
  }

  @Post("files/create-directory")
  async createDirectory(
    @Req() request: ClientRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const { root, name } = (body ?? {}) as { root?: unknown; name?: unknown };
    if (typeof root !== "string" || typeof name !== "string" || name.trim() === "") {
      throw new BadRequestException("Dossier ou nom manquant.");
    }
    confine(root, name);
    await this.access.require(principalOf(request), id, "files.write");
    await this.access.requireOperable(id);
    await this.relay(() => this.wings.createDirectory(id, root, name));
    await this.log(request, id, "files.create-directory", { root, name });
    return { data: { created: name } };
  }

  /**
   * Renommer ou déplacer.
   *
   * `to` est relatif à `root`, comme `from` : un chemin avec des « / » déplace
   * l'entrée, et c'est le daemon qui confine le résultat au volume. La cible
   * est vérifiée par la règle partagée avec l'écran (`RenameRequest`) : un nom
   * vide ou terminé par « / » partait tel quel, et le daemon le lisait
   * autrement que la personne qui l'avait tapé.
   */
  @Post("files/rename")
  async renameFile(@Req() request: ClientRequest, @Param("id") id: string, @Body() body: unknown) {
    const parsed = RenameRequest.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? "Renommage incomplet.");
    }
    const { root, from, to } = parsed.data;
    confine(root, from, to);
    await this.access.require(principalOf(request), id, "files.write");
    await this.access.requireOperable(id);
    try {
      await this.relay(() => this.wings.renameFile(id, root, from, to));
    } catch (error) {
      /*
       * La collision est le refus le plus courant, et le daemon l'écrit en
       * anglais dans un 400 générique. Elle devient un 409 en français, qui
       * nomme la cible : l'écran peut la reconnaître sans lire la phrase.
       */
      if (error instanceof BadRequestException && error.message === WINGS_RENAME_COLLISION) {
        throw new ConflictException(`« ${to} » existe déjà dans ce dossier.`);
      }
      throw error;
    }
    await this.log(request, id, "files.rename", { root, from, to });
    return { data: { renamed: to } };
  }

  /**
   * Permissions d'entrées (chmod).
   *
   * `files.write`, comme le renommage et l'écriture : changer un mode modifie
   * le volume au même titre, et un `chmod 000` sur `server.properties` empêche
   * le serveur de démarrer aussi sûrement qu'une réécriture ratée. En faire une
   * permission à part ajouterait un interrupteur que personne ne sait régler
   * différemment de `files.write`.
   *
   * Le mode est validé ici (`ChmodRequest`) et non chez le daemon, qui ne
   * filtre rien : c'est ce qui refuse setuid, setgid et le bit collant.
   */
  @Post("files/chmod")
  async chmodFiles(@Req() request: ClientRequest, @Param("id") id: string, @Body() body: unknown) {
    const parsed = ChmodRequest.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? "Permissions invalides.");
    }
    const { root, files } = parsed.data;
    confine(root, ...files.map((entry) => entry.file));
    await this.access.require(principalOf(request), id, "files.write");
    await this.access.requireOperable(id);
    await this.relay(() => this.wings.chmodFiles(id, root, files));
    await this.log(request, id, "files.chmod", { root, files });
    return { data: { changed: files.length } };
  }

  /**
   * Suppression.
   *
   * Permission à part entière : `files.write` permet de corriger un fichier,
   * `files.delete` d'en faire disparaître. Sur un serveur de jeu, la seconde
   * efface des mondes entiers — elle mérite d'être accordée séparément.
   */
  @Post("files/delete")
  async deleteFiles(@Req() request: ClientRequest, @Param("id") id: string, @Body() body: unknown) {
    const { root, files } = (body ?? {}) as { root?: unknown; files?: unknown };
    if (typeof root !== "string" || !Array.isArray(files) || files.length === 0) {
      throw new BadRequestException("Rien à supprimer.");
    }
    confine(root, ...files.map(String));
    await this.access.require(principalOf(request), id, "files.delete");
    await this.access.requireOperable(id);
    await this.relay(() => this.wings.deleteFiles(id, root, files.map(String)));
    await this.log(request, id, "files.delete", { root, files: files.map(String) });
    return { data: { deleted: files.length } };
  }

  /**
   * Adresse de téléchargement d'un fichier.
   *
   * Rendue plutôt que suivie, comme pour les sauvegardes : le panel ne relaie
   * pas les octets, le navigateur va les chercher lui-même chez le daemon.
   *
   * `files.read` — la même permission que pour afficher le contenu d'un
   * fichier dans l'éditeur. Tirer le fichier ou le lire à l'écran donne accès
   * aux mêmes octets ; en faire deux droits distincts laisserait croire qu'on
   * peut accorder l'un en refusant l'autre.
   */
  @Get("files/download")
  async downloadFile(
    @Req() request: ClientRequest,
    @Param("id") id: string,
    @Query("file") file?: unknown,
  ) {
    if (!file) throw new BadRequestException("Chemin de fichier manquant.");
    if (typeof file !== "string") throw new BadRequestException(QUERY_PATH_MESSAGE);
    // Le chemin est scellé dans le jeton que le daemon honorera : c'est le
    // dernier moment où le panel peut le refuser.
    confine(file);
    await this.access.require(principalOf(request), id, "files.read");
    // L'identité vient de la session, jamais de l'URL : le jeton remis au
    // daemon porte le compte au nom duquel le fichier est tiré.
    const url = await this.tokens.fileDownloadGrant(id, request.user.id, file);
    await this.log(request, id, "files.download", { file });
    return { data: { url } };
  }

  /**
   * Autorisation d'envoyer des fichiers, à présenter au daemon.
   *
   * La route ne reçoit **aucun fichier** : elle rend une adresse et un jeton,
   * et le navigateur dépose directement chez Wings. Faire transiter l'envoi
   * par le panel doublerait le trajet réseau d'un modpack et occuperait le
   * processus du panel pendant tout ce temps, pour des octets qu'il n'a
   * aucune raison de lire.
   *
   * `files.write` : déposer un fichier, c'est écrire dans le volume. La
   * permission est la même que pour l'édition — un envoi qui écrase
   * `server.properties` fait exactement ce qu'une écriture ferait.
   */
  @Post("files/upload-grant")
  async uploadGrant(@Req() request: ClientRequest, @Param("id") id: string) {
    await this.access.require(principalOf(request), id, "files.write");
    /*
     * Refusé pendant une installation, comme toute écriture de ce contrôleur.
     *
     * « Comme toute écriture » était une intention et non un fait : cette
     * route était la seule gardée. Écrire, renommer, supprimer et compresser
     * partaient sans rien demander — dans un conteneur que le daemon est en
     * train de peupler, ou sur le disque d'un serveur suspendu.
     */
    await this.access.requireOperable(id);

    const grant = await this.tokens.uploadGrant(id, request.user.id);
    await this.log(request, id, "files.upload-grant", {});
    return { data: grant };
  }

  /* --- Envoi reprenable ---------------------------------------------------- */
  /*
   * Quatre routes pour un seul geste, et c'est le prix de la reprise.
   *
   * L'envoi direct au daemon reste là, au-dessus : il est plus court et
   * convient aux petits fichiers. Celui-ci existe pour ceux dont la perte au
   * bout de deux gigaoctets n'est pas acceptable. Le panel garde les morceaux
   * le temps de les assembler, parce que Wings — non modifié — ne sait pas
   * écrire à un décalage.
   *
   * La permission `files.write` est exigée **à chaque appel** et non seulement
   * à l'ouverture : une session ouverte alors qu'on avait le droit ne doit pas
   * survivre au retrait de ce droit.
   */

  @Post("files/uploads")
  async openUpload(@Req() request: ClientRequest, @Param("id") id: string, @Body() body: unknown) {
    await this.access.require(principalOf(request), id, "files.write");
    await this.access.requireOperable(id);

    const payload = (body ?? {}) as { directory?: unknown; fileName?: unknown; size?: unknown };
    if (typeof payload.fileName !== "string" || payload.fileName.trim() === "") {
      throw new BadRequestException("Nom de fichier manquant.");
    }
    if (typeof payload.size !== "number") throw new BadRequestException("Taille manquante.");
    const directory = typeof payload.directory === "string" ? payload.directory : "/";
    confine(directory);

    const session = await this.uploads.open(id, request.user.id, {
      directory,
      fileName: payload.fileName,
      size: payload.size,
    });
    return { data: session };
  }

  /**
   * Où en est la session.
   *
   * **C'est cette route qui rend l'envoi reprenable** : après une coupure, ou
   * même après avoir fermé l'onglet, le navigateur demande ce qui est arrivé
   * et ne renvoie que le reste.
   */
  @Get("files/uploads/:uploadId")
  async uploadStatus(
    @Req() request: ClientRequest,
    @Param("id") id: string,
    @Param("uploadId") uploadId: string,
  ) {
    await this.access.require(principalOf(request), id, "files.write");
    return { data: await this.uploads.status(uploadId, id, request.user.id) };
  }

  @Post("files/uploads/:uploadId/:index")
  async putChunk(
    @Req() request: ClientRequest,
    @Param("id") id: string,
    @Param("uploadId") uploadId: string,
    @Param("index") index: string,
    @Body() body: unknown,
  ) {
    await this.access.require(principalOf(request), id, "files.write");
    await this.access.requireOperable(id);

    // Fastify rend le corps brut tel quel pour `application/octet-stream` ;
    // tout autre type signifie que le navigateur n'a pas envoyé un morceau.
    // `typeof` en premier pour CodeQL, qui ne lit pas `Buffer.isBuffer` comme
    // une garde et signalait chaque `.length` du service (voir `checkedImage`).
    if (typeof body !== "object" || !Buffer.isBuffer(body)) {
      throw new BadRequestException("Morceau illisible.");
    }

    const resultat = await this.uploads.putChunk(
      uploadId,
      id,
      request.user.id,
      Number(index),
      body,
    );
    return { data: resultat };
  }

  @Post("files/uploads/:uploadId/complete")
  async completeUpload(
    @Req() request: ClientRequest,
    @Param("id") id: string,
    @Param("uploadId") uploadId: string,
  ) {
    await this.access.require(principalOf(request), id, "files.write");
    await this.access.requireOperable(id);

    const resultat = await this.relay(() => this.uploads.complete(uploadId, id, request.user.id));
    await this.log(request, id, "files.upload", { file: resultat.file });
    return { data: resultat };
  }

  @Delete("files/uploads/:uploadId")
  async discardUpload(
    @Req() request: ClientRequest,
    @Param("id") id: string,
    @Param("uploadId") uploadId: string,
  ) {
    await this.access.require(principalOf(request), id, "files.write");
    // La session est relue d'abord : sans cela, cette route effacerait le
    // dossier de n'importe quelle session dont on devinerait l'identifiant.
    await this.uploads.status(uploadId, id, request.user.id);
    await this.uploads.discard(uploadId);
    return { data: { discarded: true } };
  }

  /**
   * Compresse une sélection en une archive, sur place.
   *
   * `files.archive` était **déclarée et jamais exigée** : la permission
   * figurait au catalogue, s'affichait dans l'écran des sous-utilisateurs, et
   * n'ouvrait rien — aucune route ne compressait quoi que ce soit. Un
   * interrupteur qui n'allume rien est pire qu'un interrupteur absent : on
   * croit avoir donné un droit, ou l'avoir refusé.
   *
   * Elle suffit ici, sans `files.write` : c'est exactement la distinction
   * qu'elle porte — pouvoir empaqueter un dossier sans pouvoir en modifier le
   * contenu. Le nom de l'archive est choisi par Wings et rendu tel quel ; le
   * panel ne le devine pas.
   */
  @Post("files/compress")
  async compressFiles(
    @Req() request: ClientRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const { root, files } = (body ?? {}) as { root?: unknown; files?: unknown };
    if (typeof root !== "string" || !Array.isArray(files) || files.length === 0) {
      throw new BadRequestException("Rien à compresser.");
    }
    confine(root, ...files.map(String));
    await this.access.require(principalOf(request), id, "files.archive");
    await this.access.requireOperable(id);
    const entry = await this.relay(() => this.wings.compressFiles(id, root, files.map(String)));
    await this.log(request, id, "files.compress", { root, files: files.map(String) });
    return { data: { name: entry.name, size: entry.size } };
  }

  /**
   * Extrait une archive dans le dossier où elle se trouve.
   *
   * Une seule archive à la fois, et c'est le contrat du daemon : il vérifie la
   * place disponible avant d'extraire, et refuse un format qu'il ne sait pas
   * lire. Ses deux refus reviennent en 400 avec un message exploitable —
   * « format inconnu », « fichier en cours d'utilisation » — que `relay`
   * laisse remonter plutôt que de les remplacer par une panne générique.
   */
  @Post("files/decompress")
  async decompressFile(
    @Req() request: ClientRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const { root, file } = (body ?? {}) as { root?: unknown; file?: unknown };
    if (typeof root !== "string" || typeof file !== "string" || file.trim() === "") {
      throw new BadRequestException("Archive manquante.");
    }
    confine(root, file);
    await this.access.require(principalOf(request), id, "files.archive");
    await this.access.requireOperable(id);
    await this.relay(() => this.wings.decompressFile(id, root, file));
    await this.log(request, id, "files.decompress", { root, file });
    return { data: { extracted: file } };
  }

  /**
   * Traduit une panne du daemon en 503.
   *
   * Un node injoignable n'est pas une erreur du panel : le distinguer permet à
   * l'interface de dire « ce node ne répond pas » plutôt que d'afficher une
   * erreur générique qui laisse croire à un bogue du panel.
   */
  /**
   * Consigne une action. Voir `ServerFeaturesController.log`.
   *
   * Dupliqué plutôt que partagé : le rendre commun demanderait une classe de
   * base entre deux contrôleurs qui nont pas dautre raison dêtre parents,
   * et NestJS résout linjection par constructeur — un héritage ici rendrait
   * les dépendances de chacun moins lisibles quun doublon de six lignes.
   */
  private async log(
    request: ClientRequest,
    serverId: string,
    event: string,
    properties: Record<string, unknown>,
  ): Promise<void> {
    await this.activity.record({
      event,
      serverId,
      actorId: request.user.id,
      actorType: request.scopes === null ? "user" : "api_key",
      actorLabel: await this.activity.labelFor(request.user.id),
      ip: request.ip ?? null,
      // L'agent d'une prise en main est nommé : voir `withImpersonator`.
      properties: withImpersonator(request, properties),
    });
  }

  private async relay<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof WingsUnavailableError) {
        /*
         * Un refus n'est pas une panne, et ne doit pas se lire comme telle.
         *
         * Le daemon écrit des refus exploitables — « cette archive est dans un
         * format que Wings ne comprend pas », « un fichier de cette archive
         * est en cours d'utilisation ». Les rendre en 503 « le node n'a pas
         * répondu » disait deux mensonges d'un coup : que le node est en
         * panne, et qu'il suffit de réessayer. Le message du daemon passe donc
         * tel quel, en 400.
         */
        if (error.isRefusal && error.detail) throw new BadRequestException(error.detail);
        // Nom interne du node et cause brute pour l'exploitant, une phrase pour
        // le client : voir `DAEMON_UNAVAILABLE_MESSAGE`.
        this.logger.warn(`Relais vers le daemon : ${error.message}`);
        throw new ServiceUnavailableException(DAEMON_UNAVAILABLE_MESSAGE);
      }
      throw error;
    }
  }
}
