import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/session-cookie";
import { forwardedIdentityHeaders } from "@/server/api/forwarded";

const API_URL = process.env.API_URL ?? "http://127.0.0.1:3201";

/**
 * Relaie un téléchargement de l'API vers le navigateur, **en flux**.
 *
 * Même raison d'être que le relais de l'export du journal : le navigateur ne
 * parle jamais à l'API, et ni le rendu serveur ni une action serveur ne sait
 * rendre un fichier sans le tenir entier en mémoire. Les paramètres passent
 * tels quels : l'API les valide et c'est elle qui fait foi, périmètre compris.
 *
 * Un refus est rendu tel quel : « Période trop longue » en dit plus qu'un
 * échec générique.
 */
export async function relayDownload(request: Request, apiPath: string): Promise<Response> {
  const session = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!session) return Response.json({ message: "Session absente." }, { status: 401 });

  const search = new URL(request.url).search;
  const upstream = await fetch(`${API_URL}${apiPath}${search}`, {
    headers: {
      ...(await forwardedIdentityHeaders()),
      cookie: `${SESSION_COOKIE}=${session}`,
    },
    cache: "no-store",
    // Le navigateur abandonne le téléchargement : l'API cesse de lire la base.
    signal: request.signal,
  });

  if (!upstream.ok || !upstream.body) {
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
      "content-disposition": upstream.headers.get("content-disposition") ?? "attachment",
      "cache-control": "no-store",
    },
  });
}
