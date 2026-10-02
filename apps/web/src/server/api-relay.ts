import "server-only";
import {
  APP_ACCESS_TOKEN_PREFIX,
  APP_PRESENCE_HEADER,
  NODE_AGENT_PREFIX,
  WINGS_CONFIGURE_PREFIX,
  WINGS_REMOTE_PREFIX,
} from "@gamedashboard/contracts";

/**
 * Relais vers l'API des chemins qu'elle sert **au monde**, quand aucun proxy
 * ne les lui envoie directement.
 *
 * En production (`infra/prod/panel.conf`), nginx aiguille lui-même ces
 * préfixes vers l'API : le contrat de Wings, l'API applicative de la
 * facturation, la spécification OpenAPI et le statut public. Ils n'atteignent
 * jamais Next, et ce relais y reste éteint.
 *
 * Sur un hébergement mutualisé (cPanel, `docs/hebergement-cpanel.md`), il n'y
 * a pas de nginx à régler : l'adresse du panel sert Next et rien d'autre.
 * Wings, lui, appelle toujours `PANEL_ORIGIN` sur des chemins codés en dur —
 * il reste inchangé, c'est au panel de s'adapter. `API_RELAY=1` fait alors de
 * Next l'aiguilleur, pour ces préfixes-là et aucun autre.
 *
 * Ce n'est pas un proxy ouvert : la liste des chemins est celle de nginx, et
 * ce qui passe se réduit à ce que ces routes lisent. Pas de cookie, surtout :
 * toutes s'authentifient par jeton, et un cookie de session relayé ferait
 * d'une route à jeton une route à session.
 */

const API_URL = process.env.API_URL ?? "http://127.0.0.1:3201";

/**
 * Les chemins que nginx envoie à l'API en production, et seulement eux ;
 * plus le signal de release, qui n'existe que sur un hébergement autonome
 * (src/modules/updates dans l'API) et y reste inerte sans son secret.
 */
const PREFIXES = [
  `${WINGS_REMOTE_PREFIX}/`,
  `${WINGS_CONFIGURE_PREFIX}/`,
  // L'agent de node facultatif (ADR 0008), sur le modèle du daemon.
  `${NODE_AGENT_PREFIX}/`,
  "/api/v1/application/",
];
const EXACTS = ["/api/v1/openapi.json", "/api/v1/status", "/api/v1/updates/signal"];

/**
 * Application mobile (ADR 0010), sur le modèle de nginx : la liaison pour
 * tous, l'espace client et le profil pour le seul jeton d'un appareil lié
 * (`$gd_mobile_upstream` dans `panel.conf`). Une clé personnelle n'y passe
 * pas, et aucun cookie n'est jamais relayé.
 */
const APP_PREFIXES = ["/api/v1/auth/app/"];
const APP_DEVICE_PREFIXES = ["/api/v1/client/"];
const APP_DEVICE_EXACTS = ["/api/v1/auth/me"];

export function relayablePath(pathname: string, authorization: string | null = null): boolean {
  // Un chemin qui remonte (`/api/remote/../v1/admin`) serait normalisé par
  // l'API en une route qu'on n'a pas voulu ouvrir.
  if (/(^|\/)\.\.?(\/|$)|%2e|%2f|\\/i.test(pathname)) return false;
  if (EXACTS.includes(pathname) || PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return true;
  }
  if (APP_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true;
  if (!authorization?.startsWith(`Bearer ${APP_ACCESS_TOKEN_PREFIX}`)) return false;
  return (
    APP_DEVICE_EXACTS.includes(pathname) ||
    APP_DEVICE_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
}

/**
 * Ce qui part vers l'API.
 *
 * `authorization` porte le jeton du node ou la clé applicative ;
 * `idempotency-key` protège la facturation d'une création rejouée ;
 * `user-agent` donne la version de Wings au journal ; `x-gamedashboard-*`
 * porte l'horodatage, la version et la signature d'un signal de release. La chaîne
 * `x-forwarded-for` suit, pour que la limitation par adresse compte chaque
 * node et chaque intégrateur à part — l'API ne la croit qu'à travers
 * `TRUSTED_PROXIES`.
 */
const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "authorization",
  "content-type",
  "idempotency-key",
  "user-agent",
  // La confirmation de présence d'un geste lourd venu de l'application.
  APP_PRESENCE_HEADER,
  "x-gamedashboard-signature",
  "x-gamedashboard-timestamp",
  "x-gamedashboard-version",
  "x-forwarded-for",
  "x-forwarded-proto",
];

/**
 * Ce qui ne revient pas.
 *
 * Les en-têtes de connexion ne valent que pour un saut. `content-encoding` et
 * `content-length` décrivent le corps tel que l'API l'a envoyé, que `fetch` a
 * déjà décompressé : les recopier ferait lire au client un corps qui n'est
 * pas celui annoncé. `set-cookie` n'a rien à faire sur ces routes.
 */
const DROPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "set-cookie",
  "transfer-encoding",
]);

export async function relayToApi(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (
    process.env.API_RELAY !== "1" ||
    !relayablePath(url.pathname, request.headers.get("authorization"))
  ) {
    return Response.json({ message: "Introuvable." }, { status: 404 });
  }

  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }

  const withBody = request.method !== "GET" && request.method !== "HEAD";

  let upstream: Response;
  try {
    upstream = await fetch(`${API_URL}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      // Le corps passe en flux : rien n'est mis en mémoire ici, et c'est
      // l'API qui applique ses propres bornes de taille.
      body: withBody ? request.body : undefined,
      duplex: withBody ? "half" : undefined,
      redirect: "manual",
      cache: "no-store",
    } as RequestInit & { duplex?: "half" });
  } catch {
    // 502 et non 4xx : Wings abandonne sur un 4xx, mais rejoue un 5xx. Une
    // API qui redémarre ne doit pas lui faire effacer un compte rendu.
    return Response.json({ message: "API injoignable." }, { status: 502 });
  }

  const returned = new Headers();
  upstream.headers.forEach((value, name) => {
    if (!DROPPED_RESPONSE_HEADERS.has(name)) returned.set(name, value);
  });

  return new Response(request.method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    headers: returned,
  });
}
