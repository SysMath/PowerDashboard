import { useTranslations } from "use-intl";
import { domaineDe } from "@/noyau/adresse";
import type { Descripteur } from "@/noyau/descripteur";
import type { InstanceLiee } from "@/noyau/instances";
import { Bandeau, Bouton, Carte, Ecran, Pastille, Rangee, Texte } from "./base";

/** Le nom et le domaine exact, en gros, avant toute connexion (ADR 0010). */
export function FicheInstance({
  adresse,
  descripteur,
}: {
  adresse: string;
  descripteur: Descripteur;
}) {
  const t = useTranslations("mobile.ajout");
  return (
    <Carte>
      <Texte ton="titre">{descripteur.nom}</Texte>
      <Texte>{domaineDe(adresse)}</Texte>
      <Texte ton="discret">{t("ficheAide")}</Texte>
    </Carte>
  );
}

export function ListeInstances(props: {
  instances: InstanceLiee[];
  onOuvrir: (instance: InstanceLiee) => void;
}) {
  const t = useTranslations("mobile.instances");
  return props.instances.map((instance) => (
    <Carte key={instance.id} onPress={() => props.onOuvrir(instance)}>
      <Rangee>
        <Pastille niveau={instance.etat === "liee" ? "success" : "warning"} />
        <Texte>{instance.nom}</Texte>
      </Rangee>
      <Texte ton="discret">
        {domaineDe(instance.adresse)} · {t(`etat.${instance.etat}`)}
      </Texte>
    </Carte>
  ));
}

/** Les états du cadre d'un panel qui ne sont pas « ouvert ». */
export function EcranCadre(props: {
  etat: "verrouille" | "hors-ligne" | "introuvable" | "a-confirmer" | "a-relier";
  instance?: InstanceLiee;
  onAgir: () => void;
  onRetirer?: () => void;
}) {
  const t = useTranslations("mobile.cadre");
  return (
    <Ecran>
      {props.instance ? <Texte ton="titre">{props.instance.nom}</Texte> : null}
      <Bandeau
        titre={t(`${props.etat}.titre`)}
        niveau={props.etat === "a-confirmer" ? "danger" : "warning"}
      >
        {t(`${props.etat}.corps`)}
      </Bandeau>
      <Bouton titre={t(`${props.etat}.action`)} onPress={props.onAgir} />
      {props.onRetirer ? (
        <Bouton titre={t("retirer")} variante="danger" onPress={props.onRetirer} />
      ) : null}
    </Ecran>
  );
}
