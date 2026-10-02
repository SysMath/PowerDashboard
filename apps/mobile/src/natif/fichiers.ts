import type { UploadGrant } from "@gamedashboard/contracts";
import { Directory, File, Paths, UploadType } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { adresseEnvoi, refusDaemon } from "@/noyau/fichiers";

/*
 * Les octets d'un fichier vont du daemon au téléphone et du téléphone au
 * daemon, par les liens signés que le panel délivre : le panel n'en relaie
 * aucun, comme pour le web.
 */

/**
 * Un seul dossier de passage, vidé à chaque téléchargement : rien ne reste
 * sur le téléphone hors de ce que la personne range elle-même (ADR 0010,
 * « Données sur le téléphone »). Pas d'effacement juste après le partage :
 * Android rend la main avant que l'application choisie ait lu le fichier.
 */
function passage(): Directory {
  const dossier = new Directory(Paths.cache, "passage");
  if (dossier.exists) dossier.delete();
  dossier.create({ intermediates: true });
  return dossier;
}

/** Télécharge par le lien du daemon, puis ouvre le partage du système. */
export async function telechargerEtPartager(url: string, nom: string): Promise<void> {
  const fichier = await File.downloadFileAsync(url, new File(passage(), nom));
  await Sharing.shareAsync(fichier.uri, { dialogTitle: nom });
}

/** Le sélecteur de fichiers du système. `null` si la personne renonce. */
export async function choisirFichier(): Promise<File | null> {
  const choix = await File.pickFileAsync();
  return choix.canceled ? null : choix.result;
}

/** Dépose le fichier chez le daemon, champ `files` comme le web. */
export async function envoyerFichier(
  fichier: File,
  grant: UploadGrant,
  dossier: string,
  echec: string,
): Promise<void> {
  const reponse = await fichier.upload(adresseEnvoi(grant, dossier), {
    uploadType: UploadType.MULTIPART,
    fieldName: "files",
  });
  if (reponse.status >= 200 && reponse.status < 300) return;
  throw new Error(refusDaemon(reponse.body) ?? echec);
}
