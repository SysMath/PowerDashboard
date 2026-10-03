"use server";

import type { ClientFileEntryView } from "@gamedashboard/contracts";
import { revalidatePath } from "next/cache";
import { ApiError, apiFetch, apiSend, apiSendFor } from "./client";

/**
 * Opérations sur les fichiers d'un serveur.
 *
 * Ce sont des actions serveur : le navigateur soumet, Next transmet la session,
 * l'API vérifie la permission et relaie au daemon. Le navigateur n'a donc
 * jamais d'accès direct au système de fichiers d'un serveur, ce qui serait le
 * cas s'il appelait Wings lui-même avec un jeton de portée large.
 */

/** Forme réelle renvoyée par Wings, partagée avec l'application mobile. */
export type FileEntryDto = ClientFileEntryView;

export interface FileEntry {
  name: string;
  isDirectory: boolean;
  size: number;
  mode: string;
  modifiedAt: string;
}

export async function listFiles(serverId: string, directory: string): Promise<FileEntry[]> {
  const { data } = await apiFetch<{ data: FileEntryDto[] }>(
    `/api/v1/client/servers/${serverId}/files?directory=${encodeURIComponent(directory)}`,
  );

  return (
    data
      .map((entry) => ({
        name: entry.name,
        // `directory` et non `!file` : Wings distingue les deux, et un lien
        // symbolique peut n'être ni l'un ni l'autre.
        isDirectory: entry.directory,
        size: entry.size,
        mode: entry.mode,
        modifiedAt: entry.modified,
      }))
      // Dossiers d'abord, puis par nom : c'est l'ordre attendu d'un navigateur
      // de fichiers, et Wings ne garantit aucun tri.
      .sort((a, b) =>
        a.isDirectory === b.isDirectory
          ? a.name.localeCompare(b.name, "fr")
          : a.isDirectory
            ? -1
            : 1,
      )
  );
}

export async function readFile(serverId: string, file: string): Promise<string> {
  const { data } = await apiFetch<{ data: { content: string } }>(
    `/api/v1/client/servers/${serverId}/files/contents?file=${encodeURIComponent(file)}`,
  );
  return data.content;
}

export async function writeFile(
  serverId: string,
  file: string,
  content: string,
): Promise<{ error: string | null }> {
  return act(() =>
    apiSend(`/api/v1/client/servers/${serverId}/files/write?file=${encodeURIComponent(file)}`, {
      content,
    }),
  );
}

export async function createDirectory(
  serverId: string,
  root: string,
  name: string,
): Promise<{ error: string | null }> {
  return act(
    () => apiSend(`/api/v1/client/servers/${serverId}/files/create-directory`, { root, name }),
    `/server/${serverId}/files`,
  );
}

/**
 * Renomme ou déplace une entrée. `to` est relatif à `root`, comme `from`.
 *
 * `conflict` est rendu à part : l'API répond 409 quand la destination existe
 * déjà, et l'écran le dit dans la langue de la personne plutôt que de relayer
 * la phrase de l'API — c'est le refus le plus courant, il mérite d'être clair.
 */
export async function renameFile(
  serverId: string,
  root: string,
  from: string,
  to: string,
): Promise<{ error: string | null; conflict: boolean }> {
  try {
    await apiSend(`/api/v1/client/servers/${serverId}/files/rename`, { root, from, to });
    revalidatePath(`/server/${serverId}/files`);
    return { error: null, conflict: false };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Opération refusée.",
      conflict: error instanceof ApiError && error.status === 409,
    };
  }
}

/**
 * Change le mode d'une entrée (chmod), en octal sur trois chiffres.
 *
 * Une entrée à la fois : c'est ce que l'écran propose. La route accepte une
 * liste, pour les intégrateurs qui en auraient l'usage.
 */
export async function chmodFile(
  serverId: string,
  root: string,
  file: string,
  mode: string,
): Promise<{ error: string | null }> {
  return act(
    () =>
      apiSend(`/api/v1/client/servers/${serverId}/files/chmod`, {
        root,
        files: [{ file, mode }],
      }),
    `/server/${serverId}/files`,
  );
}

export async function deleteFiles(
  serverId: string,
  root: string,
  files: string[],
): Promise<{ error: string | null }> {
  return act(
    () => apiSend(`/api/v1/client/servers/${serverId}/files/delete`, { root, files }),
    `/server/${serverId}/files`,
  );
}

/**
 * Compresse une sélection en une archive, dans le dossier courant.
 *
 * L'archive est fabriquée par le daemon et ne traverse jamais le panel : un
 * dossier de plusieurs gigaoctets le ferait deux fois pour rien.
 */
export async function compressFiles(
  serverId: string,
  root: string,
  files: string[],
): Promise<{ error: string | null }> {
  return act(
    () => apiSend(`/api/v1/client/servers/${serverId}/files/compress`, { root, files }),
    `/server/${serverId}/files`,
  );
}

/** Extrait une archive sur place. Le daemon refuse un format qu'il ne lit pas. */
export async function decompressFile(
  serverId: string,
  root: string,
  file: string,
): Promise<{ error: string | null }> {
  return act(
    () => apiSend(`/api/v1/client/servers/${serverId}/files/decompress`, { root, file }),
    `/server/${serverId}/files`,
  );
}

/**
 * Exécute une action et traduit son échec en message.
 *
 * Une erreur est renvoyée plutôt que levée : ces actions sont déclenchées
 * depuis l'interface, et un écran d'erreur complet pour un renommage refusé
 * ferait perdre à l'utilisateur le contexte où il travaillait.
 */
async function act(
  call: () => Promise<void>,
  pathToRefresh?: string,
): Promise<{ error: string | null }> {
  try {
    await call();
    if (pathToRefresh) revalidatePath(pathToRefresh);
    return { error: null };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Opération refusée." };
  }
}

/**
 * Autorisation d'envoi, à présenter au daemon par le navigateur.
 *
 * **L'exception à la règle de ce fichier.** Partout ailleurs, le navigateur
 * soumet au panel, qui relaie au daemon — c'est ce qui lui évite tout accès
 * direct au volume d'un serveur. Ici, il déposerait un modpack de plusieurs
 * centaines de mégaoctets : le faire transiter doublerait le trajet réseau et
 * occuperait le processus du panel pendant tout l'envoi.
 *
 * Ce qui rend l'exception acceptable est la forme du jeton rendu : un seul
 * serveur, une seule action, quinze minutes, et **une seule utilisation** —
 * Wings retient son identifiant et refuse de le resservir.
 */
export async function requestUploadGrant(
  serverId: string,
): Promise<{ grant: { token: string; url: string } | null; error: string | null }> {
  try {
    const { data } = await apiSendFor<{ data: { token: string; url: string } }>(
      `/api/v1/client/servers/${serverId}/files/upload-grant`,
      {},
    );
    return { grant: data, error: null };
  } catch (error) {
    return { grant: null, error: error instanceof Error ? error.message : "Envoi refusé." };
  }
}

/**
 * Signale au panel que le dossier a changé sous lui.
 *
 * L'envoi ne passe pas par une action serveur : Next ne peut donc pas savoir
 * qu'il faut relire le listage. Sans cet appel, les fichiers déposés
 * n'apparaîtraient qu'au rechargement suivant — et l'on croirait l'envoi raté.
 */
export async function refreshFiles(serverId: string): Promise<void> {
  revalidatePath(`/server/${serverId}/files`);
}

/**
 * Adresse de téléchargement d'un fichier, à ouvrir par le navigateur.
 *
 * Le panel rend une adresse et ne relaie rien : les octets vont du daemon au
 * navigateur. L'adresse ne vaut qu'une minute et qu'une fois — le temps de la
 * suivre, pas celui de la faire circuler.
 */
export async function requestDownloadUrl(
  serverId: string,
  file: string,
): Promise<{ url: string | null; error: string | null }> {
  try {
    const { data } = await apiFetch<{ data: { url: string } }>(
      `/api/v1/client/servers/${serverId}/files/download?file=${encodeURIComponent(file)}`,
    );
    return { url: data.url, error: null };
  } catch (error) {
    return { url: null, error: error instanceof Error ? error.message : "Téléchargement refusé." };
  }
}

/* --- Envoi reprenable ------------------------------------------------------ */
/*
 * Trois actions ici, et le morceau ailleurs.
 *
 * Ouvrir, interroger et clore une session sont de petits appels JSON : ils
 * passent par le même chemin que tout le reste. Les morceaux, eux, font huit
 * mégaoctets et traversent un gestionnaire de route dédié
 * (`/api/upload-chunk/…`) : une action serveur sérialise son argument et
 * plafonne son corps à un mégaoctet.
 */

export interface UploadSession {
  id: string;
  chunkSize: number;
  chunks: number;
  /** Les morceaux déjà arrivés — c'est ce qui permet de reprendre. */
  received: number[];
}

export async function openUpload(
  serverId: string,
  input: { directory: string; fileName: string; size: number },
): Promise<{ session: UploadSession | null; error: string | null }> {
  try {
    const { data } = await apiSendFor<{ data: UploadSession }>(
      `/api/v1/client/servers/${serverId}/files/uploads`,
      input,
    );
    return { session: data, error: null };
  } catch (error) {
    return { session: null, error: error instanceof Error ? error.message : "Envoi refusé." };
  }
}

/**
 * Ce que le panel a déjà reçu.
 *
 * Appelée à la reprise, et **seulement** là : pendant l'envoi, le navigateur
 * sait ce qu'il a envoyé, et le redemander à chaque morceau ajouterait un
 * aller-retour par morceau pour une information qu'il possède.
 */
export async function uploadStatus(
  serverId: string,
  uploadId: string,
): Promise<{ session: UploadSession | null; error: string | null }> {
  try {
    const { data } = await apiFetch<{ data: UploadSession }>(
      `/api/v1/client/servers/${serverId}/files/uploads/${uploadId}`,
    );
    return { session: data, error: null };
  } catch (error) {
    return { session: null, error: error instanceof Error ? error.message : "Session inconnue." };
  }
}

export async function completeUpload(
  serverId: string,
  uploadId: string,
): Promise<{ file: string | null; error: string | null }> {
  try {
    const { data } = await apiSendFor<{ data: { file: string } }>(
      `/api/v1/client/servers/${serverId}/files/uploads/${uploadId}/complete`,
      {},
    );
    return { file: data.file, error: null };
  } catch (error) {
    return { file: null, error: error instanceof Error ? error.message : "Assemblage refusé." };
  }
}

/**
 * Abandon.
 *
 * L'échec est avalé : les morceaux sont de toute façon effacés au bout de six
 * heures, et signaler « l'annulation a échoué » à quelqu'un qui vient
 * d'annuler ne lui donnerait rien à faire.
 */
export async function discardUpload(serverId: string, uploadId: string): Promise<void> {
  await apiSend(
    `/api/v1/client/servers/${serverId}/files/uploads/${uploadId}`,
    undefined,
    "DELETE",
  ).catch(() => undefined);
}
