import {
  APP_REDIRECT_URI,
  type AppAuthorizeQuery,
  appAuthorizeQuerySchema,
} from "@gamedashboard/contracts";

/**
 * Demande de liaison de l'application mobile (ADR 0010), côté interface.
 *
 * L'application ouvre `/auth/app/authorize?…` dans le navigateur du
 * téléphone. La demande est vérifiée, gardée dans un cookie le temps de la
 * connexion, puis la page « Autoriser l'application » rend la main à
 * l'application par `gamedashboard://liaison`, avec le code ou le refus.
 */

/** Lit et valide la demande dans l'adresse ; `null` si elle est mal formée. */
export function readAppLinkQuery(search: URLSearchParams): AppAuthorizeQuery | null {
  const parsed = appAuthorizeQuerySchema.safeParse(Object.fromEntries(search));
  return parsed.success ? parsed.data : null;
}

/** La demande, telle qu'elle dort dans le cookie : JSON en base64url. */
export function encodeAppLink(query: AppAuthorizeQuery): string {
  return Buffer.from(JSON.stringify(query), "utf8").toString("base64url");
}

/** Relit le cookie, et le revalide : il a pu être posé à la main. */
export function decodeAppLink(value: string | undefined): AppAuthorizeQuery | null {
  if (!value) return null;
  try {
    const parsed = appAuthorizeQuerySchema.safeParse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Adresse de retour vers l'application.
 *
 * Toujours `APP_REDIRECT_URI`, jamais une adresse venue de la demande : un
 * code ne doit pas pouvoir être envoyé ailleurs. `state` revient tel quel,
 * pour que l'application reconnaisse la liaison qu'elle a ouverte.
 */
export function appLinkReturn(
  query: Pick<AppAuthorizeQuery, "state">,
  outcome: { code: string } | { error: "access_denied" | "server_error" },
): string {
  const params = new URLSearchParams(
    "code" in outcome ? { code: outcome.code } : { error: outcome.error },
  );
  params.set("state", query.state);
  return `${APP_REDIRECT_URI}?${params.toString()}`;
}
