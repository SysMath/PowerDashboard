import { useCallback } from "react";
import { useInstance } from "@/etat/instance";
import { choisirFichier, envoyerFichier, telechargerEtPartager } from "@/natif/fichiers";
import { joindre, trier } from "@/noyau/fichiers";
import { useDonnees } from "./useDonnees";

/**
 * Un dossier d'un serveur et ses gestes. Chaque geste relit le dossier, qu'il
 * réussisse ou non : un refus partiel du daemon laisse parfois une trace.
 */
export function useFichiers(id: string, chemin: string) {
  const { client } = useInstance();
  const lecture = useDonnees(
    useCallback(() => client.files(id, chemin).then(trier), [client, id, chemin]),
  );
  const apres = <T>(geste: Promise<T>) => geste.finally(lecture.recharger);
  return {
    ...lecture,
    creerDossier: (nom: string) => apres(client.createDirectory(id, chemin, nom.trim())),
    renommer: (nom: string, cible: string) =>
      apres(client.renameFile(id, chemin, nom, cible.trim())),
    supprimer: (nom: string) => apres(client.deleteFiles(id, chemin, [nom])),
    compresser: (nom: string) => apres(client.compressFiles(id, chemin, [nom])),
    extraire: (nom: string) => apres(client.decompressFile(id, chemin, nom)),
    telecharger: async (nom: string) =>
      telechargerEtPartager(await client.fileDownloadUrl(id, joindre(chemin, nom)), nom),
    /**
     * Choisit un fichier du téléphone et le dépose ici. L'autorisation ne se
     * demande qu'une fois le fichier choisi : elle ne sert qu'une fois.
     * `false` si la personne renonce.
     */
    envoyer: async (echec: string): Promise<boolean> => {
      const fichier = await choisirFichier();
      if (!fichier) return false;
      await apres(
        client.uploadGrant(id).then((grant) => envoyerFichier(fichier, grant, chemin, echec)),
      );
      return true;
    },
  };
}
