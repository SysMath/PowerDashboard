/**
 * Envoie l'AAB sur une piste de test de Google Play (ADR 0010).
 *
 *   node apps/mobile/scripts/google-play.mts <fichier.aab> <version>
 *
 * Lancé par mobile.yml, dans l'environnement `magasins`, avec le compte de
 * service de l'API Google Play Developer dans PLAY_COMPTE_SERVICE (JSON).
 * Aucune dépendance : la session « edits » de l'API, signée à la main
 * (RS256), comme le décrit la documentation de Google. Piste `internal` par
 * défaut ; PLAY_STATUT vaut `completed`, ou `draft` tant que la fiche de
 * l'application n'a jamais été publiée (Google refuse alors toute autre
 * valeur). La publication au public reste un geste de la console.
 */
import { createHash, createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { IDENTIFIANT } from "../identifiant.ts";

export interface CompteService {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface Envoi {
  compte: CompteService;
  paquet: string;
  aab: Uint8Array<ArrayBuffer>;
  nom: string;
  piste?: string;
  statut?: "completed" | "draft";
  fetch?: typeof fetch;
  maintenant?: () => number;
}

const API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";
const ENVOI = "https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications";
const PORTEE = "https://www.googleapis.com/auth/androidpublisher";
const JETON = "https://oauth2.googleapis.com/token";

const base64Url = (octets: Buffer | string) => Buffer.from(octets).toString("base64url");

/** L'assertion JWT du compte de service, valable une heure. */
export function assertion(compte: CompteService, secondes: number): string {
  const entete = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const corps = base64Url(
    JSON.stringify({
      iss: compte.client_email,
      scope: PORTEE,
      aud: compte.token_uri ?? JETON,
      iat: secondes,
      exp: secondes + 3600,
    }),
  );
  const signature = createSign("RSA-SHA256").update(`${entete}.${corps}`).sign(compte.private_key);
  return `${entete}.${corps}.${base64Url(signature)}`;
}

async function lire<T>(reponse: Response, etape: string): Promise<T> {
  if (!reponse.ok) {
    throw new Error(`Google Play, ${etape} : ${reponse.status} ${await reponse.text()}`);
  }
  return (await reponse.json()) as T;
}

/** Ouvre une session, dépose l'AAB, le place sur la piste, valide. Rend le code de version. */
export async function envoyer(envoi: Envoi): Promise<number> {
  const appel = envoi.fetch ?? fetch;
  const maintenant = envoi.maintenant ?? Date.now;
  const piste = envoi.piste ?? "internal";
  const { access_token } = await lire<{ access_token: string }>(
    await appel(envoi.compte.token_uri ?? JETON, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: assertion(envoi.compte, Math.floor(maintenant() / 1000)),
      }),
    }),
    "jeton",
  );
  const autorisation = { authorization: `Bearer ${access_token}` };
  const application = `${API}/${encodeURIComponent(envoi.paquet)}`;

  const { id } = await lire<{ id: string }>(
    await appel(`${application}/edits`, { method: "POST", headers: autorisation }),
    "session",
  );
  const session = `${application}/edits/${encodeURIComponent(id)}`;
  try {
    const bundle = await lire<{ versionCode: number; sha256: string }>(
      await appel(
        `${ENVOI}/${encodeURIComponent(envoi.paquet)}/edits/${encodeURIComponent(id)}/bundles?uploadType=media`,
        {
          method: "POST",
          headers: { ...autorisation, "content-type": "application/octet-stream" },
          body: new Blob([envoi.aab]),
        },
      ),
      "dépôt de l'AAB",
    );
    // Google rend l'empreinte du fichier reçu : elle doit être celle du nôtre.
    const empreinte = createHash("sha256").update(envoi.aab).digest("hex");
    if (bundle.sha256 !== empreinte) {
      throw new Error(`Google Play a reçu un autre fichier (${bundle.sha256} ≠ ${empreinte}).`);
    }
    await lire(
      await appel(`${session}/tracks/${encodeURIComponent(piste)}`, {
        method: "PUT",
        headers: { ...autorisation, "content-type": "application/json" },
        body: JSON.stringify({
          track: piste,
          releases: [
            {
              name: envoi.nom,
              versionCodes: [String(bundle.versionCode)],
              status: envoi.statut ?? "completed",
            },
          ],
        }),
      }),
      "piste",
    );
    await lire(
      await appel(`${session}:commit`, { method: "POST", headers: autorisation }),
      "validation",
    );
    return bundle.versionCode;
  } catch (erreur) {
    // Une session abandonnée expire seule ; la fermer évite de bloquer la suivante.
    await appel(session, { method: "DELETE", headers: autorisation }).catch(() => undefined);
    throw erreur;
  }
}

if (import.meta.main) {
  const [fichier, version] = process.argv.slice(2);
  const compte = process.env.PLAY_COMPTE_SERVICE;
  const statut = process.env.PLAY_STATUT || "completed";
  if (!fichier || !version || !compte) {
    console.error("usage : PLAY_COMPTE_SERVICE=… node google-play.mts <fichier.aab> <version>");
    process.exit(2);
  }
  if (statut !== "completed" && statut !== "draft") {
    console.error(`PLAY_STATUT invalide : ${statut} (completed ou draft)`);
    process.exit(2);
  }
  const code = await envoyer({
    compte: JSON.parse(compte) as CompteService,
    paquet: IDENTIFIANT,
    aab: readFileSync(fichier),
    nom: version,
    piste: process.env.PLAY_PISTE || "internal",
    statut,
  });
  console.log(`Version ${version} (code ${code}) envoyée sur la piste de test de Google Play.`);
}
