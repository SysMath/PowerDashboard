import { formatBytes } from "@gamedashboard/sdk/format";
import { Stack, useLocalSearchParams } from "expo-router";
import { useTranslations } from "use-intl";
import { Bandeau, Bouton, Ecran, Texte } from "@/composants/base";
import { SaisieConsole, SortieConsole } from "@/composants/console";
import { useConsole } from "@/hooks/useConsole";

/** La console en direct, ouverte chez le daemon comme depuis le navigateur. */
export default function Console() {
  const { serveur: id } = useLocalSearchParams<{ serveur: string }>();
  const t = useTranslations("console");
  const tm = useTranslations("mobile.console");
  const { lignes, releve, phase, envoyer, rouvrir } = useConsole(id);

  return (
    <Ecran defile={false}>
      <Stack.Screen options={{ title: t("title") }} />
      {phase === "connexion" ? <Texte ton="discret">{t("connecting")}</Texte> : null}
      {phase === "fermee" ? (
        <Bandeau titre={t("interrupted")} niveau="warning">
          {tm("interrompue")}
        </Bandeau>
      ) : null}
      {phase === "fermee" ? <Bouton titre={tm("reconnecter")} onPress={rouvrir} /> : null}
      {releve ? (
        <Texte ton="discret">
          {tm("releve", {
            cpu: releve.cpuPct.toFixed(0),
            memoire: formatBytes(releve.memoireOctets),
          })}
        </Texte>
      ) : null}
      <SortieConsole lignes={lignes} />
      <SaisieConsole onEnvoyer={envoyer} inactif={phase !== "ouverte"} />
    </Ecran>
  );
}
