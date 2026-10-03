import {
  type AdminActivityEntry,
  type AdminIncident,
  type AdminNode,
  type AdminServer,
  type AdminUser,
  describeActivity,
  NODE_STATUS_TONE,
  type UpdateStatus,
} from "@gamedashboard/contracts";
import { formatMb } from "@gamedashboard/sdk/format";
import { useFormatter, useTranslations } from "use-intl";
import { useConfirme } from "@/hooks/useGeste";
import { etatMachine, etatMiseAJour, refusMotif } from "@/noyau/administration";
import { PRESENCE_REFUSEE } from "@/noyau/outils";
import { estSuspendu, suspendable } from "@/noyau/revendeur";
import { Bandeau, Bouton, Carte, Pastille, Rangee, Texte } from "./base";
import { Saisie } from "./menu";
import { niveauEtat } from "./serveurs";

/*
 * Les cartes de l'administration simple (ADR 0010, lot 6). Les libellés
 * d'état sont ceux du web (`serverState`, `nodeStatus`, `adminUpdates`).
 */

export function CarteMachine({ node, onPress }: { node: AdminNode; onPress?: () => void }) {
  const t = useTranslations("mobile.administration.machines");
  const ts = useTranslations("nodeStatus");
  const format = useFormatter();
  const etat = etatMachine(node);
  return (
    <Carte onPress={onPress}>
      <Rangee>
        <Pastille niveau={NODE_STATUS_TONE[etat]} />
        <Texte>{node.name}</Texte>
        <Texte ton="discret">{ts(etat)}</Texte>
      </Rangee>
      <Texte ton="discret">
        {node.location} · {t("serveurs", { n: node.servers })}
      </Texte>
      <Texte ton="discret">
        {node.lastHeartbeatAt
          ? t("vue", { quand: format.relativeTime(new Date(node.lastHeartbeatAt)) })
          : t("jamaisVue")}
        {node.wingsVersion ? ` · Wings ${node.wingsVersion}` : ""}
      </Texte>
      <Texte ton="discret">
        {t("memoire", {
          accordee: formatMb(node.allocatedMemoryMb, 0),
          total: formatMb(node.memoryMb, 0),
        })}
      </Texte>
    </Carte>
  );
}

/** Un serveur du parc : l'ouvrir avec les écrans du client, le suspendre. */
export function CarteServeurAdmin(props: {
  serveur: AdminServer;
  ecrire: boolean;
  onOuvrir: () => void;
  onSuspendre: () => void;
}) {
  const t = useTranslations("mobile.administration.serveurs");
  const ts = useTranslations("serverState");
  const { serveur } = props;
  const etat = serveur.state ?? serveur.runtimeState;
  return (
    <Carte onPress={props.onOuvrir}>
      <Rangee>
        <Pastille niveau={estSuspendu(serveur) ? "warning" : niveauEtat(etat)} />
        <Texte>{serveur.name}</Texte>
        <Texte ton="discret">{etat && ts.has(etat) ? ts(etat) : ts("unknown")}</Texte>
      </Rangee>
      <Texte ton="discret">
        {serveur.owner} · {serveur.node} · {serveur.egg}
      </Texte>
      {props.ecrire && suspendable(serveur) ? (
        <Bouton
          titre={estSuspendu(serveur) ? t("retablir") : t("suspendre")}
          variante={estSuspendu(serveur) ? "secondaire" : "danger"}
          onPress={props.onSuspendre}
        />
      ) : null}
    </Carte>
  );
}

export function CarteCompte({ compte, onPress }: { compte: AdminUser; onPress?: () => void }) {
  const t = useTranslations("mobile.administration.comptes");
  const tr = useTranslations("role");
  return (
    <Carte onPress={onPress}>
      <Rangee>
        <Pastille niveau={compte.suspendedAt ? "warning" : "neutre"} />
        <Texte>{compte.name}</Texte>
        <Texte ton="discret">{tr(compte.role)}</Texte>
      </Rangee>
      <Texte ton="discret">
        {compte.email} · {t("serveurs", { n: compte.servers })}
      </Texte>
      {compte.suspendedAt ? <Texte ton="discret">{t("suspendu")}</Texte> : null}
    </Carte>
  );
}

export function CarteIncident(props: { incident: AdminIncident; onPress?: () => void }) {
  const t = useTranslations("status");
  const format = useFormatter();
  const { incident } = props;
  const ouvert = incident.resolvedAt === null;
  const derniere = incident.updates.at(-1);
  return (
    <Carte onPress={props.onPress}>
      <Rangee>
        <Pastille niveau={ouvert ? (incident.impact === "none" ? "info" : "danger") : "neutre"} />
        <Texte>{incident.title}</Texte>
      </Rangee>
      <Texte ton="discret">
        {t(`incidentState.${incident.state}`)} · {t(`impact.${incident.impact}`)} ·{" "}
        {format.relativeTime(new Date(incident.startedAt))}
      </Texte>
      {derniere ? <Texte ton="discret">{derniere.body}</Texte> : null}
    </Carte>
  );
}

/** Où en est la mise à jour du panel, et le geste pour en chercher une. */
export function CarteMiseAJour(props: {
  statut: UpdateStatus;
  ecrire: boolean;
  verifier: () => Promise<unknown>;
}) {
  const t = useTranslations("adminUpdates");
  const tm = useTranslations("mobile.administration.miseAJour");
  const confirme = useConfirme();
  const { statut } = props;
  if (!statut.actif) return null;
  const etat = etatMiseAJour(statut);
  const libelle = {
    "en-cours": t("stateRunning"),
    echec: t("stateFailed"),
    disponible: t("stateAvailable"),
    "a-jour": t("stateUpToDate"),
    inactive: "",
  }[etat];
  const niveau = (
    { "en-cours": "info", echec: "danger", disponible: "warning", "a-jour": "success" } as const
  )[etat === "inactive" ? "a-jour" : etat];
  return (
    <Carte>
      <Texte ton="titre">{t("title")}</Texte>
      <Bandeau titre={libelle} niveau={niveau}>
        {statut.operation ? t(`step${capitale(statut.operation.etape)}`, statut.operation) : null}
      </Bandeau>
      <Texte ton="discret">
        {t("inService")} : {statut.enService} · {t("latest")} :{" "}
        {statut.derniereRelease ?? t("latestUnknown")}
      </Texte>
      {statut.dernierResultat?.message ? (
        <Texte ton="discret">{statut.dernierResultat.message}</Texte>
      ) : null}
      {props.ecrire ? (
        <Bouton
          titre={etat === "disponible" ? tm("installer") : t("check")}
          variante={etat === "disponible" ? "primaire" : "secondaire"}
          inactif={statut.operation !== null}
          onPress={() =>
            confirme(
              { titre: tm("titre"), corps: tm("corps"), bouton: tm("lancer") },
              props.verifier,
            )
          }
        />
      ) : null}
    </Carte>
  );
}

export function LigneJournal({ ligne }: { ligne: AdminActivityEntry }) {
  const format = useFormatter();
  return (
    <Carte>
      <Texte>{describeActivity(ligne.event).label}</Texte>
      <Texte ton="discret">
        {[ligne.actorLabel, ligne.serverName, format.relativeTime(new Date(ligne.at))]
          .filter(Boolean)
          .join(" · ")}
      </Texte>
    </Carte>
  );
}

/**
 * Le motif d'une suspension de compte, exigé par l'API. Une biométrie
 * annulée le dit sans fermer la feuille : rien n'est parti.
 */
export function SaisieMotif(props: {
  compte: AdminUser | null;
  suspendre: (userId: string, motif: string) => Promise<unknown>;
  onFermer: () => void;
}) {
  const t = useTranslations("mobile.administration.comptes");
  const { compte } = props;
  return (
    <Saisie
      titre={compte ? t("suspendreTitre", { nom: compte.name }) : null}
      aide={t("suspendreCorps")}
      libelle={t("motif")}
      initiale=""
      action={t("suspendre")}
      refus={(valeur) => {
        const refus = refusMotif(valeur);
        return refus ? t(refus === "vide" ? "motifVide" : "motifLong") : null;
      }}
      valider={(valeur) =>
        compte
          ? props.suspendre(compte.id, valeur).then(
              () => null,
              (erreur: unknown) => {
                if (erreur instanceof Error && erreur.message === PRESENCE_REFUSEE) {
                  return t("confirmationAnnulee");
                }
                throw erreur;
              },
            )
          : Promise.resolve(null)
      }
      onFermer={props.onFermer}
    />
  );
}

/** Un choix parmi quelques valeurs, en boutons : l'impact, l'état d'un incident. */
export function Choix<T extends string>(props: {
  valeurs: readonly T[];
  valeur: T;
  libelle: (valeur: T) => string;
  onChoisir: (valeur: T) => void;
}) {
  return (
    <Rangee>
      {props.valeurs.map((valeur) => (
        <Bouton
          key={valeur}
          titre={props.libelle(valeur)}
          variante={valeur === props.valeur ? "primaire" : "secondaire"}
          onPress={() => props.onChoisir(valeur)}
        />
      ))}
    </Rangee>
  );
}

/** Le fil public d'un incident, le plus récent d'abord. */
export function FilIncident({ incident }: { incident: AdminIncident }) {
  const t = useTranslations("status.incidentState");
  const format = useFormatter();
  return (
    <>
      {[...incident.updates].reverse().map((maj) => (
        <Carte key={`${maj.at}-${maj.state}`}>
          <Texte ton="discret">
            {t(maj.state)} · {format.relativeTime(new Date(maj.at))}
          </Texte>
          <Texte>{maj.body}</Texte>
        </Carte>
      ))}
    </>
  );
}

const RUBRIQUES = ["machines", "serveurs", "comptes", "incidents", "activite"] as const;

/** Les écrans de l'administration, depuis l'aperçu. */
export function Rubriques({ onAller }: { onAller: (rubrique: string) => void }) {
  const t = useTranslations("mobile.administration.rubrique");
  return (
    <Rangee>
      {RUBRIQUES.map((rubrique) => (
        <Bouton
          key={rubrique}
          titre={t(rubrique)}
          variante="secondaire"
          onPress={() => onAller(rubrique)}
        />
      ))}
    </Rangee>
  );
}

/** Un serveur en échec, sur l'aperçu : il s'ouvre avec les écrans du client. */
export function CarteServeurEnEchec(props: { serveur: AdminServer; onPress: () => void }) {
  const t = useTranslations("mobile.administration");
  const ts = useTranslations("serverState");
  const { serveur } = props;
  const etat = serveur.state === "install_failed" ? "install_failed" : "crash_loop";
  return (
    <Carte onPress={props.onPress}>
      <Rangee>
        <Pastille niveau="danger" />
        <Texte>{serveur.name}</Texte>
        <Texte ton="discret">{ts(etat)}</Texte>
      </Rangee>
      <Texte ton="discret">
        {t("enEchec", { proprietaire: serveur.owner, machine: serveur.node })}
      </Texte>
    </Carte>
  );
}

const capitale = (mot: string) => mot.charAt(0).toUpperCase() + mot.slice(1);
