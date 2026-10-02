import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Mots de passe à usage unique fondés sur le temps (RFC 6238).
 *
 * Écrit ici plutôt qu'emprunté : l'algorithme tient en trente lignes, il n'a
 * pas bougé depuis 2011, et une dépendance de plus dans le chemin
 * d'authentification est une surface d'approvisionnement de plus. La partie
 * délicate n'est pas le calcul mais ce qui l'entoure — fenêtre de tolérance,
 * rejeu, comparaison à durée constante — et c'est justement ce qu'on veut
 * pouvoir relire.
 */

/** Durée d'un pas, en secondes. Trente est la valeur qu'attendent les applications. */
export const TOTP_PERIOD_SECONDS = 30;

/** Longueur du code. Six chiffres : ce que saisissent les gens, et ce qu'affichent les applications. */
export const TOTP_DIGITS = 6;

/**
 * Tolérance, en pas, de part et d'autre du pas courant.
 *
 * Un pas d'écart accepte une horloge de téléphone décalée d'une demi-minute et
 * le temps de recopier six chiffres. Zéro ferait échouer des codes justes ;
 * au-delà, la fenêtre d'un code volé s'allonge pour rien.
 */
export const TOTP_WINDOW_STEPS = 1;

/**
 * SHA-1 est l'algorithme du protocole, pas un choix.
 *
 * Google Authenticator, Aegis et la plupart des autres ne lisent que celui-ci.
 * Sa faiblesse est la collision, hors sujet ici : HMAC-SHA1 reste solide, et
 * la clé n'est utilisée qu'avec un compteur de trente secondes.
 */
const ALGORITHM = "sha1";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * Encodage base32 (RFC 4648), sans remplissage.
 *
 * C'est la forme qu'attendent les URI `otpauth:` et que les applications
 * savent saisir à la main quand la caméra ne veut rien savoir.
 */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  // Les bits restants sont complétés par des zéros à droite : c'est ce que
  // fait la RFC, et ce que décodera l'application en face.
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];

  return output;
}

export class InvalidBase32Error extends Error {
  constructor(character: string) {
    super(`Caractère « ${character} » invalide dans un secret base32.`);
    this.name = "InvalidBase32Error";
  }
}

/**
 * Décodage base32.
 *
 * Les minuscules sont acceptées et le remplissage ignoré : un secret recopié
 * depuis un gestionnaire de mots de passe arrive dans toutes les formes, et
 * refuser sur une casse serait incompréhensible. Un caractère hors alphabet,
 * en revanche, est une erreur — l'ignorer silencieusement donnerait une clé
 * différente de celle qu'on croit avoir saisie, et des codes toujours faux
 * sans que rien ne dise pourquoi.
 */
export function base32Decode(input: string): Uint8Array {
  // Le remplissage final est retiré par une boucle : `replace(/=+$/, "")` est
  // quadratique sur « ====…x », et CodeQL le signale.
  let fin = input.length;
  while (fin > 0 && input[fin - 1] === "=") fin--;
  const cleaned = input.slice(0, fin).replace(/\s+/g, "").toUpperCase();
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;

  for (const character of cleaned) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) throw new InvalidBase32Error(character);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Uint8Array.from(bytes);
}

/**
 * Secret TOTP, en base32.
 *
 * Vingt octets, soit la taille du condensat SHA-1 : c'est ce que recommande la
 * RFC 4226 et ce qu'attendent les applications. Plus court affaiblirait, plus
 * long serait tronqué par certaines d'entre elles.
 */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** Numéro du pas courant. Exposé pour que l'anti-rejeu puisse le comparer. */
export function totpStep(at: Date = new Date()): number {
  return Math.floor(at.getTime() / 1000 / TOTP_PERIOD_SECONDS);
}

/**
 * Code d'un pas donné (HOTP de la RFC 4226, appliqué au temps).
 *
 * La « troncature dynamique » n'est pas une fantaisie : prendre les quatre
 * derniers octets du condensat plutôt qu'un décalage choisi par l'implémenteur
 * évite que tout le monde lise la même zone du HMAC.
 */
export function totpCodeAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  // Un pas tient largement dans 32 bits jusqu'en l'an 6000 ; les quatre octets
  // de poids fort restent donc à zéro, comme le veut le protocole.
  counter.writeUInt32BE(Math.floor(step / 2 ** 32), 0);
  counter.writeUInt32BE(step >>> 0, 4);

  const digest = createHmac(ALGORITHM, Buffer.from(base32Decode(secret)))
    .update(counter)
    .digest();

  // Troncature dynamique : les quatre derniers bits du condensat désignent où
  // lire les quatre octets à garder. Le masque efface le bit de signe, sans
  // quoi la moitié des codes seraient négatifs selon l'arithmétique du langage.
  const offset = digest.readUInt8(digest.length - 1) & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;

  return (binary % 10 ** TOTP_DIGITS).toString().padStart(TOTP_DIGITS, "0");
}

/** Résultat d'une vérification. `step` sert à interdire le rejeu du même code. */
export interface TotpVerification {
  valid: boolean;
  /** Pas auquel le code correspondait, ou `null` s'il ne correspondait à aucun. */
  step: number | null;
}

/**
 * Vérifie un code dans la fenêtre de tolérance.
 *
 * `lastUsedStep` **doit** être fourni dès qu'il existe : sans lui, un code
 * intercepté reste utilisable pendant toute la fenêtre, et c'est précisément
 * ce contre quoi une seconde preuve d'identité est censée protéger. Un code
 * déjà consommé est refusé même s'il est mathématiquement juste.
 */
export function verifyTotp(
  secret: string,
  code: string,
  options: { at?: Date; lastUsedStep?: number | null } = {},
): TotpVerification {
  const cleaned = code.replace(/\s+/g, "");
  if (!new RegExp(`^[0-9]{${TOTP_DIGITS}}$`).test(cleaned)) return { valid: false, step: null };

  const current = totpStep(options.at);
  for (let offset = -TOTP_WINDOW_STEPS; offset <= TOTP_WINDOW_STEPS; offset += 1) {
    const step = current + offset;
    // Rejeu : le pas a déjà servi. On continue la boucle plutôt que d'abandonner,
    // car un pas plus récent de la fenêtre peut encore être valide.
    if (options.lastUsedStep != null && step <= options.lastUsedStep) continue;
    if (constantTimeEquals(totpCodeAt(secret, step), cleaned)) return { valid: true, step };
  }

  return { valid: false, step: null };
}

/**
 * URI `otpauth:` à passer au QR code.
 *
 * L'émetteur apparaît deux fois — dans l'étiquette et en paramètre — et c'est
 * voulu : les applications anciennes ne lisent que l'étiquette, les récentes
 * préfèrent le paramètre. N'en mettre qu'un affiche « (sans nom) » chez une
 * partie des gens.
 */
export function otpauthUri(options: { issuer: string; account: string; secret: string }): string {
  const label = encodeURIComponent(`${options.issuer}:${options.account}`);
  const parameters = new URLSearchParams({
    secret: options.secret,
    issuer: options.issuer,
    algorithm: ALGORITHM.toUpperCase(),
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${parameters.toString()}`;
}

/**
 * Comparaison à durée constante de deux codes.
 *
 * Six chiffres, un million de possibilités : une comparaison qui s'arrête au
 * premier caractère différent laisse mesurer combien de chiffres sont justes,
 * et ramène la recherche de un million d'essais à soixante.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
