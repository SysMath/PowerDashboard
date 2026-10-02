import {
  BACKUP_RESTORE_TIMEOUT_MS,
  type ClientBackupList,
  type ClientBackupView,
  type ClientFileEntryView,
  type ClientNotificationView,
  type ClientPlayersView,
  type ClientServerView,
  type ConsoleGrant,
  type PowerSignal,
  type ResellerOverview,
  type ServerLimitsPatch,
  type UploadGrant,
} from "@gamedashboard/contracts";

/**
 * Client TypeScript de l'API GameDashboard.
 *
 * **Écrit, et non généré depuis la spécification.** C'était l'autre chemin
 * possible, et il a été écarté : un client généré depuis un OpenAPI qui ne
 * décrit pas encore tous les corps de requête produirait des méthodes typées
 * `unknown`, c'est-à-dire l'illusion d'un contrat là où il n'y en a pas. Les
 * types vivent déjà dans `@gamedashboard/contracts`, ils sont exacts, et les
 * réemployer coûte moins cher que de les regénérer moins bien.
 *
 * Ce que le client apporte, et qu'un `fetch` nu n'a pas :
 *
 * - **les refus lisibles** : l'API répond en Problem Details, et une erreur
 *   jetée telle quelle dit « HTTP 400 » là où le corps disait « ce revendeur
 *   n'autorise pas la plateforme à disposer de son compte » ;
 * - **une échéance** : sans elle, un panel qui accepte la connexion sans
 *   jamais répondre fige l'appelant jusqu'au délai du système ;
 * - **la clé posée une fois**, au lieu d'un en-tête recopié à chaque appel —
 *   c'est l'oubli qui produit les 401 qu'on cherche longtemps.
 *
 * Il ne couvre pas toute l'API : les routes ajoutées ici sont celles qu'un
 * système tiers emploie réellement. Ajouter une méthode par chemin du
 * catalogue donnerait une surface que personne ne relit.
 */

export interface GameDashboardClientOptions {
  /** L'adresse du panel, sans barre finale : `https://panel.example`. */
  baseUrl: string;
  /**
   * Une clé personnelle ou une clé de plateforme, selon ce qu'on appelle. Ou
   * une fonction qui rend le jeton du moment : celui d'un appareil mobile ne
   * vaut que quinze minutes (ADR 0010), et se renouvelle entre deux appels.
   */
  token: string | (() => Promise<string>);
  /**
   * Appelée sur un 401. Si elle rend `true` (le jeton a pu être renouvelé),
   * l'appel est rejoué **une fois** avec le jeton suivant ; sinon le 401
   * remonte tel quel.
   */
  onUnauthorized?: () => Promise<boolean>;
  /**
   * Confirmation de présence d'un appareil mobile (ADR 0010). Appelée avant
   * chaque geste que le panel protège ainsi (restaurer, supprimer), avec le
   * verbe et le chemin exacts, sans la requête ; rend l'en-tête à joindre.
   * Sans elle, ces gestes partent tels quels, ce qui convient à une clé.
   */
  presence?: (method: string, path: string) => Promise<Record<string, string>>;
  /** Au-delà, on cesse d'attendre. Dix secondes par défaut. */
  timeoutMs?: number;
  /** Pour les environnements sans `fetch` global, ou pour un client instrumenté. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Un refus de l'API, avec ce que l'API en a dit.
 *
 * `status` **et** `detail` : le code dit s'il faut réessayer, le détail dit
 * quoi changer. Perdre l'un des deux oblige à deviner.
 */
export class ApiProblem extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail: string | null,
  ) {
    super(detail ? `${title} — ${detail}` : title);
    this.name = "ApiProblem";
  }
}

/** Période et filtres d'une lecture de la consommation (jours `AAAA-MM-JJ`, inclus). */
export interface ConsumptionRequest {
  from?: string;
  to?: string;
  serverId?: string;
  ownerId?: string;
  page?: number;
}

/**
 * L'adresse sans ses barres obliques finales, en temps linéaire.
 *
 * Une boucle et non `replace(/\/+$/, "")`, que CodeQL signale comme
 * quadratique : sur « ////…x », la regex repart de chaque barre.
 */
function sansBarresFinales(adresse: string): string {
  let fin = adresse.length;
  while (fin > 0 && adresse[fin - 1] === "/") fin--;
  return adresse.slice(0, fin);
}

export class GameDashboardClient {
  private readonly baseUrl: string;
  private readonly token: string | (() => Promise<string>);
  private readonly onUnauthorized: (() => Promise<boolean>) | undefined;
  private readonly presence: GameDashboardClientOptions["presence"];
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: GameDashboardClientOptions) {
    // La barre finale est retirée ici une fois pour toutes : `${base}/servers`
    // avec une base qui finit par `/` donne `//servers`, que certains proxys
    // réécrivent et d'autres refusent.
    this.baseUrl = sansBarresFinales(options.baseUrl);
    this.token = options.token;
    this.onUnauthorized = options.onUnauthorized;
    this.presence = options.presence;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  /* --- Espace client, au nom du porteur de la clé -------------------------- */

  servers(): Promise<ClientServerView[]> {
    return this.call<ClientServerView[]>("GET", "/api/v1/client/servers");
  }

  server(serverId: string): Promise<ClientServerView> {
    return this.call("GET", `/api/v1/client/servers/${encodeURIComponent(serverId)}`);
  }

  resources(serverId: string): Promise<unknown> {
    return this.call("GET", `/api/v1/client/servers/${encodeURIComponent(serverId)}/resources`);
  }

  power(serverId: string, signal: PowerSignal): Promise<unknown> {
    return this.call("POST", `/api/v1/client/servers/${encodeURIComponent(serverId)}/power`, {
      signal,
    });
  }

  /**
   * Le jeton et l'adresse du websocket de console.
   *
   * Rendus ensemble parce qu'ils ne valent que l'un par l'autre : l'adresse
   * est celle du daemon qui héberge ce serveur — elle change après un
   * transfert — et le jeton ne vaut que dix minutes, pour ce serveur et pour
   * les permissions du porteur de la clé.
   */
  websocketGrant(serverId: string): Promise<ConsoleGrant> {
    return this.call("POST", `/api/v1/client/servers/${encodeURIComponent(serverId)}/websocket`);
  }

  command(serverId: string, command: string): Promise<unknown> {
    return this.call("POST", `/api/v1/client/servers/${encodeURIComponent(serverId)}/command`, {
      command,
    });
  }

  /** Commandes du jeu déclarées par l'egg (`whitelist add <joueur>`), pour l'autocomplétion. */
  consoleCommands(serverId: string): Promise<unknown> {
    return this.call("GET", `/api/v1/client/servers/${encodeURIComponent(serverId)}/commands`);
  }

  /** Joueurs connectés, lus dans la dernière sonde de jeu, et actions proposées. */
  players(serverId: string): Promise<ClientPlayersView> {
    return this.call("GET", `/api/v1/client/servers/${encodeURIComponent(serverId)}/players`);
  }

  /**
   * Une action de modération (`kick`, `ban`, `pardon`, `whitelist_add`…).
   * La commande vient de l'egg : on ne choisit que l'action et le joueur.
   */
  playerAction(
    serverId: string,
    input: { action: string; player: string; reason?: string },
  ): Promise<unknown> {
    return this.call(
      "POST",
      `/api/v1/client/servers/${encodeURIComponent(serverId)}/players`,
      input,
    );
  }

  /**
   * La cloche du compte : notifications, plus récentes d'abord, et le nombre
   * de non lues. Le destinataire est le porteur du jeton, jamais un paramètre.
   */
  async notifications(): Promise<{ items: ClientNotificationView[]; unread: number }> {
    const corps = await this.request("GET", "/api/v1/client/notifications");
    const meta = corps?.meta as { unread?: unknown } | undefined;
    return {
      items: Array.isArray(corps?.data) ? (corps.data as ClientNotificationView[]) : [],
      unread: typeof meta?.unread === "number" ? meta.unread : 0,
    };
  }

  markNotificationsRead(): Promise<unknown> {
    return this.call("POST", "/api/v1/client/notifications/read-all");
  }

  /* --- Sauvegardes ---------------------------------------------------------- */

  /** Les sauvegardes du serveur, plus récentes d'abord, et son quota. */
  async backups(serverId: string): Promise<ClientBackupList> {
    const corps = await this.request("GET", this.serverPath(serverId, "backups"));
    const meta = corps?.meta as { used?: unknown; limit?: unknown } | undefined;
    return {
      items: Array.isArray(corps?.data) ? (corps.data as ClientBackupView[]) : [],
      used: typeof meta?.used === "number" ? meta.used : 0,
      limit: typeof meta?.limit === "number" ? meta.limit : 0,
    };
  }

  /** Lance une sauvegarde : le daemon archive en arrière-plan. */
  createBackup(serverId: string, name: string): Promise<ClientBackupView> {
    return this.call("POST", this.serverPath(serverId, "backups"), { name });
  }

  /** Verrouillée, la rotation de rétention ne l'efface pas. */
  lockBackup(serverId: string, backupId: string, locked: boolean): Promise<unknown> {
    return this.call("POST", this.serverPath(serverId, "backups", backupId, "lock"), { locked });
  }

  /**
   * Restaure par-dessus les fichiers du serveur ; `truncate` les efface
   * d'abord. Geste protégé : confirmation de présence pour un appareil.
   */
  restoreBackup(serverId: string, backupId: string, truncate = false): Promise<unknown> {
    const chemin = this.serverPath(serverId, "backups", backupId, "restore");
    // Le panel attend d'abord l'instantané de sûreté de l'agent, quand le
    // node en a un : bien plus que le délai ordinaire.
    return this.call(
      "POST",
      chemin,
      { truncate },
      {
        protege: true,
        delaiMs: BACKUP_RESTORE_TIMEOUT_MS,
      },
    );
  }

  deleteBackup(serverId: string, backupId: string): Promise<unknown> {
    return this.call("DELETE", this.serverPath(serverId, "backups", backupId), undefined, {
      protege: true,
    });
  }

  /* --- Fichiers ------------------------------------------------------------- */

  /** Le contenu d'un dossier, tel que Wings le rend (sans tri). */
  async files(serverId: string, directory = "/"): Promise<ClientFileEntryView[]> {
    const entrees = await this.call<unknown>(
      "GET",
      `${this.serverPath(serverId, "files")}?directory=${encodeURIComponent(directory)}`,
    );
    return Array.isArray(entrees) ? (entrees as ClientFileEntryView[]) : [];
  }

  async fileContents(serverId: string, file: string): Promise<string> {
    const { content } = await this.call<{ content: string }>(
      "GET",
      `${this.serverPath(serverId, "files", "contents")}?file=${encodeURIComponent(file)}`,
    );
    return content;
  }

  writeFile(serverId: string, file: string, content: string): Promise<unknown> {
    return this.call(
      "POST",
      `${this.serverPath(serverId, "files", "write")}?file=${encodeURIComponent(file)}`,
      { content },
    );
  }

  createDirectory(serverId: string, root: string, name: string): Promise<unknown> {
    return this.call("POST", this.serverPath(serverId, "files", "create-directory"), {
      root,
      name,
    });
  }

  /** `to` est relatif à `root`, comme `from` : un chemin avec « / » déplace. */
  renameFile(serverId: string, root: string, from: string, to: string): Promise<unknown> {
    return this.call("POST", this.serverPath(serverId, "files", "rename"), { root, from, to });
  }

  /** Suppression définitive. Geste protégé : confirmation de présence. */
  deleteFiles(serverId: string, root: string, files: string[]): Promise<unknown> {
    return this.call(
      "POST",
      this.serverPath(serverId, "files", "delete"),
      { root, files },
      { protege: true },
    );
  }

  /** Rend le nom et la taille de l'archive, choisis par le daemon. */
  compressFiles(
    serverId: string,
    root: string,
    files: string[],
  ): Promise<{ name: string; size: number }> {
    return this.call("POST", this.serverPath(serverId, "files", "compress"), { root, files });
  }

  decompressFile(serverId: string, root: string, file: string): Promise<unknown> {
    return this.call("POST", this.serverPath(serverId, "files", "decompress"), { root, file });
  }

  /** Adresse chez le daemon, valable une minute et une fois : à suivre aussitôt. */
  async fileDownloadUrl(serverId: string, file: string): Promise<string> {
    const { url } = await this.call<{ url: string }>(
      "GET",
      `${this.serverPath(serverId, "files", "download")}?file=${encodeURIComponent(file)}`,
    );
    return url;
  }

  /** Autorisation de déposer des fichiers directement chez le daemon. */
  uploadGrant(serverId: string): Promise<UploadGrant> {
    return this.call("POST", this.serverPath(serverId, "files", "upload-grant"));
  }

  private serverPath(serverId: string, ...segments: string[]): string {
    return [
      `/api/v1/client/servers/${encodeURIComponent(serverId)}`,
      ...segments.map(encodeURIComponent),
    ].join("/");
  }

  /**
   * Instantanés du serveur sur son node (ADR 0009), avec l'état de la
   * fonction dans `meta`. 404 là où aucun agent ne les offre.
   */
  snapshots(serverId: string): Promise<unknown> {
    return this.call("GET", this.snapshotPath(serverId));
  }

  /** Demander un instantané manuel : l'agent le prend à son relevé suivant. */
  takeSnapshot(serverId: string): Promise<unknown> {
    return this.call("POST", this.snapshotPath(serverId));
  }

  /** Épingler, dans la limite du serveur : la rotation ne le détruit plus. */
  pinSnapshot(serverId: string, name: string, label?: string): Promise<unknown> {
    return this.call("POST", this.snapshotPath(serverId, name, "pin"), label ? { label } : {});
  }

  unpinSnapshot(serverId: string, name: string): Promise<unknown> {
    return this.call("DELETE", this.snapshotPath(serverId, name, "pin"));
  }

  /**
   * Restaurer depuis un instantané : le serveur s'arrête, un instantané de
   * sûreté est pris, puis le dossier est recopié. Il reste arrêté.
   */
  restoreSnapshot(serverId: string, name: string): Promise<unknown> {
    return this.call("POST", this.snapshotPath(serverId, name, "restore"), undefined, {
      protege: true,
    });
  }

  private snapshotPath(serverId: string, name?: string, action?: string): string {
    const base = `/api/v1/client/servers/${encodeURIComponent(serverId)}/snapshots`;
    return name ? `${base}/${encodeURIComponent(name)}/${action}` : base;
  }

  /** Le compte du porteur : son rôle dit quels espaces lui montrer. */
  me(): Promise<{ user: { id: string; email: string; role: string } }> {
    return this.call("GET", "/api/v1/auth/me");
  }

  /* --- Espace revendeur, au nom du revendeur (ADR 0010, lot 5) ------------ */

  /** Ses machines, ses serveurs, ses clients, son enveloppe. */
  resellerOverview(): Promise<ResellerOverview> {
    return this.call("GET", "/api/v1/reseller/overview");
  }

  /** Suspend ou rétablit un serveur de son parc ; un geste qui demande la présence. */
  setResellerServerSuspended(
    serverId: string,
    suspended: boolean,
    reason?: string,
  ): Promise<{ serverId: string; suspended: boolean; sessionsNotClosed: number }> {
    return this.call(
      "POST",
      `/api/v1/reseller/servers/${encodeURIComponent(serverId)}/suspension`,
      reason ? { suspended, reason } : { suspended },
      { protege: true },
    );
  }

  /**
   * La consommation journalière de son parc, lue dans l'export JSONL : une
   * journée par ligne, colonnes de `CONSUMPTION_COLUMNS`. Sans période, le
   * mois en cours. Une ligne illisible est ignorée, pas l'export entier.
   */
  async resellerConsumption(
    query: Omit<ConsumptionRequest, "page"> = {},
  ): Promise<Record<string, unknown>[]> {
    const search = new URLSearchParams({ format: "jsonl" });
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) search.set(key, String(value));
    }
    const texte = await this.texte("GET", `/api/v1/reseller/consumption/export?${search}`);
    return texte.split("\n").flatMap((ligne) => {
      const jour = lireJson(ligne);
      return jour ? [jour] : [];
    });
  }

  /* --- Espace applicatif, pour un système tiers ---------------------------- */

  createServer(input: Record<string, unknown>): Promise<unknown> {
    return this.call("POST", "/api/v1/application/servers", input);
  }

  /**
   * Suspendre et rétablir passent par **une seule** route, `suspension`, avec
   * un booléen. Ces deux méthodes appelaient `…/suspend` et `…/unsuspend`, qui
   * n'ont jamais existé dans l'API applicative : chaque appel rendait 404.
   */
  suspendServer(serverId: string, reason?: string): Promise<unknown> {
    return this.call(
      "POST",
      `/api/v1/application/servers/${encodeURIComponent(serverId)}/suspension`,
      { suspended: true, ...(reason ? { reason } : {}) },
    );
  }

  unsuspendServer(serverId: string): Promise<unknown> {
    return this.call(
      "POST",
      `/api/v1/application/servers/${encodeURIComponent(serverId)}/suspension`,
      { suspended: false },
    );
  }

  /** Changer les limites : seuls les champs fournis changent. */
  resizeServer(serverId: string, limits: ServerLimitsPatch): Promise<unknown> {
    return this.call(
      "PATCH",
      `/api/v1/application/servers/${encodeURIComponent(serverId)}`,
      limits,
    );
  }

  /**
   * Changer le titulaire : le service a changé de client chez le facturier.
   * `ownerId` est l'identifiant du compte **dans le panel** — celui que rend
   * `POST /users` ou `GET /users?externalId=`. Sous-utilisateurs, rappels
   * sortants et mots de passe des bases de l'ancien titulaire ne suivent pas,
   * ses sessions sont fermées. La réponse porte le bilan (`data.cleanup`) :
   * `databasesNotRotated` nomme les bases restées sur leur ancien mot de
   * passe. Rejouer l'appel ne fait rien de plus, et rend le bilan du
   * changement déjà fait (`changed: false`).
   */
  setServerOwner(serverId: string, ownerId: string): Promise<unknown> {
    return this.call("POST", `/api/v1/application/servers/${encodeURIComponent(serverId)}/owner`, {
      ownerId,
    });
  }

  /**
   * Lien de connexion d'un client, derrière le bouton « Gérer mon serveur » du
   * facturier. Le désigner par son identifiant **chez vous** (`externalId`)
   * évite de tenir une table de correspondance. Le lien vaut deux minutes et
   * ne sert qu'une fois : le demander au clic, jamais à l'avance.
   */
  ssoLink(client: { externalId: string } | { userId: string }): Promise<unknown> {
    return this.call("POST", "/api/v1/application/users/sso-link", client);
  }

  /**
   * Une page de la consommation journalière des serveurs, pour une
   * facturation à l'usage (portée `consumption.read`). Sans période, le mois
   * en cours ; les jours sont ceux du temps universel. `hasMore` dit s'il faut
   * demander la page suivante ; `consumptionDays` les enchaîne.
   */
  async consumption(
    query: ConsumptionRequest = {},
  ): Promise<{ days: unknown[]; hasMore: boolean }> {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) search.set(key, String(value));
    }
    const suffix = search.size > 0 ? `?${search}` : "";
    // L'enveloppe entière : `meta.hasMore` est la seule façon sûre de savoir
    // qu'une page pleine est aussi la dernière.
    const corps = await this.request("GET", `/api/v1/application/consumption${suffix}`);
    const meta = corps?.meta as { hasMore?: unknown } | undefined;
    return {
      days: Array.isArray(corps?.data) ? corps.data : [],
      hasMore: meta?.hasMore === true,
    };
  }

  /** Toutes les journées d'une période, page après page, jusqu'à `hasMore` faux. */
  async *consumptionDays(
    query: Omit<ConsumptionRequest, "page"> = {},
  ): AsyncGenerator<unknown, void, undefined> {
    for (let page = 1; ; page += 1) {
      const { days, hasMore } = await this.consumption({ ...query, page });
      yield* days;
      if (!hasMore) return;
    }
  }

  terminateServer(serverId: string): Promise<unknown> {
    return this.call("DELETE", `/api/v1/application/servers/${encodeURIComponent(serverId)}`);
  }

  /** La spécification que **ce** panel expose, version comprise. */
  openapi(): Promise<unknown> {
    return this.call("GET", "/api/v1/openapi.json");
  }

  /**
   * L'appel, et tout ce qu'il y a autour.
   *
   * `content-type` n'est posé **que** s'il y a un corps : Fastify refuse par
   * un 400 « Body cannot be empty » une requête qui s'annonce en JSON et
   * n'envoie rien. Ce refus ressemble à une demande invalide et coûte
   * longtemps à comprendre.
   */
  /**
   * `protege` : geste qui exige une confirmation de présence. `delaiMs` :
   * attente propre à ce geste, jamais plus courte que celle du client.
   */
  private async call<T>(
    method: string,
    path: string,
    body?: unknown,
    options: { protege?: boolean; delaiMs?: number } = {},
  ): Promise<T> {
    // Le défi est demandé avant l'appel et signé pour ce chemin seul, sans
    // la requête : c'est ce que le panel vérifie.
    const entetes =
      options.protege && this.presence
        ? await this.presence(method, path.split("?")[0] ?? path)
        : {};
    const delai = Math.max(this.timeoutMs, options.delaiMs ?? 0);
    const corps = await this.request(method, path, body, entetes, delai);
    // L'API enveloppe ses réponses dans `data`. Le client la déballe : c'est
    // une convention de transport, pas une information pour l'appelant.
    return (corps && "data" in corps ? corps.data : corps) as T;
  }

  /** L'appel HTTP, corps rendu tel quel (enveloppe comprise). */
  private async request(
    method: string,
    path: string,
    body?: unknown,
    entetes: Record<string, string> = {},
    delai = this.timeoutMs,
  ): Promise<Record<string, unknown> | null> {
    return lireJson(await this.texte(method, path, body, entetes, delai));
  }

  /** Le corps en texte, pour un export qui n'est pas un seul objet JSON. */
  private async texte(
    method: string,
    path: string,
    body?: unknown,
    entetes: Record<string, string> = {},
    delai = this.timeoutMs,
  ): Promise<string> {
    try {
      return await this.once(method, path, body, entetes, delai);
    } catch (error) {
      // Un seul nouvel essai, et seulement si le jeton a vraiment changé :
      // rejouer en boucle un 401 ferait tourner un renouvellement refusé.
      if (!(error instanceof ApiProblem) || error.status !== 401 || !this.onUnauthorized) {
        throw error;
      }
      if (!(await this.onUnauthorized())) throw error;
      // Le défi n'a pas été consommé : le panel refuse le jeton avant de le lire.
      return this.once(method, path, body, entetes, delai);
    }
  }

  private async once(
    method: string,
    path: string,
    body: unknown,
    entetes: Record<string, string>,
    delai: number,
  ): Promise<string> {
    const token = typeof this.token === "string" ? this.token : await this.token();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), delai);

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          ...entetes,
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      /*
       * Le corps est lu **sans jamais faire échouer l'appel sur sa forme**.
       *
       * Une page d'erreur de serveur web, un portail captif, un proxy mal
       * réglé : le corps n'est alors pas du JSON. `JSON.parse` lève une
       * `SyntaxError`, qui remonte telle quelle à l'appelant — « Unexpected
       * token '<' » — et accuse l'API de ce qu'un intermédiaire a fait, en
       * perdant au passage le code HTTP, qui est la seule chose exploitable.
       */
      const brut = await response.text();
      if (!response.ok) throw probleme(response.status, lireJson(brut));
      return brut;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Traduit un corps de refus, quelle que soit sa forme.
 *
 * L'API répond en Problem Details, mais un proxy mal réglé ou une page
 * d'erreur du serveur web peuvent s'intercaler : un corps illisible ne doit
 * pas faire échouer l'appel sur « JSON invalide », qui accuse l'API de ce
 * qu'un intermédiaire a fait.
 */
/** Le corps, s'il est du JSON objet. `null` sinon — jamais une exception. */
function lireJson(brut: string): Record<string, unknown> | null {
  if (brut.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(brut);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function probleme(status: number, corps: Record<string, unknown> | null): ApiProblem {
  const title =
    typeof corps?.title === "string"
      ? corps.title
      : typeof corps?.message === "string"
        ? corps.message
        : `Le panel a répondu ${status}.`;
  const detail = typeof corps?.detail === "string" ? corps.detail : null;
  return new ApiProblem(status, title, detail);
}
