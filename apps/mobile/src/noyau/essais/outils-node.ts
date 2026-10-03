import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import { CLE_VERROUILLEE, type CleAppareil, type Coffre } from "../outils";

/*
 * Les outils du téléphone, rejoués avec ceux de Node pour les tests du noyau :
 * même courbe, mêmes encodages que le Secure Enclave et le Keystore.
 */

export const hasardNode = (taille: number) => new Uint8Array(randomBytes(taille));

export const sha256Node = async (texte: string) =>
  new Uint8Array(createHash("sha256").update(texte, "utf8").digest());

export function coffreMemoire(): Coffre & { valeurs: Map<string, string> } {
  const valeurs = new Map<string, string>();
  return {
    valeurs,
    lire: async (cle) => valeurs.get(cle) ?? null,
    ecrire: async (cle, valeur) => {
      valeurs.set(cle, valeur);
    },
    effacer: async (cle) => {
      valeurs.delete(cle);
    },
  };
}

/** En-tête SPKI d'une clé publique P-256, celui que le panel ajoute au point brut d'iOS. */
const ENTETE_SPKI_P256 = Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex");

/**
 * Une clé d'appareil factice. `forme` choisit l'encodage de la clé publique :
 * `brut` comme iOS (point de 65 octets), `spki` comme Android.
 */
export function cleFactice(forme: "brut" | "spki" = "brut") {
  const cles = new Map<string, KeyObject>();
  const etat = { verrouillee: false, presences: 0 };
  const cle: CleAppareil = {
    async creer(alias) {
      const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
      cles.set(alias, privateKey);
      const spki = publicKey.export({ format: "der", type: "spki" });
      return (forme === "spki" ? spki : spki.subarray(ENTETE_SPKI_P256.length)).toString("base64");
    },
    async signer(alias, message) {
      if (etat.verrouillee) throw new Error(CLE_VERROUILLEE);
      const privee = cles.get(alias);
      if (!privee) throw new Error("CLE_ABSENTE");
      return sign("sha256", Buffer.from(message, "utf8"), {
        key: privee,
        dsaEncoding: "der",
      }).toString("base64");
    },
    async signerEnPresence(alias, message) {
      etat.presences += 1;
      etat.verrouillee = false;
      return cle.signer(alias, message);
    },
    async deverrouiller() {
      etat.verrouillee = false;
      return true;
    },
    async supprimer(alias) {
      cles.delete(alias);
    },
  };
  return { cle, cles, etat };
}

/** La vérification du panel (`verifyDeviceSignature`), rejouée ici. */
export function signatureValide(publicKey: string, message: string, signature: string): boolean {
  const der = Buffer.from(publicKey, "base64");
  const spki = der.length === 65 ? Buffer.concat([ENTETE_SPKI_P256, der]) : der;
  const cle = createPublicKey({ key: spki, format: "der", type: "spki" });
  return verify(
    "sha256",
    Buffer.from(message, "utf8"),
    { key: cle, dsaEncoding: "der" },
    Buffer.from(signature, "base64"),
  );
}

/** Une réponse JSON du panel. */
export function reponse(corps: unknown, status = 200, url?: string): Response {
  const r = new Response(corps === undefined ? "" : JSON.stringify(corps), {
    status,
    headers: { "content-type": "application/json" },
  });
  if (url) Object.defineProperty(r, "url", { value: url });
  return r;
}
