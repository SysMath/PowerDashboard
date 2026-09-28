/**
 * Interrogation d'un serveur Minecraft par son propre protocole.
 *
 * Wings ne connaît qu'un conteneur : la mémoire, le disque, le processeur. Il
 * ne sait pas combien de joueurs sont connectés, parce que ce n'est pas une
 * propriété du conteneur mais du **jeu** qui tourne dedans. C'est pourquoi le
 * §8.2 confie cette sonde au panel.
 *
 * Le protocole employé est le « Server List Ping » que tout client Minecraft
 * utilise pour afficher un serveur dans sa liste : une poignée de main, une
 * demande d'état, une réponse JSON. Il est public, stable depuis la 1.7, et
 * n'exige **aucune** configuration côté serveur de jeu — contrairement à la
 * requête GameSpy, qu'il faut activer dans `server.properties` et que
 * personne n'active.
 */

import { isPlayerName } from "@gamedashboard/contracts";
import { cleanStatusText, type GameStatus, PLAYER_SAMPLE_MAX } from "./game-status";

/*
 * Il vit dans l'API et non dans `@gamedashboard/contracts` : `Buffer` est propre à
 * Node, et ce paquet est partagé avec le navigateur. Y glisser un type Node
 * obligerait tout le front à embarquer les définitions du serveur.
 */

/*
 * Ce module ne fait que coder et décoder. La socket vit ailleurs : un format
 * se teste sans réseau, et c'est là que sont les erreurs qui coûtent cher.
 */

/**
 * Entier à longueur variable, tel que Minecraft l'emploie partout.
 *
 * Sept bits utiles par octet, le huitième disant « il y en a encore ». Tout le
 * protocole en dépend : une longueur mal codée décale la trame entière, et le
 * serveur ferme la connexion sans rien dire.
 */
export function encodeVarInt(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value >>> 0;

  do {
    let byte = rest & 0b0111_1111;
    rest >>>= 7;
    if (rest !== 0) byte |= 0b1000_0000;
    bytes.push(byte);
  } while (rest !== 0);

  return Buffer.from(bytes);
}

/**
 * Lit un entier à longueur variable, et dit où il s'arrête.
 *
 * `null` quand la trame est trop courte : c'est le cas normal d'une lecture en
 * cours, pas une erreur. L'appelant rappellera quand il aura reçu davantage.
 */
export function decodeVarInt(
  buffer: Buffer,
  offset = 0,
): { value: number; bytesRead: number } | null {
  let value = 0;
  let shift = 0;

  for (let i = 0; i < 5; i += 1) {
    const byte = buffer[offset + i];
    if (byte === undefined) return null;

    value |= (byte & 0b0111_1111) << shift;
    if ((byte & 0b1000_0000) === 0) return { value, bytesRead: i + 1 };
    shift += 7;
  }

  // Au-delà de cinq octets, la valeur ne tient plus dans un entier 32 bits :
  // la trame est corrompue, et continuer à lire donnerait n'importe quoi.
  return null;
}

/** Chaîne du protocole : sa longueur en VarInt, puis ses octets UTF-8. */
function encodeString(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([encodeVarInt(bytes.length), bytes]);
}

/**
 * La poignée de main, suivie de la demande d'état.
 *
 * Les deux partent ensemble : le serveur les traite à la suite, et attendre
 * une réponse entre les deux ferait un aller-retour de plus pour rien.
 *
 * `protocolVersion` à -1 signifie « je ne me prononce pas ». Un serveur
 * répond alors sans refuser au motif d'une version incompatible — ce qu'on
 * veut, puisqu'on ne cherche pas à jouer mais à compter.
 */
export function buildStatusRequest(host: string, port: number): Buffer {
  const handshake = Buffer.concat([
    encodeVarInt(0x00), // identifiant de paquet : poignée de main
    encodeVarInt(0xffff_ffff), // version du protocole : indéterminée
    encodeString(host),
    Buffer.from([(port >> 8) & 0xff, port & 0xff]),
    encodeVarInt(0x01), // état demandé : « status », pas « login »
  ]);

  const request = encodeVarInt(0x00); // identifiant de paquet : demande d'état

  return Buffer.concat([
    encodeVarInt(handshake.length),
    handshake,
    encodeVarInt(request.length),
    request,
  ]);
}

/** Ce qu'un serveur Minecraft dit de lui-même : la forme commune à tous les jeux. */
export type MinecraftStatus = GameStatus;

export { PLAYER_SAMPLE_MAX };

/**
 * Taille maximale d'une réponse d'état.
 *
 * Le protocole borne le JSON à 32 767 caractères, soit moins de 100 Kio même
 * tout en caractères de trois octets : au-delà, ce n'est plus un serveur
 * Minecraft qui répond. Sans plafond, le serveur de jeu — que le client
 * contrôle — pouvait faire accumuler au panel autant d'octets qu'il en
 * envoyait pendant le délai de la sonde.
 */
export const STATUS_FRAME_MAX_BYTES = 256 * 1024;

/** Identifiant nul que les serveurs donnent aux lignes décoratives de l'échantillon. */
const DECORATIVE_ID = "00000000-0000-0000-0000-000000000000";

/**
 * Lit l'échantillon de joueurs.
 *
 * Beaucoup de serveurs y glissent des lignes de texte (« §6Bienvenue ! ») avec
 * un identifiant nul : ce ne sont pas des joueurs. Seuls restent les noms qu'on
 * pourrait réellement viser dans une commande.
 */
function readSample(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const names: string[] = [];
  for (const entry of raw) {
    const player = (entry ?? {}) as { name?: unknown; id?: unknown };
    if (player.id === DECORATIVE_ID || !isPlayerName(player.name)) continue;
    if (!names.includes(player.name)) names.push(player.name);
    if (names.length >= PLAYER_SAMPLE_MAX) break;
  }
  return names;
}

/**
 * Extrait la réponse d'état d'une trame reçue.
 *
 * `null` tant que la trame est incomplète : la réponse tient rarement dans un
 * seul paquet TCP, et conclure trop tôt donnerait un serveur « injoignable »
 * qui répondait parfaitement.
 */
export function readStatusResponse(buffer: Buffer): MinecraftStatus | null {
  const length = decodeVarInt(buffer, 0);
  if (!length) return null;

  const total = length.bytesRead + length.value;
  if (buffer.length < total) return null;

  const packetId = decodeVarInt(buffer, length.bytesRead);
  // 0x00 est le seul identifiant attendu ici. Autre chose signifie qu'on parle
  // à un service qui n'est pas un serveur Minecraft.
  if (packetId?.value !== 0x00) return null;

  const jsonLength = decodeVarInt(buffer, length.bytesRead + packetId.bytesRead);
  if (!jsonLength) return null;

  const start = length.bytesRead + packetId.bytesRead + jsonLength.bytesRead;
  const raw = buffer.subarray(start, start + jsonLength.value).toString("utf8");

  return parseStatusJson(raw);
}

/**
 * Lit le JSON d'état, sans rien inventer.
 *
 * Le contenu vient d'un serveur de jeu que le client contrôle : il est traité
 * comme une donnée douteuse. Un champ absent ou d'un autre type donne `null`,
 * pas un zéro — « aucun joueur » et « je n'ai pas su lire » sont deux choses
 * différentes, et les confondre ferait afficher un serveur vide qui est plein.
 */
export function parseStatusJson(raw: string): MinecraftStatus | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const body = parsed as { players?: unknown; version?: unknown };
  const players = (body.players ?? {}) as { online?: unknown; max?: unknown; sample?: unknown };
  const version = (body.version ?? {}) as { name?: unknown };

  return {
    playersOnline: typeof players.online === "number" ? players.online : null,
    playersMax: typeof players.max === "number" ? players.max : null,
    // Borné et nettoyé comme la version d'A2S et de FiveM : lue telle quelle,
    // une version de plusieurs centaines de kilo-octets partait en base, et
    // chaque lecture du catalogue d'extensions la repassait par une regex.
    version: cleanStatusText(version.name),
    sample: readSample(players.sample),
  };
}
