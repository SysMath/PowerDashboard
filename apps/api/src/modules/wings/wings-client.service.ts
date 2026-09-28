import http from "node:http";
import https from "node:https";
import type { Readable } from "node:stream";
import { type Database, nodes, servers } from "@gamedashboard/db";
import { Inject, Injectable, InternalServerErrorException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DATABASE } from "../../common/database.provider";
import { decryptRowSecret } from "../../common/row-secrets";

/**
 * Client HTTP vers Wings (§7.4 du plan).
 *
 * Le panel est ici *appelant*, à l'inverse du module `remote` où il est
 * appelé. Les deux sens sont séparés volontairement : ils n'ont ni le même
 * sens d'authentification, ni le même format d'erreur, et les mêler rendrait
 * incompréhensible le fait qu'un jeton serve tantôt à vérifier, tantôt à
 * présenter.
 */

export class WingsUnavailableError extends Error {
  constructor(
    readonly nodeName: string,
    cause: string,
    /**
     * Code HTTP rendu par le daemon, ou `null` s'il n'a pas répondu du tout.
     *
     * La distinction compte : « le daemon dit que ce serveur n'existe pas » et
     * « le daemon est injoignable » demandent des décisions opposées. Sans ce
     * champ, l'appelant ne peut que traiter les deux pareil — et l'un des deux
     * traitements est toujours le mauvais.
     */
    readonly status: number | null = null,
    /**
     * Le message que le daemon a lui-même écrit, quand il en écrit un.
     *
     * Wings refuse certaines demandes pour des raisons parfaitement claires —
     * « cette archive est dans un format que Wings ne comprend pas », « un
     * fichier de cette archive est en cours d'utilisation ». Sans ce champ,
     * tout ce qui remontait était « HTTP 400 », et le client lisait « le node
     * n'a pas répondu » alors que le node avait répondu, et bien répondu.
     */
    readonly detail: string | null = null,
  ) {
    super(`Le node « ${nodeName} » n'a pas répondu : ${cause}`);
    this.name = "WingsUnavailableError";
  }

  /** Le daemon a répondu, et il ne connaît pas cette ressource. */
  get isNotFound(): boolean {
    return this.status === 404;
  }

  /**
   * Le daemon a compris la demande et l'a refusée.
   *
   * À distinguer d'une panne : ce n'est pas au client de réessayer plus tard,
   * c'est à lui de demander autre chose. Les deux méritent donc deux codes
   * différents côté panel — 400 ici, 503 pour l'indisponibilité.
   */
  get isRefusal(): boolean {
    return this.status === 400;
  }
}

/**
 * Ce qu'un client lit quand le daemon ne répond pas, ou répond mal.
 *
 * Le message de `WingsUnavailableError` est écrit pour l'exploitant : il nomme
 * le node par son nom interne et donne la cause brute — `connect ECONNREFUSED
 * 10.0.0.5:8080`, soit l'adresse privée de la machine et le port du daemon.
 * Relayé tel quel, il partait au navigateur ou à la boutique d'un revendeur.
 * Le client a besoin de savoir que la machine ne répond pas et qu'il peut
 * réessayer ; la cause va au journal du processus (`Logger`), où l'on cherche
 * une panne.
 *
 * Un refus que le daemon a écrit pour être lu (`isRefusal` avec `detail`) n'est
 * pas concerné : il dit quoi changer, et il est relayé en 400.
 */
export const DAEMON_UNAVAILABLE_MESSAGE =
  "La machine qui héberge ce serveur n'a pas répondu. Réessayez dans un instant.";

export interface WingsResources {
  state: string;
  is_suspended: boolean;
  utilization: {
    memory_bytes: number;
    memory_limit_bytes: number;
    cpu_absolute: number;
    disk_bytes: number;
    network: { rx_bytes: number; tx_bytes: number };
    uptime: number;
  };
}

/**
 * Entrée de répertoire, telle que Wings la renvoie réellement.
 *
 * Les noms sont ceux observés sur le daemon en fonctionnement, et non ceux de
 * ses structures Go : le sérialiseur les expose en `directory` / `file`, pas
 * en `is_directory` / `is_file`. Se tromper ici ne produit aucune erreur — les
 * champs valent simplement `undefined`, et tout finit classé du même côté.
 */
export interface WingsDirectoryEntry {
  name: string;
  mode: string;
  mode_bits: string;
  size: number;
  directory: boolean;
  file: boolean;
  symlink: boolean;
  mime: string;
  created: string;
  modified: string;
}

/** UUID version 4 : chiffre de version `4`, variante `8`, `9`, `a` ou `b`. */
export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface NodeEndpoint {
  baseUrl: string;
  token: string;
  nodeName: string;
}

@Injectable()
export class WingsClientService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Coordonnées du daemon hébergeant un serveur.
   *
   * L'adresse est reconstruite depuis la base et jamais reçue de l'appelant :
   * sinon une requête pourrait faire interroger n'importe quelle machine par
   * le panel, qui deviendrait un relais de requêtes vers le réseau interne.
   */
  private async endpointFor(serverId: string): Promise<NodeEndpoint> {
    const [row] = await this.db
      .select({
        nodeId: nodes.id,
        scheme: nodes.scheme,
        fqdn: nodes.fqdn,
        port: nodes.daemonPort,
        token: nodes.daemonTokenEnc,
        nodeName: nodes.name,
      })
      .from(servers)
      .innerJoin(nodes, eq(servers.nodeId, nodes.id))
      .where(eq(servers.id, serverId))
      .limit(1);

    if (!row) throw new InternalServerErrorException("Serveur introuvable.");

    return {
      baseUrl: `${row.scheme}://${row.fqdn}:${row.port}`,
      token: decryptRowSecret("nodes.daemon_token_enc", row.nodeId, row.token),
      nodeName: row.nodeName,
    };
  }

  /**
   * L'adresse d'un node **nommé**, et non celle du node d'un serveur.
   *
   * Il n'en existait pas, et tous les appels partaient vers « le node de ce
   * serveur ». Après un transfert, cette phrase ne désigne plus la machine de
   * départ : c'est précisément là qu'il faut pouvoir frapper pour lui dire de
   * retirer sa copie.
   */
  private async endpointForNode(nodeId: string): Promise<NodeEndpoint> {
    const [row] = await this.db
      .select({
        nodeId: nodes.id,
        scheme: nodes.scheme,
        fqdn: nodes.fqdn,
        port: nodes.daemonPort,
        token: nodes.daemonTokenEnc,
        nodeName: nodes.name,
      })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .limit(1);

    if (!row) throw new InternalServerErrorException("Node introuvable.");

    return {
      baseUrl: `${row.scheme}://${row.fqdn}:${row.port}`,
      token: decryptRowSecret("nodes.daemon_token_enc", row.nodeId, row.token),
      nodeName: row.nodeName,
    };
  }

  /**
   * Retire un serveur d'une machine **précise**, volume compris.
   *
   * Employé après un transfert réussi, sur le node de départ. `deleteServer`
   * ne conviendrait pas : il vise le node inscrit sur le serveur, qui est
   * déjà celui d'arrivée — l'appeler effacerait la copie qu'on vient de
   * recevoir.
   *
   * **Relevé en transférant un serveur entre deux daemons** : sans cet appel,
   * le volume restait sur la machine d'origine. De l'espace occupé que plus
   * rien ne rattache à personne, et une copie des fichiers du client là où il
   * ne s'attend plus à les trouver.
   */
  async deleteServerOnNode(serverId: string, nodeId: string): Promise<void> {
    const endpoint = await this.endpointForNode(nodeId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);

    try {
      const response = await fetch(`${endpoint.baseUrl}/api/servers/${serverId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${endpoint.token}`, Accept: "application/json" },
        signal: controller.signal,
      });
      // Un 404 est une réussite : le node ne connaît plus ce serveur, ce qui
      // est exactement l'état recherché.
      if (!response.ok && response.status !== 404) {
        throw new Error(`le node ${endpoint.nodeName} a répondu ${response.status}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Appel au daemon.
   *
   * Le délai d'attente est court et explicite : sans lui, un node injoignable
   * bloquerait le rendu de la page jusqu'au délai par défaut du système, et
   * l'utilisateur verrait une page qui ne charge pas plutôt qu'un message
   * disant que le node ne répond pas.
   */
  private async call<T>(
    serverId: string,
    path: string,
    init: { method?: string; body?: unknown; rawBody?: string; timeoutMs?: number } = {},
  ): Promise<T> {
    const endpoint = await this.endpointFor(serverId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 8000);

    try {
      const response = await fetch(`${endpoint.baseUrl}${path}`, {
        method: init.method ?? "GET",
        headers: {
          Authorization: `Bearer ${endpoint.token}`,
          Accept: "application/json",
          ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
          // Wings écrit le corps tel quel dans le fichier : le déclarer en JSON
          // ferait enregistrer des guillemets et des échappements.
          ...(init.rawBody === undefined ? {} : { "Content-Type": "text/plain" }),
        },
        body: init.rawBody ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
        signal: controller.signal,
      });

      if (!response.ok) {
        /*
         * On lit le corps du refus avant de le jeter.
         *
         * Wings répond à ses refus par `{"error": "…"}`, en une phrase écrite
         * pour être montrée. La perdre transformait un diagnostic précis en
         * « HTTP 400 », et faisait chercher une panne de node là où il n'y
         * avait qu'une demande invalide. Cette lecture ne peut pas faire
         * échouer l'appel : un corps illisible rend simplement `null`.
         */
        let detail: string | null = null;
        try {
          const raw = await response.text();
          const parsed = raw.trim() === "" ? null : (JSON.parse(raw) as { error?: unknown });
          if (typeof parsed?.error === "string" && parsed.error.trim() !== "")
            detail = parsed.error;
        } catch {
          detail = null;
        }

        throw new WingsUnavailableError(
          endpoint.nodeName,
          `HTTP ${response.status}`,
          response.status,
          detail,
        );
      }

      /**
       * Corps vide : le daemon a accepté sans rien renvoyer.
       *
       * Ne pas se fier au seul code 204 — observé sur le daemon réel, une
       * commande d'alimentation répond **202** avec un corps vide, et
       * `response.json()` échoue alors sur « Unexpected end of JSON input ».
       * L'erreur remonte en « le node n'a pas répondu », ce qui est faux : il a
       * parfaitement répondu, et a même exécuté la commande.
       *
       * On décide donc sur le contenu réel plutôt que sur une liste de codes.
       */
      const body = await response.text();
      if (body.trim() === "") return undefined as T;
      return JSON.parse(body) as T;
    } catch (error) {
      if (error instanceof WingsUnavailableError) throw error;
      const cause = error instanceof Error ? error.message : "erreur inconnue";
      throw new WingsUnavailableError(endpoint.nodeName, cause);
    } finally {
      clearTimeout(timer);
    }
  }

  /** État et consommation instantanée. C'est la seule source de ces mesures. */
  resources(serverId: string): Promise<WingsResources> {
    return this.call<WingsResources>(serverId, `/api/servers/${serverId}`);
  }

  /** `start`, `stop`, `restart` ou `kill`. Wings répond 204 sans corps. */
  power(serverId: string, signal: string): Promise<void> {
    return this.call<void>(serverId, `/api/servers/${serverId}/power`, {
      method: "POST",
      body: { action: signal },
      // Un arrêt propre peut prendre du temps côté jeu ; le daemon accuse
      // pourtant réception tout de suite, d'où un délai court ici aussi.
      timeoutMs: 10_000,
    });
  }

  /**
   * Ordonne au node de départ d'expédier le serveur.
   *
   * L'appel rend la main tout de suite : le daemon arrête le conteneur, fabrique
   * l'archive et la pousse en tâche de fond, puis rapporte l'issue au panel sur
   * `/api/remote/servers/:uuid/transfer/:state`. Attendre ici la fin du
   * transfert ferait tenir une requête HTTP ouverte pendant une heure.
   *
   * `start_on_completion` est faux : c'est au panel de décider ce qui redémarre,
   * après avoir basculé le serveur sur son nouveau node. Un daemon qui
   * relancerait de lui-même ferait tourner le serveur sur une machine que la
   * base ne désigne pas encore.
   */
  startTransfer(serverId: string, grant: { url: string; token: string }): Promise<void> {
    return this.call<void>(serverId, `/api/servers/${serverId}/transfer`, {
      method: "POST",
      body: {
        url: grant.url,
        token: grant.token,
        server: { uuid: serverId, start_on_completion: false },
      },
      // Le daemon doit arrêter le conteneur avant de répondre : un arrêt propre
      // de serveur de jeu prend parfois une dizaine de secondes.
      timeoutMs: 30_000,
    });
  }

  /** Interrompt un transfert en cours sur le node de départ. */
  cancelTransfer(serverId: string): Promise<void> {
    return this.call<void>(serverId, `/api/servers/${serverId}/transfer`, { method: "DELETE" });
  }

  sendCommand(serverId: string, command: string): Promise<void> {
    return this.call<void>(serverId, `/api/servers/${serverId}/commands`, {
      method: "POST",
      body: { commands: [command] },
    });
  }

  listDirectory(serverId: string, directory: string): Promise<WingsDirectoryEntry[]> {
    const query = new URLSearchParams({ directory });
    return this.call<WingsDirectoryEntry[]>(
      serverId,
      `/api/servers/${serverId}/files/list-directory?${query}`,
    );
  }

  /**
   * Contenu d'un fichier, en texte brut.
   *
   * Le daemon ne renvoie pas de JSON ici : `call` détecte un corps non JSON et
   * échouerait. On passe donc par un appel dédié qui lit le texte tel quel.
   */
  readFile(serverId: string, file: string): Promise<string> {
    const query = new URLSearchParams({ file });
    return this.callText(serverId, `/api/servers/${serverId}/files/contents?${query}`);
  }

  writeFile(serverId: string, file: string, content: string): Promise<void> {
    const query = new URLSearchParams({ file });
    return this.call<void>(serverId, `/api/servers/${serverId}/files/write?${query}`, {
      method: "POST",
      rawBody: content,
      // Un fichier de configuration de plusieurs mégaoctets s'écrit moins vite
      // qu'un listage : le délai par défaut serait trop court.
      timeoutMs: 30_000,
    });
  }

  /**
   * Écrit un fichier **en flux**, sans jamais le tenir en mémoire.
   *
   * `fetch` ne convient pas ici, et pas par préférence de style : avec un
   * corps en flux, il envoie en `transfer-encoding: chunked`, donc sans
   * `Content-Length`. Or Wings refuse explicitement une écriture dont la
   * longueur est inconnue — « Missing Content-Length », un 400 qui ressemble à
   * une demande mal formée alors que le corps est parfait. On descend donc au
   * module HTTP de Node, qui laisse poser l'en-tête et pousser le flux.
   *
   * Aucun délai d'attente global : la durée dépend de la taille du fichier, et
   * un plafond fixe couperait précisément les envois pour lesquels ce chemin
   * existe. La coupure vient du socket si le node cesse de répondre.
   */
  async writeFileStream(
    serverId: string,
    file: string,
    size: number,
    body: Readable,
  ): Promise<void> {
    const endpoint = await this.endpointFor(serverId);
    const url = new URL(
      `${endpoint.baseUrl}/api/servers/${serverId}/files/write?${new URLSearchParams({ file })}`,
    );
    const transport = url.protocol === "https:" ? https : http;

    await new Promise<void>((resolve, reject) => {
      const requete = transport.request(
        url,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${endpoint.token}`,
            // Wings écrit le corps tel quel : annoncer du JSON ferait
            // enregistrer des guillemets et des échappements.
            "Content-Type": "application/octet-stream",
            "Content-Length": size,
          },
        },
        (reponse) => {
          const morceaux: Buffer[] = [];
          reponse.on("data", (bloc: Buffer) => {
            // Le refus de Wings tient en une phrase ; on garde de quoi la
            // lire sans risquer d'accumuler une réponse inattendue.
            if (morceaux.length < 16) morceaux.push(bloc);
          });
          reponse.on("end", () => {
            const code = reponse.statusCode ?? 0;
            if (code >= 200 && code < 300) {
              resolve();
              return;
            }
            let detail: string | null = null;
            try {
              const parsed = JSON.parse(Buffer.concat(morceaux).toString("utf8")) as {
                error?: unknown;
              };
              if (typeof parsed.error === "string") detail = parsed.error;
            } catch {
              detail = null;
            }
            reject(new WingsUnavailableError(endpoint.nodeName, `HTTP ${code}`, code, detail));
          });
        },
      );

      requete.on("error", (cause: Error) =>
        reject(new WingsUnavailableError(endpoint.nodeName, cause.message)),
      );
      // Une lecture qui échoue en cours de route doit abandonner la requête :
      // sans cela, Wings attendrait les octets annoncés jusqu'à son propre
      // délai, et le fichier resterait à moitié écrit dans le volume.
      body.on("error", (cause: Error) => {
        requete.destroy(cause);
        reject(new WingsUnavailableError(endpoint.nodeName, cause.message));
      });

      body.pipe(requete);
    });
  }

  createDirectory(serverId: string, root: string, name: string): Promise<void> {
    return this.call<void>(serverId, `/api/servers/${serverId}/files/create-directory`, {
      method: "POST",
      body: { root, name },
    });
  }

  /** `root` est le dossier, `files` les entrées à supprimer, relatives à lui. */
  deleteFiles(serverId: string, root: string, files: string[]): Promise<void> {
    return this.call<void>(serverId, `/api/servers/${serverId}/files/delete`, {
      method: "POST",
      body: { root, files },
    });
  }

  /**
   * Compresse des entrées en une archive, **dans le conteneur**.
   *
   * L'archive est fabriquée par le daemon et reste chez lui : elle n'a aucune
   * raison de traverser le panel, et un dossier de plusieurs gigaoctets le
   * ferait deux fois. Wings rend la description du fichier créé — c'est de là
   * que vient son nom, choisi par lui et non par nous.
   */
  compressFiles(serverId: string, root: string, files: string[]): Promise<WingsDirectoryEntry> {
    // Wings rend un `filesystem.Stat` : la même description qu'une entrée de
    // listage, ce qui évite un second type pour la même chose.
    return this.call<WingsDirectoryEntry>(serverId, `/api/servers/${serverId}/files/compress`, {
      method: "POST",
      body: { root, files },
      // Même délai que l'extraction, et pour la même raison : empaqueter le
      // monde d'un serveur prend des dizaines de secondes, et couper au bout
      // de huit laisserait une archive tronquée sur le disque du client.
      timeoutMs: 300_000,
    });
  }

  /**
   * Fait télécharger un fichier **par le daemon**.
   *
   * L'archive ne transite pas par le panel : un mod de cent mégaoctets
   * traverserait sinon deux fois le réseau, et le panel deviendrait le goulot
   * d'étranglement de chaque installation.
   *
   * Conséquence à connaître : c'est le node qui ouvre la connexion sortante,
   * vers une adresse que le panel lui donne. L'adresse ne vient donc jamais du
   * client — seulement d'un catalogue que nous avons interrogé nous-mêmes.
   *
   * `foreground: true` : le daemon répond une fois le fichier écrit. Sans cela
   * l'interface annoncerait une installation réussie alors que le
   * téléchargement peut encore échouer.
   */
  pullFile(serverId: string, root: string, url: string, fileName: string): Promise<void> {
    return this.call<void>(serverId, `/api/servers/${serverId}/files/pull`, {
      method: "POST",
      body: { root, url, file_name: fileName, foreground: true },
      timeoutMs: 120_000,
    });
  }

  /**
   * Extrait une archive **dans le conteneur**.
   *
   * Le panel ne décompresse rien lui-même : un modpack pèse des centaines de
   * mégaoctets, et les faire transiter par le panel lui donnerait le rôle de
   * relais de fichiers qu'il évite précisément d'avoir. Le daemon a déjà
   * l'archive sous la main, il est le mieux placé pour l'ouvrir.
   *
   * Le délai est long : une archive de modpack se déballe en dizaines de
   * secondes, et couper au bout de huit laisserait une arborescence à moitié
   * écrite sans que personne ne le sache.
   */
  decompressFile(serverId: string, root: string, file: string): Promise<void> {
    return this.call<void>(serverId, `/api/servers/${serverId}/files/decompress`, {
      method: "POST",
      body: { root, file },
      timeoutMs: 300_000,
    });
  }

  renameFile(serverId: string, root: string, from: string, to: string): Promise<void> {
    return this.renameFiles(serverId, root, [{ from, to }]);
  }

  /**
   * Plusieurs déplacements en une requête, relatifs à `root`.
   *
   * Contrat relevé dans la source de Wings (`putServerRenameFiles`) : les
   * entrées sont traitées en parallèle, une destination **existante** fait
   * échouer la requête (« destination already exists », 400) sans défaire les
   * autres, une source absente est ignorée, et les dossiers parents de la
   * destination sont créés au besoin.
   */
  renameFiles(
    serverId: string,
    root: string,
    files: { from: string; to: string }[],
  ): Promise<void> {
    return this.call<void>(serverId, `/api/servers/${serverId}/files/rename`, {
      method: "PUT",
      body: { root, files },
      timeoutMs: 60_000,
    });
  }

  /**
   * Change les permissions d'entrées, relatives à `root`.
   *
   * **Contrat relevé dans la source de Wings** (`router/router.go` et
   * `router/router_server_files.go`, `postServerChmodFile`) :
   *
   * - `POST /api/servers/:uuid/files/chmod`, corps
   *   `{ root, files: [{ file, mode }] }` ;
   * - `mode` est une **chaîne** octale, passée à `strconv.ParseUint(mode, 8,
   *   32)` — un nombre JSON ferait échouer le décodage du corps entier ;
   * - 204 sans corps en cas de réussite ; 400 « Invalid file mode. » pour un
   *   mode illisible, 422 pour une liste vide ;
   * - une entrée **absente est ignorée en silence** (`os.ErrNotExist` rend
   *   `nil`) : un 204 ne prouve donc pas que le fichier existait ;
   * - rien n'est récursif : un dossier change, pas son contenu.
   *
   * Le daemon ne filtre pas les bits spéciaux (`os.FileMode(mode)`) : le
   * mode est validé en amont (`FileMode` dans `contracts`), pas ici.
   */
  chmodFiles(
    serverId: string,
    root: string,
    files: { file: string; mode: string }[],
  ): Promise<void> {
    return this.call<void>(serverId, `/api/servers/${serverId}/files/chmod`, {
      method: "POST",
      body: { root, files: files.map(({ file, mode }) => ({ file, mode })) },
    });
  }

  /**
   * Demande au daemon de relire la configuration du serveur.
   *
   * Indispensable après un changement de ports : Wings ne lit la configuration
   * qu'au démarrage et sur cet appel. Sans lui, le panel afficherait le nouveau
   * port pendant que le conteneur continuerait d'écouter l'ancien — un écart
   * qui ne se découvre qu'en essayant de se connecter au jeu.
   */
  syncServer(serverId: string): Promise<void> {
    return this.call<void>(serverId, `/api/servers/${serverId}/sync`, { method: "POST" });
  }

  /**
   * Supprime un serveur du node, volume compris.
   *
   * Irréversible et sans filet : le daemon efface le répertoire de données. La
   * ligne du panel n'est retirée qu'après, pour ne pas perdre les coordonnées
   * du node si cet appel échoue.
   */
  deleteServer(serverId: string): Promise<void> {
    return this.call<void>(serverId, `/api/servers/${serverId}`, {
      method: "DELETE",
      timeoutMs: 60_000,
    });
  }

  /**
   * Fait connaître un nouveau serveur au daemon, et lance son installation.
   *
   * La route est `POST /api/servers`, à la racine, et **non**
   * `/api/servers/:uuid/install` — celle-ci passe par un intergiciel
   * `ServerExists()` qui répond 404 pour un serveur que le daemon n'a jamais
   * vu. Observé en conditions réelles : la création aboutissait en base, le
   * daemon répondait 404, et rien ne s'installait avant son redémarrage
   * suivant.
   *
   * Le corps ne porte que l'identifiant : c'est le daemon qui vient ensuite
   * chercher la configuration complète sur `/api/remote/servers/:uuid`.
   *
   * `start_on_completion` reste faux : un serveur qui démarre tout seul à la
   * fin de l'installation surprend, et le client peut le lancer d'un clic.
   */
  createServer(serverId: string): Promise<void> {
    /**
     * Le daemon exige un **UUID version 4**, pas un identifiant bien formé.
     *
     * `govalidator.IsUUIDv4` vérifie le chiffre de version et la variante :
     * `eeeeeeee-0000-0000-0000-000000000001` a la bonne forme et sera pourtant
     * refusé. Le cas n'est pas théorique — c'est celui du serveur de
     * démonstration inséré à la main, et le refus arriverait sous la forme d'un
     * 422 sans explication.
     *
     * Le panel génère ses identifiants avec `randomUUID()`, qui produit des v4 ;
     * ce contrôle protège contre ceux qui viendraient d'ailleurs — import,
     * migration, jeu de données.
     */
    if (!UUID_V4.test(serverId)) {
      throw new InternalServerErrorException(
        `L'identifiant « ${serverId} » n'est pas un UUID version 4 : le daemon le refusera.`,
      );
    }

    return this.call<void>(serverId, "/api/servers", {
      method: "POST",
      body: { uuid: serverId, start_on_completion: false },
    });
  }

  /**
   * Relance le script d'installation de l'egg.
   *
   * Le daemon répond tout de suite et travaille en arrière-plan ; c'est lui qui
   * rendra compte sur `POST /api/remote/servers/:uuid/install`. Le délai est
   * donc celui d'une prise en charge, pas celui d'une installation.
   */
  reinstallServer(serverId: string): Promise<void> {
    return this.call<void>(serverId, `/api/servers/${serverId}/reinstall`, { method: "POST" });
  }

  /**
   * Révoque des jetons de websocket déjà émis.
   *
   * Retirer un accès dans la base ne ferme pas les consoles ouvertes : le jeton
   * remis au navigateur est signé, autonome, et valable dix minutes. Sans cet
   * appel, quelqu'un dont on vient de retirer l'accès continuerait de lire la
   * console pendant tout ce temps. (Plus d'y envoyer des commandes : le jeton
   * ne scelle plus aucun `control.*`, voir `toWingsWebsocketPermissions`.)
   */
  denyWebsocketTokens(serverId: string, jtis: string[]): Promise<void> {
    if (jtis.length === 0) return Promise.resolve();
    return this.call<void>(serverId, `/api/servers/${serverId}/ws/deny`, {
      method: "POST",
      body: { jtis },
    });
  }

  /**
   * Retire à un compte tout ce qu'il tient encore ouvert sur un serveur :
   * sessions SFTP, consoles, jetons déjà émis.
   *
   * `POST /api/deauthorize-user` (`router/router_system.go`) : pour chaque
   * serveur cité, Wings refuse les jetons du compte émis jusqu'ici, ferme les
   * websockets du serveur (**toutes** : Wings ne sait pas les trier, les
   * autres se reconnectent) et coupe les sessions SFTP du compte. Seule
   * route qui touche au SFTP : retirer un accès dans la base refuse les
   * nouvelles connexions, pas celles déjà ouvertes.
   *
   * `user` est l'identifiant du compte, celui que portent le `user_uuid` du
   * jeton de console et la réponse de l'authentification SFTP.
   *
   * **La liste des serveurs n'est jamais vide** : vide, Wings déconnecte le
   * compte de tous les serveurs du node.
   */
  deauthorizeUser(serverId: string, userId: string): Promise<void> {
    return this.call<void>(serverId, "/api/deauthorize-user", {
      method: "POST",
      body: { user: userId, servers: [serverId] },
    });
  }

  /**
   * Démarre une sauvegarde.
   *
   * L'identifiant est **fourni par le panel**, pas choisi par le daemon : Wings
   * s'en servira pour rendre compte plus tard (`POST /api/remote/backups/:uuid`)
   * et ne connaît aucun autre moyen de désigner la ligne à mettre à jour. La
   * ligne doit donc exister en base avant cet appel.
   *
   * Wings répond 202 puis travaille en arrière-plan : cet appel ne garantit
   * que la prise en charge, jamais la réussite (§ compte rendu asynchrone).
   */
  createBackup(
    serverId: string,
    backupId: string,
    ignore: string[],
    adapter: "wings" | "s3" = "wings",
  ): Promise<void> {
    return this.call<void>(serverId, `/api/servers/${serverId}/backup`, {
      method: "POST",
      // `wings` et non `local` : c'est le nom de l'adaptateur local dans le
      // daemon (`backup.LocalBackupAdapter`). Toute autre valeur est refusée.
      body: { adapter, uuid: backupId, ignore: ignore.join("\n") },
    });
  }

  deleteBackup(serverId: string, backupId: string): Promise<void> {
    return this.call<void>(serverId, `/api/servers/${serverId}/backup/${backupId}`, {
      method: "DELETE",
    });
  }

  /**
   * Restaure une sauvegarde.
   *
   * `downloadUrl` désigne une archive distante : Wings la télécharge lui-même
   * par ce lien signé, faute d'avoir les identifiants du compartiment. Sans
   * lui, il la cherche sur son propre disque.
   *
   * Wings répond dès qu'il tient l'archive, puis extrait en arrière-plan. Le
   * délai reste très large : vider le dossier du serveur (`truncate`) se fait
   * **avant** de répondre, et prend des minutes sur un gros volume.
   * Abandonner au bout de huit secondes ferait croire à un échec pendant que
   * le daemon continue.
   */
  restoreBackup(
    serverId: string,
    backupId: string,
    truncate: boolean,
    downloadUrl?: string,
  ): Promise<void> {
    return this.call<void>(serverId, `/api/servers/${serverId}/backup/${backupId}/restore`, {
      method: "POST",
      body: downloadUrl
        ? { adapter: "s3", truncate_directory: truncate, download_url: downloadUrl }
        : { adapter: "wings", truncate_directory: truncate },
      timeoutMs: 600_000,
    });
  }

  /** Lecture de texte brut, sans tenter d'interpréter la réponse en JSON. */
  private async callText(serverId: string, path: string): Promise<string> {
    const endpoint = await this.endpointFor(serverId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);

    try {
      const response = await fetch(`${endpoint.baseUrl}${path}`, {
        headers: { Authorization: `Bearer ${endpoint.token}` },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new WingsUnavailableError(
          endpoint.nodeName,
          `HTTP ${response.status}`,
          response.status,
        );
      }
      return await response.text();
    } catch (error) {
      if (error instanceof WingsUnavailableError) throw error;
      const cause = error instanceof Error ? error.message : "erreur inconnue";
      throw new WingsUnavailableError(endpoint.nodeName, cause);
    } finally {
      clearTimeout(timer);
    }
  }
}
