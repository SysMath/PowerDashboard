import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import {
  instanceDescriptorSchema,
  PUSH_RELAY_CLOCK_SKEW_MS,
  type PushOutcome,
  type PushRelaySend,
  pushRelaySignedText,
} from "@gamedashboard/contracts";
import { type Database, pushRelayHandles, pushRelayInstances } from "@gamedashboard/db";
import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { DATABASE } from "../../common/database.provider";
import { assertPublicDestination } from "../../common/public-url";
import { envoyerExpo } from "./expo-push";
import { pushText } from "./push-text";

/** Envois acceptés par instance et par heure : au-delà, refusés jusqu'à l'heure suivante. */
export const RELAIS_ENVOIS_PAR_HEURE = 2_000;

/** Poignées par instance : de quoi servir un grand panel, pas de quoi remplir la base. */
export const RELAIS_POIGNEES_PAR_INSTANCE = 20_000;

/** Lecture du descripteur d'un panel qui s'enregistre. */
const DESCRIPTEUR_DELAI_MS = 5_000;
const DESCRIPTEUR_OCTETS = 16_384;

export type IssueEnregistrement = "enregistree" | "refusee";
export type IssueEnvoi =
  | { issue: "envoye"; resultats: PushOutcome[] }
  | { issue: "inconnue" | "signature" | "perime" | "rejoue" | "coupee" | "debit" | "indisponible" };

const sha256 = (texte: string) => createHash("sha256").update(texte).digest("hex");

/**
 * Le relais de notifications de l'éditeur (`PUSH_RELAY=1`, ADR 0010).
 *
 * Il garde seul le jeton d'accès Expo, et ne sert qu'à ceci : qu'un panel
 * qu'il ne connaît pas puisse écrire aux téléphones qui l'ont lié, et à eux
 * seuls. Une instance n'atteint que les poignées inscrites pour elle ; le
 * texte est composé ici, depuis le contenu fermé ; rien n'est gardé après
 * l'envoi hormis les poignées.
 */
@Injectable()
export class RelaisService {
  /** Envois de l'heure en cours, par instance. Un seul processus, comme l'API. */
  private readonly debit = new Map<string, { heure: number; compte: number }>();
  /** Signatures déjà vues dans la fenêtre d'horloge : un envoi capté ne se rejoue pas. */
  private readonly vues = new Map<string, number>();

  /** Remplaçable par les tests ; jamais par la configuration. */
  appel: typeof fetch = (entree, init) => fetch(entree, init);

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Enregistre une instance, ou change sa clé, si son descripteur publie
   * bien cette clé à l'origine annoncée.
   */
  async enregistrer(input: {
    instance: string;
    cle: string;
    origine: string;
  }): Promise<IssueEnregistrement> {
    if (!estCleEd25519(input.cle)) return "refusee";
    const descripteur = await this.lireDescripteur(input.origine);
    if (
      !descripteur ||
      descripteur.instance !== input.instance ||
      descripteur.cle_notifications !== input.cle
    ) {
      return "refusee";
    }
    await this.db
      .insert(pushRelayInstances)
      .values({ instance: input.instance, publicKey: input.cle })
      .onConflictDoUpdate({ target: pushRelayInstances.instance, set: { publicKey: input.cle } });
    return "enregistree";
  }

  /**
   * Inscrit le jeton Expo d'un téléphone pour une instance, et rend sa
   * poignée. Réinscrire le même jeton en tire une nouvelle : l'ancienne ne
   * vaut plus rien.
   */
  async inscrire(input: { instance: string; jeton: string }): Promise<string | null> {
    const [instance] = await this.db
      .select({ suspendedAt: pushRelayInstances.suspendedAt })
      .from(pushRelayInstances)
      .where(eq(pushRelayInstances.instance, input.instance))
      .limit(1);
    if (!instance || instance.suspendedAt) return null;
    const [{ n } = { n: 0 }] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(pushRelayHandles)
      .where(
        and(
          eq(pushRelayHandles.instance, input.instance),
          // Le téléphone qui se réinscrit remplace sa propre ligne : il ne
          // compte pas contre la limite.
          ne(pushRelayHandles.expoToken, input.jeton),
        ),
      );
    if (n >= RELAIS_POIGNEES_PAR_INSTANCE) return null;

    const poignee = randomBytes(32).toString("base64url");
    await this.db.transaction(async (tx) => {
      await tx
        .delete(pushRelayHandles)
        .where(
          and(
            eq(pushRelayHandles.instance, input.instance),
            eq(pushRelayHandles.expoToken, input.jeton),
          ),
        );
      await tx.insert(pushRelayHandles).values({
        handleHash: sha256(poignee),
        instance: input.instance,
        expoToken: input.jeton,
      });
    });
    return poignee;
  }

  /** Vérifie un envoi signé, puis le confie à Expo. */
  async envoyer(
    envoi: PushRelaySend,
    signature: string,
    jetonExpo: string | null,
    maintenant = Date.now(),
  ): Promise<IssueEnvoi> {
    if (!jetonExpo) return { issue: "indisponible" };
    const [instance] = await this.db
      .select()
      .from(pushRelayInstances)
      .where(eq(pushRelayInstances.instance, envoi.instance))
      .limit(1);
    if (!instance) return { issue: "inconnue" };
    if (!signatureValide(instance.publicKey, pushRelaySignedText(envoi), signature)) {
      return { issue: "signature" };
    }
    if (Math.abs(maintenant - envoi.horodatage) > PUSH_RELAY_CLOCK_SKEW_MS) {
      return { issue: "perime" };
    }
    this.oublierVues(maintenant);
    if (this.vues.has(signature)) return { issue: "rejoue" };
    this.vues.set(signature, maintenant + 2 * PUSH_RELAY_CLOCK_SKEW_MS);
    if (instance.suspendedAt) return { issue: "coupee" };
    if (!this.consommer(envoi.instance, envoi.messages.length, maintenant)) {
      return { issue: "debit" };
    }

    const condensats = envoi.messages.map((message) => sha256(message.poignee));
    const lignes = await this.db
      .select({ handleHash: pushRelayHandles.handleHash, expoToken: pushRelayHandles.expoToken })
      .from(pushRelayHandles)
      .where(
        and(
          eq(pushRelayHandles.instance, envoi.instance),
          inArray(pushRelayHandles.handleHash, condensats),
        ),
      );
    const jetons = new Map(lignes.map((ligne) => [ligne.handleHash, ligne.expoToken]));
    const connus = envoi.messages.flatMap((message, rang) => {
      const jeton = jetons.get(condensats[rang] ?? "");
      return jeton ? [{ rang, jeton, message }] : [];
    });

    const issues = await envoyerExpo(
      connus.map(({ jeton, message }) => ({
        to: jeton,
        ...pushText(message),
        data: {
          instance: envoi.instance,
          notification: message.notification,
          type: message.type,
        },
      })),
      jetonExpo,
      this.appel,
    );
    // Un téléphone désinscrit chez Expo : sa poignée est effacée ici aussi.
    const perdus = connus.filter((_, rang) => issues[rang] === "inconnue");
    if (perdus.length > 0) {
      await this.db.delete(pushRelayHandles).where(
        inArray(
          pushRelayHandles.handleHash,
          perdus.map(({ rang }) => condensats[rang] ?? ""),
        ),
      );
    }

    const resultats = envoi.messages.map((): PushOutcome => "inconnue");
    connus.forEach(({ rang }, position) => {
      resultats[rang] = issues[position] ?? "reessayer";
    });
    return { issue: "envoye", resultats };
  }

  private consommer(instance: string, nombre: number, maintenant: number): boolean {
    const heure = Math.floor(maintenant / 3_600_000);
    const courant = this.debit.get(instance);
    const compte = courant?.heure === heure ? courant.compte : 0;
    if (compte + nombre > RELAIS_ENVOIS_PAR_HEURE) return false;
    this.debit.set(instance, { heure, compte: compte + nombre });
    return true;
  }

  private oublierVues(maintenant: number): void {
    for (const [signature, expire] of this.vues) {
      if (expire <= maintenant) this.vues.delete(signature);
    }
  }

  /**
   * Le descripteur du panel, lu à son origine publique seulement : le relais
   * n'appelle jamais une adresse interne pour le compte d'un inconnu, ne
   * suit aucune redirection et ne rend rien de ce qu'il a lu.
   */
  private async lireDescripteur(origine: string) {
    try {
      const url = new URL("/.well-known/gamedashboard", origine);
      if (url.protocol !== "https:") return null;
      await assertPublicDestination(url);
      const reponse = await this.appel(url, {
        redirect: "error",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(DESCRIPTEUR_DELAI_MS),
      });
      if (!reponse.ok) return null;
      const texte = await reponse.text();
      if (texte.length > DESCRIPTEUR_OCTETS) return null;
      const lu = instanceDescriptorSchema.safeParse(JSON.parse(texte));
      return lu.success ? lu.data : null;
    } catch {
      return null;
    }
  }
}

function estCleEd25519(cle: string): boolean {
  try {
    const objet = createPublicKey({ key: Buffer.from(cle, "base64"), format: "der", type: "spki" });
    return objet.asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}

function signatureValide(cle: string, texte: string, signature: string): boolean {
  try {
    const objet = createPublicKey({ key: Buffer.from(cle, "base64"), format: "der", type: "spki" });
    return verify(null, Buffer.from(texte), objet, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}
