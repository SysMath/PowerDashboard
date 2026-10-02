import type { ClientBackupList, ClientBackupView } from "@gamedashboard/contracts";
import { formatBytes } from "@gamedashboard/sdk/format";
import { useState } from "react";
import { Alert } from "react-native";
import { useFormatter, useTranslations } from "use-intl";
import { useGeste } from "@/hooks/useGeste";
import {
  type ActionSauvegarde,
  actionsSauvegarde,
  etatSauvegarde,
  nomParDefaut,
  quotaAtteint,
} from "@/noyau/sauvegardes";
import { Bandeau, Bouton, Carte, Pastille, Rangee, Texte } from "./base";
import { Menu, Saisie } from "./menu";

export interface GestesSauvegardes {
  creer: (nom: string) => Promise<unknown>;
  verrouiller: (sauvegarde: string, verrou: boolean) => Promise<unknown>;
  restaurer: (sauvegarde: string, vider: boolean) => Promise<unknown>;
  supprimer: (sauvegarde: string) => Promise<unknown>;
}

const NIVEAU = { "en-cours": "info", reussie: "success", ratee: "danger" } as const;

/**
 * Les sauvegardes d'un serveur. Restaurer et supprimer demandent une
 * confirmation, puis la présence (biométrie) : le SDK la joint à l'appel.
 */
export function ListeSauvegardes({
  liste,
  gestes,
}: {
  liste: ClientBackupList;
  gestes: GestesSauvegardes;
}) {
  const t = useTranslations("backups");
  const tm = useTranslations("mobile.sauvegardes");
  const tc = useTranslations("mobile.commun");
  const format = useFormatter();
  const geste = useGeste();
  const [ouverte, setOuverte] = useState<ClientBackupView | null>(null);
  const [creation, setCreation] = useState<string | null>(null);
  const plein = quotaAtteint(liste);

  const restaurer = (s: ClientBackupView) =>
    Alert.alert(t("restoreTitle"), `${t("restoreBody")}\n\n${tm("viderAide")}`, [
      { text: tc("annuler"), style: "cancel" },
      { text: tm("restaurer"), onPress: () => lancer(s, false) },
      { text: tm("viderPuisRestaurer"), style: "destructive", onPress: () => lancer(s, true) },
    ]);
  const lancer = (s: ClientBackupView, vider: boolean) =>
    geste(() => gestes.restaurer(s.id, vider)).then(
      (fait) => fait && Alert.alert(tm("restaurationLancee"), tm("restaurationAide")),
    );
  const supprimer = (s: ClientBackupView) =>
    Alert.alert(t("deleteTitle"), t("deleteBody"), [
      { text: tc("annuler"), style: "cancel" },
      {
        text: tm("supprimer"),
        style: "destructive",
        onPress: () => geste(() => gestes.supprimer(s.id)),
      },
    ]);
  const actions: Record<ActionSauvegarde, (s: ClientBackupView) => void> = {
    restaurer,
    verrouiller: (s) => geste(() => gestes.verrouiller(s.id, true)),
    deverrouiller: (s) => geste(() => gestes.verrouiller(s.id, false)),
    supprimer,
  };
  const libelles: Record<ActionSauvegarde, string> = {
    restaurer: tm("restaurer"),
    verrouiller: t("lock"),
    deverrouiller: t("unlock"),
    supprimer: tm("supprimer"),
  };

  return (
    <>
      <Texte ton="discret">{tm("quota", { utilise: liste.used, max: liste.limit })}</Texte>
      {plein ? <Bandeau titre={tm("quotaAtteint")} niveau="warning" /> : null}
      <Bouton
        titre={t("create")}
        inactif={plein}
        onPress={() => setCreation(nomParDefaut(new Date()))}
      />
      {liste.items.length === 0 ? <Bandeau titre={t("empty")}>{t("emptyHint")}</Bandeau> : null}
      {liste.items.map((s) => {
        const etat = etatSauvegarde(s);
        return (
          <Carte
            key={s.id}
            onPress={actionsSauvegarde(s).length > 0 ? () => setOuverte(s) : undefined}
          >
            <Rangee>
              <Pastille niveau={NIVEAU[etat]} />
              <Texte>{s.name}</Texte>
            </Rangee>
            <Texte ton="discret">
              {[
                { "en-cours": t("inProgress"), reussie: t("done"), ratee: t("failed") }[etat],
                format.dateTime(new Date(s.createdAt), { dateStyle: "medium", timeStyle: "short" }),
                etat === "reussie" ? formatBytes(s.bytes) : null,
                s.isLocked ? t("locked") : null,
                s.source === "snapshot" ? t("consistent") : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </Texte>
          </Carte>
        );
      })}
      <Menu
        titre={ouverte?.name ?? null}
        choix={(ouverte ? actionsSauvegarde(ouverte) : []).map((action) => ({
          titre: libelles[action],
          danger: action === "supprimer",
          onPress: () => ouverte && actions[action](ouverte),
        }))}
        onFermer={() => setOuverte(null)}
      />
      <Saisie
        titre={creation === null ? null : t("newTitle")}
        aide={t("newBody")}
        libelle={tm("nom")}
        initiale={creation ?? ""}
        action={t("start")}
        refus={(nom) => (nom.trim() === "" ? tm("nomVide") : null)}
        valider={(nom) => gestes.creer(nom.trim()).then(() => null)}
        onFermer={() => setCreation(null)}
      />
    </>
  );
}
