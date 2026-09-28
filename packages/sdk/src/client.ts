import type { PowerSignal, ServerLimitsPatch } from "@gamedashboard/contracts";

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
  /** Une clé personnelle ou une clé de plateforme, selon ce qu'on appelle. */
  token: string;
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

export class GameDashboardClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: GameDashboardClientOptions) {
    // La barre finale est retirée ici une fois pour toutes : `${base}/servers`
    // avec une base qui finit par `/` donne `//servers`, que certains proxys
    // réécrivent et d'autres refusent.
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  /* --- Espace client, au nom du porteur de la clé -------------------------- */

  servers(): Promise<unknown[]> {
    return this.call<unknown[]>("GET", "/api/v1/client/servers");
  }

  server(serverId: string): Promise<unknown> {
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
  websocketGrant(serverId: string): Promise<unknown> {
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
  players(serverId: string): Promise<unknown> {
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
  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const corps = await this.request(method, path, body);
    // L'API enveloppe ses réponses dans `data`. Le client la déballe : c'est
    // une convention de transport, pas une information pour l'appelant.
    return (corps && "data" in corps ? corps.data : corps) as T;
  }

  /** L'appel HTTP, corps rendu tel quel (enveloppe comprise). */
  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown> | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
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
      const corps = lireJson(brut);

      if (!response.ok) throw probleme(response.status, corps);
      return corps;
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
