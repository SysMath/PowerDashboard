import {
  APP_ACCESS_TOKEN_PREFIX,
  APP_PRESENCE_HEADER,
  APP_PRESENCE_REQUIRED,
  appMayReach,
  appNeedsPresence,
  authCookieAttributes,
  sessionCookieName,
} from "@gamedashboard/contracts";
import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from "@nestjs/common";
import { ApiKeyRepository } from "./api-key.repository";
import { AppDeviceRepository } from "./app-device.repository";
import { crossSiteCookieWrite } from "./request-provenance";
import { SessionRepository, type SessionUser } from "./session.repository";

/**
 * Nom du cookie de session. Opaque : il ne porte aucune information.
 *
 * `__Host-` dès que le panel exige HTTPS — en production, ou servi sur une
 * origine `https://` (règle commune de `contracts`, que l'interface applique
 * aussi dans `apps/web/src/lib/session-cookie.ts`).
 *
 * **Une fonction, relue à chaque appel**, et non une constante : `.env` est
 * chargé par `ConfigModule` après l'évaluation des modules. Une constante y
 * aurait lu une origine absente et nommé le cookie `gd_session`, pendant que
 * l'interface, qui charge son environnement avant tout, cherchait
 * `__Host-gd_session`.
 */
export function sessionCookie(): string {
  return sessionCookieName(process.env);
}

/** Attributs des cookies d'authentification, à la pose comme à l'effacement. */
export function authCookieOptions(): ReturnType<typeof authCookieAttributes> {
  return authCookieAttributes(process.env);
}

/**
 * Requête authentifiée.
 *
 * `scopes` vaut `null` pour une session ouverte dans un navigateur — la
 * personne agit en son nom propre, sans restriction. Une valeur non nulle
 * signale une clé d'API, dont les portées **bornent** les droits de son
 * propriétaire.
 *
 * La distinction est portée par le type plutôt que par une liste vide : « pas
 * de restriction » et « aucune portée accordée » sont deux choses opposées, et
 * les représenter pareil donnerait à une clé sans portée les pleins pouvoirs.
 */
export interface AuthenticatedRequest {
  user: SessionUser;
  scopes: string[] | null;
  sessionToken?: string;
  /**
   * Appareil mobile lié qui présente la requête (ADR 0010), absent sinon.
   *
   * Son jeton porte les droits du compte (`scopes` nul), mais ce n'est pas un
   * navigateur : `isBrowserSession` le distingue, et les routes réservées au
   * navigateur le refusent.
   */
  appDeviceId?: string;
}

/**
 * La requête vient-elle d'une session ouverte dans un navigateur ?
 *
 * Ni une clé d'API (portées non nulles), ni un appareil mobile : les deux
 * seuls appelants qui n'aient pas de cookie. Ce qui ne se fait que « connecté
 * au panel » — gérer ses clés, créer un serveur, toucher à la sécurité du
 * compte — se décide ici.
 */
export function isBrowserSession(request: {
  scopes?: string[] | null;
  appDeviceId?: string;
}): boolean {
  return request.scopes == null && request.appDeviceId === undefined;
}

/**
 * Authentification des routes client, par session ou par clé d'API.
 *
 * Distinct de `NodeTokenGuard` (§7.5) et sans recouvrement : les routes
 * `/api/remote/*` ne doivent jamais passer par ici, sous peine de répondre au
 * daemon par une redirection vers la page de connexion, qu'il interprète comme
 * une panne du panel.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @Inject(SessionRepository) private readonly sessions: SessionRepository,
    @Inject(ApiKeyRepository) private readonly keys: ApiKeyRepository,
    @Inject(AppDeviceRepository) private readonly devices: AppDeviceRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      method?: string;
      url?: string;
      routeOptions?: { url?: string };
      cookies?: Record<string, string | undefined>;
      headers?: Record<string, string | string[] | undefined>;
      ip?: string;
      user?: SessionUser;
      scopes?: string[] | null;
      sessionToken?: string;
      appDeviceId?: string;
    }>();

    const token = request.cookies?.[sessionCookie()];
    if (token) {
      // Le cookie part tout seul avec une requête qu'un autre site fait
      // envoyer : une écriture qui en vient est refusée avant même de lire la
      // session (NC-02, `request-provenance.ts`). Une clé `Bearer`, elle, ne
      // se joint jamais d'elle-même et n'est pas concernée.
      if (crossSiteCookieWrite(request)) {
        throw new ForbiddenException(
          "Requête refusée : elle vient d'un autre site que le panel. Refaites le geste depuis le panel.",
        );
      }

      const user = await this.sessions.resolve(token);
      if (!user) return false;

      // L'utilisateur authentifié est attaché à la requête. Aucun contrôleur ne
      // doit lire un identifiant d'utilisateur ailleurs : sinon il suffirait
      // d'en passer un autre dans l'URL pour voir les serveurs d'autrui.
      request.user = user;
      request.scopes = null;
      request.sessionToken = token;
      return true;
    }

    const bearer = readBearer(request.headers?.authorization);
    if (!bearer) return false;

    if (bearer.startsWith(APP_ACCESS_TOKEN_PREFIX)) return this.appDevice(request, bearer);

    const principal = await this.keys.resolve(bearer, request.ip);
    if (!principal) return false;

    request.user = principal.user;
    request.scopes = principal.scopes;
    return true;
  }

  /**
   * Jeton d'un appareil mobile lié (ADR 0010).
   *
   * Trois contrôles après le jeton lui-même : la route doit être de celles
   * que l'application emploie (`appMayReach`, liste d'autorisation, sur le
   * gabarit du routeur et jamais sur l'adresse reçue) ; un geste lourd exige
   * la confirmation de présence, défi signé par la clé de l'appareil ; et la
   * requête porte `appDeviceId`, qui la distingue d'une session de
   * navigateur partout où cela compte.
   */
  private async appDevice(
    request: {
      method?: string;
      url?: string;
      routeOptions?: { url?: string };
      headers?: Record<string, string | string[] | undefined>;
      ip?: string;
      user?: SessionUser;
      scopes?: string[] | null;
      appDeviceId?: string;
    },
    token: string,
  ): Promise<boolean> {
    const principal = await this.devices.resolveAccess(token, request.ip ?? null);
    if (!principal) return false;

    const method = request.method ?? "GET";
    const route = request.routeOptions?.url ?? "";
    if (!appMayReach(method, route)) {
      throw new ForbiddenException(
        "L'application mobile n'a pas accès à cette page du panel. Ouvrez-la dans un navigateur.",
      );
    }
    if (appNeedsPresence(method, route)) {
      const header = request.headers?.[APP_PRESENCE_HEADER];
      const confirmed = await this.devices.consumePresence(
        principal.deviceId,
        (Array.isArray(header) ? header[0] : header) ?? null,
        { method, path: (request.url ?? "").split("?")[0] ?? "" },
      );
      if (!confirmed) {
        throw new ForbiddenException({
          message: "Ce geste demande de confirmer votre présence sur le téléphone.",
          code: APP_PRESENCE_REQUIRED,
        });
      }
    }

    request.user = principal.user;
    request.scopes = null;
    request.appDeviceId = principal.deviceId;
    return true;
  }
}

/**
 * Extrait le jeton d'un en-tête `Authorization`.
 *
 * Le cookie est examiné en premier dans `canActivate` : une page du panel
 * envoie les deux si l'utilisateur a par ailleurs une clé configurée dans son
 * navigateur, et c'est alors la session qui doit l'emporter — sinon une clé
 * restreinte limiterait silencieusement ce que l'écran laisse faire.
 */
function readBearer(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value?.startsWith("Bearer ")) return null;
  const token = value.slice("Bearer ".length).trim();
  return token === "" ? null : token;
}
