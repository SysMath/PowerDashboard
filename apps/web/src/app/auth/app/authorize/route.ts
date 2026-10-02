import { APP_LINK_COOKIE_MAX_AGE_S, appLinkCookieName } from "@gamedashboard/contracts";
import { type NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE_OPTIONS } from "@/lib/session-cookie";
import { encodeAppLink, readAppLinkQuery } from "@/server/app-link";
import { redirectWithin } from "@/server/ceremony";

/**
 * Entrée de la liaison de l'application mobile (ADR 0010).
 *
 * La demande est gardée dans un cookie court, puis la page « Autoriser
 * l'application » la reprend, après la connexion s'il le faut. Une demande
 * mal formée n'est pas renvoyée vers l'application : son adresse de retour
 * n'a pas été vérifiée, et le RFC 6749 (§4.1.2.1) interdit d'y rediriger.
 */
export function GET(request: NextRequest): NextResponse {
  const query = readAppLinkQuery(request.nextUrl.searchParams);
  if (!query) {
    return new NextResponse("Demande de liaison invalide. Recommencez depuis l'application.", {
      status: 400,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const response = redirectWithin("/app-link");
  response.cookies.set(appLinkCookieName(process.env), encodeAppLink(query), {
    ...AUTH_COOKIE_OPTIONS,
    maxAge: APP_LINK_COOKIE_MAX_AGE_S,
  });
  return response;
}

/** Jamais mise en cache : chaque demande porte son propre défi. */
export const dynamic = "force-dynamic";
