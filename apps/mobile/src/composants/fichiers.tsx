import {
  type ClientFileEntryView,
  PATH_REFUSAL_MESSAGES,
  refusePath,
  renameRefusal,
} from "@gamedashboard/contracts";
import { ApiProblem } from "@gamedashboard/sdk";
import { formatBytes } from "@gamedashboard/sdk/format";
import { useState } from "react";
import { Alert, Pressable } from "react-native";
import { useFormatter, useTranslations } from "use-intl";
import type { useFichiers } from "@/hooks/useFichiers";
import { useGeste } from "@/hooks/useGeste";
import {
  type ActionFichier,
  actionsEntree,
  fil,
  joindre,
  ouverture,
  refusNom,
} from "@/noyau/fichiers";
import { Bandeau, Bouton, Carte, Rangee, Texte } from "./base";
import { Menu, Saisie } from "./menu";

type Gestes = ReturnType<typeof useFichiers>;

/** Le fil d'Ariane : un toucher remonte au dossier choisi. */
export function FilAriane(props: { chemin: string; onAller: (chemin: string) => void }) {
  return (
    <Rangee>
      {fil(props.chemin).map((etape) => (
        <Pressable
          key={etape.chemin}
          accessibilityRole="link"
          onPress={() => props.onAller(etape.chemin)}
        >
          <Texte ton="discret">{etape.nom === "/" ? "/" : `${etape.nom} /`}</Texte>
        </Pressable>
      ))}
    </Rangee>
  );
}

/**
 * Un dossier du serveur. Toucher ouvre un dossier ou un fichier texte ; un
 * appui long, ou un fichier qui ne s'ouvre pas, donne le menu de l'entrée.
 */
export function Dossier(props: {
  chemin: string;
  entrees: ClientFileEntryView[];
  gestes: Gestes;
  onOuvrir: (chemin: string, dossier: boolean) => void;
}) {
  const t = useTranslations("files");
  const tt = useTranslations("fileTools");
  const tm = useTranslations("mobile.fichiers");
  const tc = useTranslations("mobile.commun");
  const format = useFormatter();
  const geste = useGeste();
  const [menu, setMenu] = useState<ClientFileEntryView | null>(null);
  const [nommer, setNommer] = useState<ClientFileEntryView | "dossier" | null>(null);
  const [envoi, setEnvoi] = useState(false);
  const { chemin, gestes } = props;

  const supprimer = (e: ClientFileEntryView) =>
    Alert.alert(t("deleteTitle"), t("deleteBody", { name: e.name }), [
      { text: tc("annuler"), style: "cancel" },
      {
        text: tm("supprimer"),
        style: "destructive",
        onPress: () => geste(() => gestes.supprimer(e.name)),
      },
    ]);
  const actions: Record<ActionFichier, (e: ClientFileEntryView) => void> = {
    ouvrir: (e) => props.onOuvrir(joindre(chemin, e.name), e.directory),
    telecharger: (e) => geste(() => gestes.telecharger(e.name), t("downloadFailed")),
    renommer: (e) => setNommer(e),
    compresser: (e) => geste(() => gestes.compresser(e.name)),
    extraire: (e) => geste(() => gestes.extraire(e.name)),
    supprimer,
  };
  const libelles: Record<ActionFichier, string> = {
    ouvrir: tm("ouvrir"),
    telecharger: tm("partager"),
    renommer: tt("rename"),
    compresser: t("compress"),
    extraire: t("decompress"),
    supprimer: tm("supprimer"),
  };
  const toucher = (e: ClientFileEntryView) => {
    const mode = ouverture(e);
    if (mode === "dossier" || mode === "editer") return actions.ouvrir(e);
    Alert.alert(e.name, mode === "trop-gros" ? tm("tropGros") : tm("binaire"), [
      { text: tc("annuler"), style: "cancel" },
      { text: tm("partager"), onPress: () => actions.telecharger(e) },
    ]);
  };
  const envoyer = () => {
    setEnvoi(true);
    geste(() => gestes.envoyer(t("uploadFailed")), t("uploadFailed")).finally(() =>
      setEnvoi(false),
    );
  };
  const renommer = (e: ClientFileEntryView, cible: string) =>
    gestes.renommer(e.name, cible).then(
      () => null,
      (erreur: unknown) =>
        erreur instanceof ApiProblem && erreur.status === 409
          ? tt("renameConflict", { name: cible.trim() })
          : erreur instanceof Error
            ? erreur.message
            : String(erreur),
    );
  const refusRenommage = (e: ClientFileEntryView, cible: string) => {
    const refus = renameRefusal(e.name, cible);
    if (refus === "empty") return tt("renameEmpty");
    if (refus === "trailingSlash")
      return tt("renameTrailingSlash", { example: `${cible.trim()}${e.name}` });
    const chemin = refusePath(cible.trim(), props.chemin);
    return chemin ? PATH_REFUSAL_MESSAGES[chemin] : null;
  };
  const refusNomDossier = (valeur: string) => {
    const refus = refusNom(valeur);
    return refus ? tm(`nom.${refus}`) : null;
  };
  const entree = typeof nommer === "object" ? nommer : null;

  return (
    <>
      <Rangee>
        <Bouton titre={t("newFolder")} variante="secondaire" onPress={() => setNommer("dossier")} />
        <Bouton titre={envoi ? t("uploading") : t("upload")} inactif={envoi} onPress={envoyer} />
      </Rangee>
      {props.entrees.length === 0 ? (
        <Bandeau titre={t("emptyFolder")}>{t("emptyFolderHint")}</Bandeau>
      ) : (
        <Texte ton="discret">{tm("appuiLong")}</Texte>
      )}
      {props.entrees.map((e) => (
        <Carte key={e.name} onPress={() => toucher(e)} onLongPress={() => setMenu(e)}>
          <Texte>{e.directory ? `${e.name}/` : e.name}</Texte>
          <Texte ton="discret">
            {[
              e.directory ? tm("dossier") : formatBytes(e.size),
              format.dateTime(new Date(e.modified), { dateStyle: "medium", timeStyle: "short" }),
            ].join(" · ")}
          </Texte>
        </Carte>
      ))}
      <Menu
        titre={menu?.name ?? null}
        choix={(menu ? actionsEntree(menu) : []).map((action) => ({
          titre: libelles[action],
          danger: action === "supprimer",
          onPress: () => menu && actions[action](menu),
        }))}
        onFermer={() => setMenu(null)}
      />
      <Saisie
        titre={
          nommer === null
            ? null
            : entree
              ? tt("renameTitle", { name: entree.name })
              : t("newFolder")
        }
        aide={
          entree
            ? tt("renameHint", { path: chemin, name: entree.name })
            : t("createdIn", { path: chemin })
        }
        libelle={entree ? tt("renameLabel") : tm("nomDossier")}
        initiale={entree?.name ?? ""}
        nouveau={entree !== null}
        action={entree ? tm("valider") : tm("creer")}
        refus={(valeur) => (entree ? refusRenommage(entree, valeur) : refusNomDossier(valeur))}
        valider={(valeur) =>
          entree ? renommer(entree, valeur) : gestes.creerDossier(valeur).then(() => null)
        }
        onFermer={() => setNommer(null)}
      />
    </>
  );
}
