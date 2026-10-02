import { useCallback, useState } from "react";
import { useInstance } from "@/etat/instance";
import { useDonnees } from "./useDonnees";

/**
 * Le contenu d'un fichier texte et sa modification. Le texte saisi reste à
 * part de celui du daemon jusqu'à l'enregistrement : `modifie` dit s'il
 * diffère de la dernière version connue du serveur.
 */
export function useEditeur(id: string, fichier: string) {
  const { client } = useInstance();
  const lecture = useDonnees(
    useCallback(() => client.fileContents(id, fichier), [client, id, fichier]),
  );
  const [enregistre, setEnregistre] = useState<string | null>(null);
  const [saisie, setSaisie] = useState<string | null>(null);
  const origine = enregistre ?? lecture.donnees;
  const texte = saisie ?? origine;
  return {
    erreur: lecture.erreur,
    texte,
    modifie: saisie !== null && saisie !== origine,
    saisir: setSaisie,
    retablir: () => setSaisie(null),
    enregistrer: async () => {
      if (texte === null) return;
      await client.writeFile(id, fichier, texte);
      setEnregistre(texte);
    },
  };
}
