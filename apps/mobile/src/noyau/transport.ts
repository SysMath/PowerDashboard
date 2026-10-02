/**
 * Les appels au panel que fait l'application en dehors du SDK : la liaison et
 * le renouvellement, qui ne portent pas encore de jeton d'accès.
 */

/** Un refus du panel (`status` HTTP), ou `status` 0 quand rien n'a répondu. */
export class EchecPanel extends Error {
  constructor(
    readonly status: number,
    readonly detail: string | null,
  ) {
    super(detail ?? (status === 0 ? "Panel injoignable." : `Le panel a répondu ${status}.`));
    this.name = "EchecPanel";
  }
}

export async function appelerPanel<T>(
  fetch: typeof globalThis.fetch,
  adresse: string,
  requete: {
    method: "GET" | "POST" | "DELETE";
    path: string;
    body?: unknown;
    jeton?: string;
    delaiMs?: number;
  },
): Promise<T> {
  const controleur = new AbortController();
  const minuterie = setTimeout(() => controleur.abort(), requete.delaiMs ?? 15_000);
  let reponse: Response;
  try {
    reponse = await fetch(`${adresse}${requete.path}`, {
      method: requete.method,
      headers: {
        Accept: "application/json",
        ...(requete.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(requete.jeton ? { Authorization: `Bearer ${requete.jeton}` } : {}),
      },
      body: requete.body === undefined ? undefined : JSON.stringify(requete.body),
      signal: controleur.signal,
    });
  } catch {
    throw new EchecPanel(0, null);
  } finally {
    clearTimeout(minuterie);
  }
  const corps = (await reponse.json().catch(() => null)) as {
    data?: T;
    message?: unknown;
  } | null;
  if (!reponse.ok) {
    throw new EchecPanel(reponse.status, typeof corps?.message === "string" ? corps.message : null);
  }
  return corps?.data as T;
}
