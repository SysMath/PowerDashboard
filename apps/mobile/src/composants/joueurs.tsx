import type { ClientPlayersView, PlayerAction } from "@gamedashboard/contracts";
import { useState } from "react";
import { Alert } from "react-native";
import { useTranslations } from "use-intl";
import { Bandeau, Bouton, Carte, Champ, Texte } from "./base";
import { Menu } from "./menu";

/**
 * Les joueurs connectés et les actions que l'egg déclare : rien d'autre n'est
 * proposé, et le panel écrit la commande à partir de l'egg.
 */
export function ListeJoueurs(props: {
  vue: ClientPlayersView;
  onAgir: (action: PlayerAction, joueur: string) => Promise<void>;
}) {
  const t = useTranslations("players");
  const [autre, setAutre] = useState("");
  const { vue } = props;

  const [cible, setCible] = useState<string | null>(null);
  const agir = (action: PlayerAction, joueur: string) =>
    props
      .onAgir(action, joueur)
      .then(() => Alert.alert(t("sent", { action: t(`action.${action}`), player: joueur })))
      .catch((erreur: unknown) => Alert.alert(String((erreur as Error).message ?? erreur)));
  // Une feuille plutôt qu'`Alert` : Android n'y montre que trois boutons, et
  // l'egg peut en déclarer davantage (expulser, bannir, opérateur…).
  const choisir = (joueur: string) => {
    if (vue.actions.length > 0) setCible(joueur);
  };

  return (
    <>
      <Texte ton="discret">
        {vue.online !== null && vue.max !== null
          ? t("counter", { online: vue.online, max: vue.max })
          : t("unknownCount")}
      </Texte>
      {vue.observedAt === null ? <Bandeau titre={t("noProbe")}>{t("noProbeHint")}</Bandeau> : null}
      {!vue.complete && vue.sample ? <Bandeau titre={t("partial")} /> : null}
      {vue.sample && vue.sample.length > 0
        ? vue.sample.map((joueur) => (
            <Carte key={joueur} onPress={() => choisir(joueur)}>
              <Texte>{joueur}</Texte>
            </Carte>
          ))
        : vue.observedAt !== null && <Texte ton="discret">{t("empty")}</Texte>}
      {vue.actions.length === 0 ? (
        <Bandeau titre={t("noCommands")}>{t("noCommandsHint")}</Bandeau>
      ) : (
        <Carte>
          <Champ
            libelle={t("playerLabel")}
            value={autre}
            onChangeText={setAutre}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Bouton
            titre={t("act")}
            inactif={autre.trim() === ""}
            onPress={() => choisir(autre.trim())}
          />
        </Carte>
      )}
      <Menu
        titre={cible}
        choix={vue.actions.map((action) => ({
          titre: t(`action.${action}`),
          onPress: () => cible && agir(action, cible),
        }))}
        onFermer={() => setCible(null)}
      />
    </>
  );
}
