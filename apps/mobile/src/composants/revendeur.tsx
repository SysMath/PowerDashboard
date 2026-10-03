import type { ResellerQuotaReport, ResellerServer } from "@gamedashboard/contracts";
import { formatBytes, formatMb, formatPercent } from "@gamedashboard/sdk/format";
import { useTranslations } from "use-intl";
import { enveloppe, estSuspendu, type ResumeServeur, suspendable } from "@/noyau/revendeur";
import { Bandeau, Bouton, Carte, Pastille, Rangee, Texte } from "./base";

/** L'enveloppe accordée, et ce qu'il en reste, dimension par dimension. */
export function CarteEnveloppe({ rapport }: { rapport: ResellerQuotaReport }) {
  const t = useTranslations("mobile.revendeur");
  const valeur = (dimension: string, n: number) =>
    dimension === "servers" ? String(n) : formatMb(n);
  return (
    <Carte>
      <Texte ton="titre">{t("enveloppe")}</Texte>
      {enveloppe(rapport).map((ligne) => (
        <Rangee key={ligne.dimension}>
          <Pastille niveau={ligne.depasse ? "danger" : "neutre"} />
          <Texte>
            {t(`dimension.${ligne.dimension}`)} :{" "}
            {ligne.limite === null
              ? t("sansLimite", { utilise: valeur(ligne.dimension, ligne.utilise) })
              : t("sur", {
                  utilise: valeur(ligne.dimension, ligne.utilise),
                  limite: valeur(ligne.dimension, ligne.limite),
                })}
          </Texte>
          {ligne.reste !== null ? (
            <Texte ton="discret">
              {ligne.depasse
                ? t("depasse")
                : t("reste", { reste: valeur(ligne.dimension, ligne.reste) })}
            </Texte>
          ) : null}
        </Rangee>
      ))}
      {rapport.usage.basis !== "measured" ? (
        <Bandeau titre={t("estimee", { n: rapport.usage.unmeasured })} niveau="warning" />
      ) : null}
    </Carte>
  );
}

/** Un serveur du parc : l'ouvrir avec les écrans du client, ou le suspendre. */
export function CarteServeurParc(props: {
  serveur: ResellerServer;
  onOuvrir: () => void;
  onSuspendre: () => void;
}) {
  const t = useTranslations("mobile.revendeur");
  const { serveur } = props;
  const suspendu = estSuspendu(serveur);
  return (
    <Carte onPress={props.onOuvrir}>
      <Rangee>
        <Pastille niveau={suspendu ? "warning" : "neutre"} />
        <Texte>{serveur.name}</Texte>
      </Rangee>
      <Texte ton="discret">
        {serveur.egg} · {serveur.node} · {formatMb(serveur.memoryMb)}
      </Texte>
      {suspendu ? <Texte ton="discret">{t("suspendu")}</Texte> : null}
      {suspendable(serveur) ? (
        <Bouton
          titre={suspendu ? t("retablir") : t("suspendre")}
          variante={suspendu ? "secondaire" : "danger"}
          onPress={props.onSuspendre}
        />
      ) : (
        <Texte ton="discret">{t("occupe")}</Texte>
      )}
    </Carte>
  );
}

/** Un serveur sur la période : disponibilité, processeur, mémoire, réseau. */
export function CarteConsommation({ resume }: { resume: ResumeServeur }) {
  const t = useTranslations("mobile.revendeur.conso");
  return (
    <Carte>
      <Rangee>
        <Texte>{resume.nom}</Texte>
        <Texte ton="discret">{t("jours", { n: resume.jours })}</Texte>
      </Rangee>
      {resume.disponibilite !== null ? (
        <Texte ton="discret">
          {t("disponibilite", { pct: formatPercent(resume.disponibilite * 100, 1) })}
        </Texte>
      ) : null}
      {resume.processeurMoyen !== null ? (
        <Texte ton="discret">
          {t("processeur", { pct: formatPercent(resume.processeurMoyen, 0) })}
        </Texte>
      ) : null}
      <Texte ton="discret">{t("memoire", { taille: formatBytes(resume.memoireMax) })}</Texte>
      <Texte ton="discret">{t("reseau", { taille: formatBytes(resume.reseau) })}</Texte>
      {resume.joueursMax !== null ? (
        <Texte ton="discret">{t("joueurs", { n: resume.joueursMax })}</Texte>
      ) : null}
      {resume.incomplet ? <Texte ton="discret">{t("incomplet")}</Texte> : null}
    </Carte>
  );
}
