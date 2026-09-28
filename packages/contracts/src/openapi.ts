import {
  APPLICATION_ROUTES,
  type ApiRoute,
  CLIENT_ROUTES,
  type HttpMethod,
  SESSION_ROUTES,
} from "./api-catalogue";

/**
 * La spécification OpenAPI du panel, **dérivée du catalogue**.
 *
 * Elle n'est pas écrite à la main, et c'est le point : une spécification
 * maintenue à côté du code dit la vérité le jour où on l'écrit, puis ment
 * doucement. Ici, ajouter une route au catalogue la fait apparaître dans la
 * spécification, et le contrôle de non-régression en intégration continue
 * compare le fichier livré à ce que le code produit — une route ajoutée sans
 * régénérer fait échouer la construction.
 *
 * **Ce qu'elle décrit, et ce qu'elle ne décrit pas.** Les chemins, les verbes,
 * les paramètres, l'authentification exigée et la portée requise : tout cela
 * vient du catalogue et est exact. Les corps de requête et de réponse ne sont
 * décrits que là où un schéma existe — les déclarer vaguement partout serait
 * pire que de ne rien dire, puisqu'un outil de génération produirait des types
 * faux avec l'assurance d'un contrat.
 *
 * Trois familles, et elles n'ont pas la même porte :
 *
 * - **session** : le panel lui-même, par cookie. Documentée parce qu'elle
 *   existe et qu'on la voit passer, pas parce qu'on invite à s'en servir ;
 * - **client** : une clé personnelle, au nom d'un utilisateur, bornée par des
 *   portées ;
 * - **application** : une clé de plateforme, pour un système tiers qui
 *   provisionne — boutique, facturation. Elle n'agit au nom de personne.
 */

/** Version du document, distincte de celle du panel : elle ne bouge qu'avec l'API. */
export const OPENAPI_VERSION = "1.0.0";

interface OpenApiParameter {
  name: string;
  in: "path" | "query";
  required: boolean;
  description: string;
  schema: { type: "string" };
}

interface OpenApiOperation {
  summary: string;
  description?: string;
  tags: string[];
  operationId: string;
  parameters?: OpenApiParameter[];
  security: Record<string, string[]>[];
  responses: Record<string, { description: string; content?: unknown }>;
  "x-gd-scope"?: string;
}

export interface OpenApiDocument {
  openapi: "3.1.0";
  info: { title: string; version: string; description: string };
  servers: { url: string; description: string }[];
  tags: { name: string; description?: string }[];
  paths: Record<string, Partial<Record<Lowercase<HttpMethod>, OpenApiOperation>>>;
  components: { securitySchemes: Record<string, unknown>; schemas: Record<string, unknown> };
}

/** Les trois familles, avec leur préfixe et le nom de leur sécurité. */
const FAMILLES = [
  { routes: SESSION_ROUTES, prefixe: "/api/v1", securite: "sessionCookie", famille: "session" },
  { routes: CLIENT_ROUTES, prefixe: "/api/v1/client", securite: "clientKey", famille: "client" },
  {
    routes: APPLICATION_ROUTES,
    prefixe: "/api/v1/application",
    securite: "applicationKey",
    famille: "application",
  },
] as const;

export function buildOpenApiDocument(baseUrl = "https://panel.example"): OpenApiDocument {
  const paths: OpenApiDocument["paths"] = {};
  const tags = new Map<string, string>();

  for (const { routes, prefixe, securite, famille } of FAMILLES) {
    for (const route of routes) {
      const { chemin, parametres } = decomposer(route.path);
      const complet = `${prefixe}${chemin}`;
      const verbe = route.method.toLowerCase() as Lowercase<HttpMethod>;

      tags.set(route.group, "");
      paths[complet] ??= {};
      paths[complet][verbe] = {
        summary: route.summary,
        description: descriptionDe(route, famille),
        tags: [route.group],
        operationId: identifiant(famille, route),
        ...(parametres.length > 0 ? { parameters: parametres } : {}),
        security: [{ [securite]: route.scope ? [route.scope] : [] }],
        ...(route.scope ? { "x-gd-scope": route.scope } : {}),
        responses: reponsesDe(route),
      };
    }
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "API GameDashboard",
      version: OPENAPI_VERSION,
      description:
        "Panel de gestion de serveurs de jeu. Les erreurs suivent Problem Details (RFC 9457) : " +
        "un corps JSON portant `title`, `status` et `detail`, et non un simple texte.",
    },
    servers: [{ url: baseUrl, description: "Le panel, sur son domaine" }],
    tags: [...tags.keys()].sort().map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        /*
         * Le cookie est déclaré, mais aucun outil ne devrait s'en servir : il
         * est `__Host-`, `SameSite` et `HttpOnly`, donc inatteignable depuis
         * un script. Le documenter dit ce qui se passe réellement lorsqu'on
         * navigue, et évite qu'on prenne ces routes pour des routes ouvertes.
         */
        sessionCookie: {
          type: "apiKey",
          in: "cookie",
          name: "__Host-gd_session",
          description:
            "Cookie de session du panel. Posé à la connexion, illisible par un script, " +
            "et donc inutilisable depuis un client tiers.",
        },
        clientKey: {
          type: "http",
          scheme: "bearer",
          description:
            "Clé personnelle, créée depuis « Compte → Clés d'API ». Elle agit au nom de son " +
            "propriétaire et ne porte jamais plus que les portées qu'on lui a données.",
        },
        applicationKey: {
          type: "http",
          scheme: "bearer",
          description:
            "Clé de plateforme, créée depuis l'administration. Elle n'agit au nom de personne : " +
            "elle provisionne, suspend et résilie pour le compte d'un système tiers.",
        },
      },
      schemas: {
        /*
         * Le seul schéma décrit d'emblée, parce que c'est le seul que **toutes**
         * les routes peuvent rendre. Un client qui ne sait lire que les succès
         * rapporte « erreur inconnue » sur des refus parfaitement explicites.
         */
        Problem: {
          type: "object",
          description: "Refus ou erreur, au format Problem Details (RFC 9457).",
          properties: {
            title: { type: "string", description: "Ce qui s'est passé, en une phrase." },
            status: { type: "integer", description: "Le code HTTP, répété dans le corps." },
            detail: { type: "string", description: "Le détail utile, quand il y en a un." },
          },
          required: ["title", "status"],
        },
      },
    },
  };
}

/**
 * Sépare le chemin de ses paramètres.
 *
 * Le catalogue écrit parfois la requête dans le chemin — `/files?directory={x}`
 * — parce que c'est ainsi qu'un lecteur humain la comprend le plus vite. Une
 * spécification, elle, exige les deux séparés : un chemin qui contient `?`
 * n'est pas un chemin, et les outils le rejettent sans expliquer pourquoi.
 */
function decomposer(brut: string): { chemin: string; parametres: OpenApiParameter[] } {
  const [chemin = "", requete] = brut.split("?");
  const parametres: OpenApiParameter[] = [];

  for (const nom of gabarits(chemin)) {
    parametres.push({
      name: nom,
      in: "path",
      required: true,
      description: descriptionParametre(nom),
      schema: { type: "string" },
    });
  }

  if (requete) {
    for (const paire of requete.split("&")) {
      const nom = paire.split("=")[0];
      if (!nom) continue;
      parametres.push({
        name: nom,
        in: "query",
        // Facultatif par défaut : le catalogue ne distingue pas, et déclarer
        // obligatoire ce qui ne l'est pas ferait échouer des appels valides
        // chez qui suit la spécification à la lettre.
        required: false,
        description: descriptionParametre(nom),
        schema: { type: "string" },
      });
    }
  }

  return { chemin, parametres };
}

function gabarits(chemin: string): string[] {
  return [...chemin.matchAll(/\{([^}]+)\}/g)].map((m) => m[1] ?? "").filter((n) => n !== "");
}

/** Ce que désignent les gabarits qui reviennent partout. */
const PARAMETRES_CONNUS: Record<string, string> = {
  server: "Identifiant du serveur, ou son identifiant court.",
  backup: "Identifiant de la sauvegarde.",
  schedule: "Identifiant de la tâche planifiée.",
  database: "Identifiant de la base de données.",
  user: "Identifiant du compte.",
  node: "Identifiant de la machine.",
  chemin: "Chemin dans le volume du serveur, à partir de la racine.",
  directory: "Répertoire à lister, à partir de la racine du volume.",
  file: "Chemin du fichier, à partir de la racine du volume.",
  from: "Premier jour, inclus (AAAA-MM-JJ, temps universel). Par défaut le 1er du mois de « to ».",
  to: "Dernier jour, inclus (AAAA-MM-JJ, temps universel). Par défaut aujourd'hui.",
  format: "« csv » (par défaut) ou « jsonl », un objet JSON par ligne.",
  serverId: "Ne garder qu'un serveur.",
  ownerId: "Ne garder que les serveurs de ce compte (pour la consommation : titulaire du jour).",
  page: "Page demandée, à partir de 1.",
};

function descriptionParametre(nom: string): string {
  return PARAMETRES_CONNUS[nom] ?? `Valeur de « ${nom} ».`;
}

/**
 * Ce qu'une opération rend.
 *
 * Décrit sans schéma de succès, faute de le connaître route par route — mais
 * **avec** les refus, qui eux sont uniformes et dont la forme compte pour qui
 * écrit un client. Annoncer un `200 application/json` vide serait plus
 * trompeur qu'utile.
 */
function reponsesDe(route: ApiRoute): OpenApiOperation["responses"] {
  const succes = route.method === "POST" ? "Effectué." : "Résultat de la lecture.";
  return {
    "2XX": { description: succes },
    "400": {
      description: "Demande refusée : la cause est dans le corps.",
      content: { "application/json": { schema: { $ref: "#/components/schemas/Problem" } } },
    },
    "401": { description: "Aucune authentification recevable." },
    "403": {
      // Deux causes, que le message du corps distingue : la clé (portée,
      // route réservée à la plateforme) ou l'état de la ressource visée (un
      // compte suspendu, par exemple).
      description: route.scope
        ? `Authentifié, mais sans la portée « ${route.scope} », ou refusé pour la ressource visée : la cause est dans le corps.`
        : "Authentifié, mais sans le droit sur cette ressource : la cause est dans le corps.",
      content: { "application/json": { schema: { $ref: "#/components/schemas/Problem" } } },
    },
  };
}

function descriptionDe(route: ApiRoute, famille: string): string {
  const porte =
    famille === "application"
      ? "Clé de plateforme."
      : famille === "client"
        ? "Clé personnelle."
        : "Session du panel.";
  return route.scope ? `${porte} Portée requise : \`${route.scope}\`.` : porte;
}

/**
 * Un identifiant d'opération stable, que les générateurs emploient pour nommer
 * les méthodes du client qu'ils produisent.
 *
 * Dérivé du chemin plutôt que d'un compteur : un compteur renommerait toutes
 * les méthodes d'un client dès qu'on insère une route au milieu de la liste.
 */
function identifiant(famille: string, route: ApiRoute): string {
  const morceaux = route.path
    .split("?")[0]
    ?.split("/")
    .filter((m) => m !== "")
    .map((m) => (m.startsWith("{") ? `by-${m.slice(1, -1)}` : m));

  return [famille, route.method.toLowerCase(), ...(morceaux ?? [])]
    .join("-")
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .replace(/-+/g, "-");
}
