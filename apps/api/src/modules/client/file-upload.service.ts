import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { WingsClientService } from "../wings/wings-client.service";

/**
 * Envoi de fichiers **reprenable**, assemblé par le panel.
 *
 * L'envoi d'origine était une seule requête multipart du navigateur vers le
 * daemon. C'était le trajet le plus court, et c'est pourquoi il avait été
 * choisi ; mais il ne tient pas ses promesses dès que le fichier est gros :
 * pas de progression, et surtout **rien à reprendre**. Une coupure au bout de
 * deux gigaoctets renvoyait au premier octet.
 *
 * **Pourquoi le panel assemble, alors qu'il préférerait ne rien lire.** Wings
 * n'offre aucune écriture à un décalage : `POST /files/write` prend un corps
 * entier et exige son `Content-Length`. Il n'y a donc, sur un daemon non
 * modifié — et il ne l'est pas —, aucun moyen de compléter un fichier déjà
 * commencé. Reprendre suppose que quelqu'un garde les morceaux déjà reçus ;
 * ce quelqu'un ne peut être que le panel.
 *
 * Ce que cela coûte est assumé et borné : les morceaux vivent dans un dossier
 * temporaire, sont effacés dès l'assemblage, et le fichier part vers le daemon
 * **en flux** — il n'est jamais chargé en mémoire.
 */

/** Taille d'un morceau. Le navigateur la reçoit à l'ouverture de la session. */
export const CHUNK_SIZE = 8 * 1024 * 1024;

/**
 * Marge acceptée au-delà, pour le dernier morceau et les en-têtes.
 *
 * Le contrôle réel est ailleurs — Fastify refuse un corps trop grand avant que
 * ce service le voie. Celui-ci ne fait que refuser d'écrire ce qui ne peut
 * pas être un morceau.
 */
const CHUNK_LIMIT = CHUNK_SIZE + 64 * 1024;

/**
 * Au-delà, on refuse d'ouvrir la session.
 *
 * Cinq gigaoctets : un modpack lourd passe, une image disque non. La borne
 * existe parce que les morceaux occupent le disque du panel jusqu'à
 * l'assemblage — sans elle, un seul envoi le remplirait.
 */
const MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024;

/** Passé ce délai sans nouvelle, une session inachevée est du déchet. */
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Sessions ouvertes au plus, pour un même compte sur un même serveur.
 *
 * `MAX_FILE_SIZE` borne un envoi, pas leur nombre : chaque session garde ses
 * morceaux sur le disque du panel jusqu'à l'assemblage, et n'est balayée
 * qu'après six heures d'inactivité. Sans compteur, un seul compte ouvrait
 * autant de sessions de 5 Gio qu'il voulait et remplissait le disque du panel
 * — celui de tous les serveurs. L'interface envoie un fichier à la fois ;
 * cinq laisse de la place aux envois interrompus qu'on reprendra.
 */
export const MAX_OPEN_UPLOADS = 5;

interface SessionMeta {
  readonly serverId: string;
  readonly userId: string;
  /** Dossier de destination dans le volume, tel que le client l'a demandé. */
  readonly directory: string;
  readonly fileName: string;
  readonly size: number;
  readonly chunkSize: number;
  readonly chunks: number;
  readonly createdAt: string;
}

export interface UploadSession {
  readonly id: string;
  readonly chunkSize: number;
  readonly chunks: number;
  /** Les indices déjà reçus — c'est ce qui permet de reprendre. */
  readonly received: number[];
}

@Injectable()
export class FileUploadService {
  private readonly logger = new Logger(FileUploadService.name);
  private readonly racine = process.env.UPLOAD_TMP_DIR ?? join(tmpdir(), "gamedashboard-uploads");

  /**
   * Ouvertures en cours, par couple compte et serveur.
   *
   * Compter puis créer en deux temps laisserait passer N ouvertures
   * simultanées au plafond moins un — toutes compteraient avant qu'aucune
   * n'écrive. Elles passent donc une à une pour un même couple ; les autres
   * comptes ne s'attendent pas entre eux.
   */
  private readonly ouvertures = new Map<string, Promise<unknown>>();

  constructor(@Inject(WingsClientService) private readonly wings: WingsClientService) {}

  /**
   * Ouvre une session et dit au navigateur comment découper.
   *
   * Le nom du fichier est **nettoyé ici** et non à l'assemblage : c'est la
   * seule valeur de la session qui vienne du poste de l'utilisateur, et la
   * garder telle quelle jusqu'à la fin ferait porter le contrôle par le code
   * qui écrit — c'est-à-dire trop tard.
   */
  async open(
    serverId: string,
    userId: string,
    input: { directory: string; fileName: string; size: number },
  ): Promise<UploadSession> {
    if (!Number.isInteger(input.size) || input.size < 0) {
      throw new BadRequestException("Taille de fichier invalide.");
    }
    if (input.size > MAX_FILE_SIZE) {
      throw new BadRequestException(
        `Ce fichier dépasse la taille acceptée pour un envoi (${Math.floor(MAX_FILE_SIZE / 1024 / 1024 / 1024)} Go).`,
      );
    }

    const fileName = nomDeFichier(input.fileName);
    const id = randomBytes(16).toString("hex");
    const chunks = Math.max(1, Math.ceil(input.size / CHUNK_SIZE));

    const meta: SessionMeta = {
      serverId,
      userId,
      directory: input.directory,
      fileName,
      size: input.size,
      chunkSize: CHUNK_SIZE,
      chunks,
      createdAt: new Date().toISOString(),
    };

    await this.uneAUne(`${serverId}:${userId}`, async () => {
      if ((await this.ouvertesPour(serverId, userId)) >= MAX_OPEN_UPLOADS) {
        throw new ConflictException(
          `Trop d'envois en cours sur ce serveur (${MAX_OPEN_UPLOADS} au plus). ` +
            "Terminez ou annulez-en un ; un envoi abandonné se libère de lui-même au bout de six heures.",
        );
      }
      await mkdir(this.dossier(id), { recursive: true });
      await writeFile(join(this.dossier(id), "meta.json"), JSON.stringify(meta), "utf8");
    });

    // Le balayage est fait ici plutôt que par un minuteur : l'ouverture d'une
    // session est le seul moment où l'on sait qu'il y a du trafic, et une
    // tâche de fond de plus pour effacer des dossiers vides n'apporterait rien.
    void this.balayer();

    return { id, chunkSize: CHUNK_SIZE, chunks, received: [] };
  }

  /**
   * Sessions encore vivantes de ce compte sur ce serveur.
   *
   * Une session inactive depuis plus de six heures ne compte pas : le
   * balayage l'effacera, et la compter enfermerait dehors quelqu'un dont le
   * seul tort est d'avoir fermé un onglet.
   */
  private async ouvertesPour(serverId: string, userId: string): Promise<number> {
    const limite = Date.now() - SESSION_TTL_MS;
    const noms = await readdir(this.racine).catch(() => [] as string[]);
    let ouvertes = 0;
    for (const nom of noms) {
      if (!/^[0-9a-f]{32}$/.test(nom)) continue;
      const info = await stat(join(this.racine, nom)).catch(() => null);
      if (!info?.isDirectory() || info.mtimeMs < limite) continue;
      try {
        const meta = JSON.parse(
          await readFile(join(this.racine, nom, "meta.json"), "utf8"),
        ) as SessionMeta;
        if (meta.serverId === serverId && meta.userId === userId) ouvertes += 1;
      } catch {
        // Session en cours de création ou déjà effacée : elle ne compte pas.
      }
    }
    return ouvertes;
  }

  /** Exécute `travail` après ceux déjà en file pour la même clé. */
  private async uneAUne<T>(cle: string, travail: () => Promise<T>): Promise<T> {
    const avant = this.ouvertures.get(cle) ?? Promise.resolve();
    const tour = avant.catch(() => undefined).then(travail);
    this.ouvertures.set(cle, tour);
    try {
      return await tour;
    } finally {
      if (this.ouvertures.get(cle) === tour) this.ouvertures.delete(cle);
    }
  }

  /** Où en est une session : c'est cette liste que le navigateur consulte pour reprendre. */
  async status(id: string, serverId: string, userId: string): Promise<UploadSession> {
    const meta = await this.meta(id, serverId, userId);
    return {
      id,
      chunkSize: meta.chunkSize,
      chunks: meta.chunks,
      received: await this.recus(id),
    };
  }

  /**
   * Enregistre un morceau.
   *
   * Écrit sous un nom provisoire puis renommé : un morceau à moitié écrit,
   * interrompu par un arrêt du panel, se présenterait sinon comme reçu, et
   * l'assemblage produirait un fichier tronqué sans que rien ne le signale.
   */
  async putChunk(
    id: string,
    serverId: string,
    userId: string,
    index: number,
    data: Buffer,
  ): Promise<{ received: number }> {
    const meta = await this.meta(id, serverId, userId);

    if (!Number.isInteger(index) || index < 0 || index >= meta.chunks) {
      throw new BadRequestException("Numéro de morceau hors de la session.");
    }
    if (data.length === 0) throw new BadRequestException("Morceau vide.");
    if (data.length > CHUNK_LIMIT) throw new BadRequestException("Morceau trop volumineux.");

    const attendu = tailleAttendue(meta, index);
    if (data.length !== attendu) {
      throw new BadRequestException(
        `Le morceau ${index} fait ${data.length} octets, ${attendu} étaient annoncés.`,
      );
    }

    const provisoire = join(this.dossier(id), `${nomDuMorceau(index)}.partiel`);
    await writeFile(provisoire, data);
    await rename(provisoire, join(this.dossier(id), nomDuMorceau(index)));

    return { received: (await this.recus(id)).length };
  }

  /**
   * Assemble et remet le fichier au daemon.
   *
   * **Le compte des octets est refait ici**, et pas seulement celui des
   * morceaux : c'est la seule vérification qui attrape un morceau écrit par un
   * disque plein. Sans elle, le panel annoncerait un envoi réussi pour un
   * fichier amputé — la pire des issues, puisque personne n'irait vérifier.
   */
  async complete(id: string, serverId: string, userId: string): Promise<{ file: string }> {
    const meta = await this.meta(id, serverId, userId);
    const recus = await this.recus(id);

    if (recus.length !== meta.chunks) {
      const manquants = [...Array(meta.chunks).keys()].filter((i) => !recus.includes(i));
      throw new BadRequestException(
        `Envoi incomplet : ${manquants.length} morceau(x) manquant(s) sur ${meta.chunks}.`,
      );
    }

    let total = 0;
    for (const index of recus) {
      const { size } = await stat(join(this.dossier(id), nomDuMorceau(index)));
      total += size;
    }
    if (total !== meta.size) {
      await this.discard(id);
      throw new BadRequestException(
        `Les morceaux reçus font ${total} octets au lieu de ${meta.size}. L'envoi est à refaire.`,
      );
    }

    const chemin = joindreChemin(meta.directory, meta.fileName);
    try {
      await this.wings.writeFileStream(serverId, chemin, meta.size, this.flux(id, meta.chunks));
    } finally {
      // Que le daemon ait accepté ou refusé, les morceaux n'ont plus de
      // raison d'être : un refus se rejoue depuis le poste, pas depuis un
      // dossier temporaire dont personne ne connaît l'existence.
      await this.discard(id);
    }

    return { file: chemin };
  }

  /** Abandon explicite, quand la personne ferme l'écran ou annule. */
  async discard(id: string): Promise<void> {
    await rm(this.dossier(id), { recursive: true, force: true }).catch(() => undefined);
  }

  /** Les morceaux mis bout à bout, lus au fil de l'envoi. */
  private flux(id: string, chunks: number): Readable {
    const dossier = this.dossier(id);
    return Readable.from(
      (async function* () {
        for (let index = 0; index < chunks; index++) {
          const morceau = createReadStream(join(dossier, nomDuMorceau(index)));
          for await (const bloc of morceau) yield bloc as Buffer;
        }
      })(),
    );
  }

  private dossier(id: string): string {
    // L'identifiant est produit ici et vérifié à la lecture : un identifiant
    // reçu tel quel composerait un chemin, et `../..` en ferait sortir.
    if (!/^[0-9a-f]{32}$/.test(id)) throw new NotFoundException("Session d'envoi inconnue.");
    // Seconde garde, redondante avec la première mais lisible par CodeQL :
    // le chemin résolu doit rester sous la racine des envois.
    const racine = resolve(this.racine);
    const chemin = resolve(racine, id);
    if (!chemin.startsWith(racine + sep)) throw new NotFoundException("Session d'envoi inconnue.");
    return chemin;
  }

  /**
   * La session, **et la preuve qu'elle appartient à qui la demande**.
   *
   * Le contrôle de permission est fait par le contrôleur à chaque appel ; ce
   * second contrôle est différent et tout aussi nécessaire : il empêche
   * quelqu'un qui a le droit d'écrire sur *son* serveur de pousser des
   * morceaux dans la session de quelqu'un d'autre.
   */
  private async meta(id: string, serverId: string, userId: string): Promise<SessionMeta> {
    let brut: string;
    try {
      brut = await readFile(join(this.dossier(id), "meta.json"), "utf8");
    } catch {
      throw new NotFoundException("Session d'envoi inconnue ou expirée.");
    }

    const meta = JSON.parse(brut) as SessionMeta;
    if (meta.serverId !== serverId || meta.userId !== userId) {
      // Le même message que pour une session absente : distinguer les deux
      // dirait à un curieux que l'identifiant qu'il a deviné existe.
      throw new NotFoundException("Session d'envoi inconnue ou expirée.");
    }
    return meta;
  }

  private async recus(id: string): Promise<number[]> {
    const entrees = await readdir(this.dossier(id)).catch(() => []);
    return entrees
      .filter((nom) => /^\d{6}$/.test(nom))
      .map((nom) => Number(nom))
      .sort((a, b) => a - b);
  }

  /** Efface les sessions qu'on a cessé d'alimenter. */
  private async balayer(): Promise<void> {
    const limite = Date.now() - SESSION_TTL_MS;
    try {
      for (const nom of await readdir(this.racine)) {
        const chemin = join(this.racine, nom);
        const info = await stat(chemin).catch(() => null);
        if (info?.isDirectory() && info.mtimeMs < limite) {
          await rm(chemin, { recursive: true, force: true });
          this.logger.log(`Session d'envoi ${nom} abandonnée depuis six heures : effacée.`);
        }
      }
    } catch {
      // Le dossier racine n'existe pas encore : il n'y a rien à balayer.
    }
  }
}

/** `000042` : un nom triable, pour que la lecture du dossier donne l'ordre. */
function nomDuMorceau(index: number): string {
  return String(index).padStart(6, "0");
}

function tailleAttendue(meta: SessionMeta, index: number): number {
  const dernier = index === meta.chunks - 1;
  if (!dernier) return meta.chunkSize;
  const reste = meta.size % meta.chunkSize;
  return reste === 0 ? meta.chunkSize : reste;
}

/**
 * Le nom de fichier, ramené à un nom de fichier.
 *
 * Un navigateur envoie `name` tel que le système de l'utilisateur le lui
 * donne ; sous Windows cela peut contenir des antislashs, et une archive
 * malveillante un `../`. Wings confine de toute façon au volume, mais compter
 * sur lui reviendrait à décider ici que le contrôle est le problème d'un
 * autre programme.
 */
function nomDeFichier(brut: string): string {
  const base = brut.split(/[/\\]/).pop() ?? "";
  // Caractères de contrôle retirés par leur code plutôt que par une classe
  // d'expression régulière qui les contiendrait littéralement, invisibles.
  const propre = Array.from(base)
    .filter((c) => {
      const code = c.charCodeAt(0);
      return code > 0x1f && code !== 0x7f;
    })
    .join("")
    .trim();
  if (propre === "" || propre === "." || propre === "..") {
    throw new BadRequestException("Nom de fichier invalide.");
  }
  return propre;
}

/** Recompose un chemin absolu dans le volume, sans double barre ni remontée. */
function joindreChemin(directory: string, fileName: string): string {
  const dossier = `/${directory}`.replace(/\/+/g, "/").replace(/\/$/, "");
  if (dossier.split("/").includes("..")) {
    throw new BadRequestException("Dossier de destination invalide.");
  }
  return `${dossier}/${fileName}`;
}
