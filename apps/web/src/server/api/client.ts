import type { ClientServerView } from "@gamedashboard/contracts";
import { cookies } from "next/headers";
import { redirect, unstable_rethrow } from "next/navigation";
import { API_OFFLINE_DIGEST, API_TIMEOUT_DIGEST, type ApiFailureKind } from "@/lib/api-status";
import type { SessionUser } from "@/lib/session-user";
import { forwardedIdentityHeaders } from "./forwarded";

/**
 * Accès à l'API depuis les composants serveur.
 *
 * Le navigateur n'appelle jamais l'API directement pour lire des données : les
 * pages sont rendues côté serveur, qui transmet le cookie de session. Deux
 * conséquences — l'adresse interne de l'API n'a pas à être publique, et aucune
 * donnée ne transite par une requête que l'utilisateur pourrait rejouer avec
 * d'autres paramètres.
 */
const API_URL = process.env.API_URL ?? "http://127.0.0.1:3201";

import { SESSION_COOKIE } from "@/lib/session-cookie";

export { SESSION_COOKIE };

/**
 * Au-delà, on cesse d'attendre l'API.
 *
 * Une connexion refusée échoue instantanément ; ce délai vise l'autre panne,
 * plus sournoise — l'API accepte la connexion et ne répond jamais, parce que
 * sa base est saturée ou qu'un verrou la retient. Sans échéance, le rendu de
 * la page attend indéfiniment : l'onglet tourne, aucun message n'apparaît, et
 * l'utilisateur recharge, ce qui ajoute une requête à celle qui bloque déjà.
 *
 * Dix secondes : plus qu'il n'en faut à n'importe quelle lecture de ce panel,
 * assez peu pour qu'un écran s'affiche pendant qu'on est encore devant.
 */
const API_TIMEOUT_MS = 10_000;

export class ApiError extends Error {
  /**
   * Corps du refus, tel que l'API l'a renvoyé.
   *
   * `message` suffit presque toujours : il nomme la permission manquante ou le
   * node injoignable. Certains refus portent en plus une raison **structurée**
   * — la liste des manquements d'un mot de passe, par exemple — que l'écran
   * doit pouvoir traduire au lieu de réafficher une phrase française figée.
   */
  readonly details: Record<string, unknown>;

  /**
   * Nature de l'échec, indépendante du message.
   *
   * `status === 0` disait déjà « pas de réponse », mais confondait deux pannes
   * qui n'appellent pas le même geste : une API éteinte se démarre, une API
   * qui ne répond plus se diagnostique. L'écran doit pouvoir les distinguer
   * sans lire une phrase française.
   */
  readonly kind: ApiFailureKind;

  /**
   * Jeton transmis à la frontière d'erreur par Next.
   *
   * C'est la seule chose qui traverse la frontière serveur → client hors
   * développement : le message, lui, est remplacé par un texte générique. Sans
   * ce champ, l'écran d'erreur ne saurait pas en production ce qu'il sait sur
   * le poste du développeur.
   */
  readonly digest?: string;

  constructor(
    message: string,
    readonly status: number,
    options?: ErrorOptions & {
      details?: Record<string, unknown>;
      kind?: ApiFailureKind;
      digest?: string;
    },
  ) {
    super(message, options);
    this.name = "ApiError";
    this.details = options?.details ?? {};
    this.kind = options?.kind ?? (status === 0 ? "offline" : "http");
    if (options?.digest) this.digest = options.digest;
  }

  /** Vrai quand l'API n'a pas répondu du tout, par opposition à un refus. */
  get unreachable(): boolean {
    return this.kind !== "http";
  }
}

/**
 * Traduit l'échec d'un `fetch` en erreur nommée.
 *
 * `fetch` rend « fetch failed » pour tout — port fermé, DNS absent, échéance
 * dépassée — et range la cause réelle dans `cause`. La déplier ici est ce qui
 * permet à l'écran de dire « démarrez l'API » plutôt que « une erreur est
 * survenue ».
 */
function describeTransportFailure(cause: unknown): ApiError {
  const timedOut =
    cause instanceof DOMException
      ? cause.name === "TimeoutError" || cause.name === "AbortError"
      : false;

  if (timedOut) {
    return new ApiError(
      `L'API n'a pas répondu en moins de ${API_TIMEOUT_MS / 1000} s sur ${API_URL}.`,
      0,
      { cause, kind: "timeout", digest: API_TIMEOUT_DIGEST },
    );
  }

  return new ApiError(`L'API ne répond pas sur ${API_URL}. Est-elle démarrée ?`, 0, {
    cause,
    kind: "offline",
    digest: API_OFFLINE_DIGEST,
  });
}

/**
 * Appelle l'API en transmettant la session de l'utilisateur.
 *
 * `cache: "no-store"` : ces réponses dépendent de qui demande. Une mise en
 * cache servirait les serveurs d'un client à un autre — le genre de défaut qui
 * ne se voit qu'en production, sous charge, et une seule fois.
 */
export async function apiFetch<T>(path: string): Promise<T> {
  const store = await cookies();
  const session = store.get(SESSION_COOKIE)?.value;

  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      headers: {
        ...(await forwardedIdentityHeaders()),
        ...(session ? { cookie: `${SESSION_COOKIE}=${session}` } : {}),
      },
      cache: "no-store",
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (cause) {
    /**
     * Pas de réponse : l'API est éteinte, mal adressée, ou trop lente.
     *
     * Le message brut de `fetch` est « fetch failed », qui ne dit ni la cause
     * ni le remède. On le remplace par un état nommé, que la frontière
     * d'erreur traduit en message actionnable.
     */
    throw describeTransportFailure(cause);
  }

  /**
   * Session absente ou expirée : on renvoie vers la connexion.
   *
   * `redirect()` est appelé **hors** du bloc `try` : Next l'implémente en
   * levant une exception qu'il intercepte lui-même, et la capturer ici la
   * transformerait en erreur d'API au lieu d'une redirection.
   *
   * Sans cela, une simple visite sur une page protégée sans être connecté
   * produisait un écran d'erreur « HTTP 403 » — techniquement exact, et
   * parfaitement inutile pour qui doit juste se connecter.
   */
  if (response.status === 401 || response.status === 403) {
    redirect("/login");
  }

  if (!response.ok) {
    /**
     * La phrase de l'API d'abord, le code ensuite.
     *
     * Les écritures lisaient déjà le corps ; les lectures, non — elles
     * annonçaient « L'API a répondu 404 sur /api/v1/… ». Exact, et inutile :
     * l'API avait écrit « Lien d'invitation inconnu ou déjà employé », qui dit
     * à la fois ce qui s'est passé et quoi faire. Toute page affichant l'erreur
     * d'une lecture perdait cette phrase.
     *
     * Le chemin reste en repli : certaines réponses n'ont pas de corps (un 502
     * d'un intermédiaire, par exemple), et un bandeau vide serait pire.
     */
    const payload = (await response.json().catch(() => ({}))) as { message?: unknown };
    const explication =
      typeof payload.message === "string" && payload.message.trim() !== ""
        ? payload.message
        : `L'API a répondu ${response.status} sur ${path}`;
    throw new ApiError(explication, response.status);
  }
  return (await response.json()) as T;
}

/**
 * L'utilisateur de la session courante, ou `null` s'il n'y en a pas.
 *
 * Pour les pages **publiques qui s'adaptent** à la présence d'une session — la
 * page d'invitation en est le cas type : celui qui ouvre le lien n'a le plus
 * souvent pas encore de compte, et l'envoyer vers la connexion lui ferait
 * perdre ce qu'il venait lire.
 *
 * Nécessaire parce que `apiFetch` **redirige** sur 401 : l'entourer d'un
 * `catch` ne suffirait pas, puisque Next implémente `redirect()` en levant une
 * exception qu'il intercepte lui-même — l'avaler marche par accident, et
 * cesserait de marcher sans prévenir.
 */
export async function fetchOptionalMe(): Promise<SessionUser | null> {
  const store = await cookies();
  const session = store.get(SESSION_COOKIE)?.value;
  if (!session) return null;

  try {
    const response = await fetch(`${API_URL}/api/v1/auth/me`, {
      headers: {
        ...(await forwardedIdentityHeaders()),
        cookie: `${SESSION_COOKIE}=${session}`,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const { user } = (await response.json()) as { user: SessionUser };
    return user;
  } catch {
    // Une API injoignable ne doit pas faire échouer une page publique : elle
    // s'affiche comme pour un visiteur, ce qui est le cas le plus fréquent.
    return null;
  }
}

/** Un serveur tel que l'espace client le rend (défini dans les contrats, partagé avec l'application). */
export type ClientServer = ClientServerView;

/**
 * Serveurs de l'utilisateur connecté.
 *
 * Une session absente ou expirée déclenche une redirection vers /login depuis
 * `apiFetch` : la page de connexion est le bon endroit pour le dire.
 */
export async function fetchMyServers(): Promise<ClientServer[]> {
  const { data } = await apiFetch<{ data: ClientServer[] }>("/api/v1/client/servers");
  return data;
}

/**
 * Un serveur précis.
 *
 * `null` quand il n'existe pas ou que l'utilisateur n'y a pas accès : l'API ne
 * distingue pas les deux cas, et la page appelle `notFound()` dans les deux.
 */
export async function fetchMyServer(id: string): Promise<ClientServer | null> {
  try {
    const { data } = await apiFetch<{ data: ClientServer }>(`/api/v1/client/servers/${id}`);
    return data;
  } catch (error) {
    // 404 seulement : un 403 a déjà provoqué la redirection vers la connexion.
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/**
 * Commandes du jeu proposées par l'egg, pour l'autocomplétion de la console.
 *
 * Une liste vide en cas d'échec : l'autocomplétion est un confort, et son
 * absence ne doit pas empêcher d'ouvrir la console.
 */
export async function fetchConsoleCommands(id: string): Promise<string[]> {
  try {
    const { data } = await apiFetch<{ data: { commands: string[] } }>(
      `/api/v1/client/servers/${id}/commands`,
    );
    return data.commands;
  } catch (error) {
    // Une redirection vers la connexion n'est pas un échec à taire : Next la
    // lève en exception, et c'est à lui de l'intercepter.
    unstable_rethrow(error);
    return [];
  }
}

/**
 * Envoi d'une action à l'API.
 *
 * Distinct d'`apiFetch` : une action modifie l'état, et son message d'erreur
 * remonte à l'interface pour y être affiché en contexte. `apiFetch` sert les
 * lectures, dont l'échec justifie une page d'erreur entière.
 */
export async function apiSend(
  path: string,
  body: unknown,
  method: "POST" | "DELETE" = "POST",
): Promise<void> {
  await apiCall(path, body, method);
}

/**
 * Comme `apiSend`, mais rend la réponse.
 *
 * Distinct plutôt que fusionné : la plupart des actions n'ont rien à lire en
 * retour, et une fonction qui renvoie toujours un corps inciterait à l'utiliser
 * pour des secrets — un mot de passe de base de données, par exemple — là où un
 * simple accusé de réception suffisait.
 */
export async function apiSendFor<T>(
  path: string,
  body: unknown,
  method: "POST" | "DELETE" = "POST",
): Promise<T> {
  const response = await apiCall(path, body, method);
  return (await response.json()) as T;
}

/**
 * Une lecture **d'appoint**, dont le refus reste local.
 *
 * `apiFetch` renvoie vers la connexion sur un 403 : juste pour une page
 * entière, faux pour un bloc à l'intérieur d'une page. Un sous-utilisateur sans
 * `console.read` qui ouvre la console serait déconnecté de fait par le seul
 * graphe d'historique, alors qu'il lui suffit de ne pas le voir. Ici, le refus
 * remonte en `ApiError` avec le message de l'API, et l'écran en décide.
 */
export async function apiReadFor<T>(path: string): Promise<T> {
  const response = await apiCall(path, undefined, "GET");
  return (await response.json()) as T;
}

async function apiCall(path: string, body: unknown, method: string): Promise<Response> {
  const store = await cookies();
  const session = store.get(SESSION_COOKIE)?.value;

  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method,
      headers: {
        ...(await forwardedIdentityHeaders()),
        ...(body === undefined
          ? {}
          : {
              "content-type":
                body instanceof Uint8Array ? "application/octet-stream" : "application/json",
            }),
        ...(session ? { cookie: `${SESSION_COOKIE}=${session}` } : {}),
      },
      // Des octets partent tels quels (envoi d'une image de marque) ; tout le
      // reste en JSON.
      body:
        body === undefined
          ? undefined
          : body instanceof Uint8Array
            ? (body as Uint8Array<ArrayBuffer>)
            : JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (cause) {
    const failure = describeTransportFailure(cause);

    /**
     * Une action interrompue par l'échéance n'est **pas** une action annulée.
     *
     * Elle a peut-être abouti côté API : on a cessé d'attendre la réponse, pas
     * arrêté le traitement. Le dire évite qu'on recommence — et qu'on crée
     * deux fois ce qui existe déjà. C'est le seul endroit où la nuance
     * s'impose : pour une lecture, réessayer ne coûte rien.
     */
    if (failure.kind === "timeout") {
      throw new ApiError(
        `${failure.message} L'opération a peut-être abouti : vérifiez avant de recommencer.`,
        0,
        { cause, kind: "timeout", digest: API_TIMEOUT_DIGEST },
      );
    }

    throw failure;
  }

  if (response.ok) return response;

  // Le message de l'API est repris tel quel : il nomme la permission manquante
  // ou le node injoignable, ce qu'un message générique perdrait.
  const payload = (await response.json().catch(() => ({}))) as {
    message?: string;
    [key: string]: unknown;
  };
  throw new ApiError(payload.message ?? `L'API a répondu ${response.status}.`, response.status, {
    details: payload,
  });
}

/**
 * L'utilisateur de la session courante.
 *
 * Lu à chaque rendu de la coquille plutôt que mémorisé : un changement de rôle
 * ou de nom doit se voir à la page suivante, et non à la reconnexion.
 */
export async function fetchMe(): Promise<SessionUser> {
  const { user } = await apiFetch<{ user: SessionUser }>("/api/v1/auth/me");
  return user;
}

/**
 * Fonctions ouvertes sur ce panel, pour le compte connecté.
 *
 * Lu par les mises en page pour cesser de proposer ce que l'API refusera. En
 * cas d'échec on suppose **ouvert** : le drapeau n'est pas une protection — les
 * routes le tiennent elles-mêmes — et fermer l'écran sur une lecture ratée
 * ferait disparaître des fonctions parce qu'une requête a échoué.
 */
export interface PanelFeatures {
  marketplace: boolean;
  serverCreation: boolean;
}

export const fetchFeatures = async (): Promise<PanelFeatures> => {
  try {
    const { data } = await apiFetch<{ data: PanelFeatures }>("/api/v1/client/features");
    return data;
  } catch {
    return { marketplace: true, serverCreation: true };
  }
};
