import { Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { CarteCompte, SaisieMotif } from "@/composants/administration";
import { Bandeau, Bouton, Chargement, Ecran, Texte } from "@/composants/base";
import { useComptes } from "@/hooks/useAdministration";
import { useConfirme } from "@/hooks/useGeste";
import { useRole } from "@/hooks/useRevendeur";

/** Un compte : son profil, la suspension (avec motif), « déconnecter partout ». */
export default function Compte() {
  const { compte: id } = useLocalSearchParams<{ compte: string }>();
  const t = useTranslations("mobile.administration.comptes");
  const ecrire = useRole() === "admin";
  const confirme = useConfirme();
  const [motif, setMotif] = useState(false);
  const { donnees, erreur, suspendre, retablir, deconnecter } = useComptes();
  const compte = donnees?.find((autre) => autre.id === id);

  return (
    <Ecran>
      <Stack.Screen options={{ title: compte?.name ?? t("titre") }} />
      {erreur ? <Bandeau titre={erreur} niveau="danger" /> : null}
      {compte ? <CarteCompte compte={compte} /> : erreur ? null : <Chargement />}
      {compte?.suspendedAt ? (
        <Bandeau titre={t("suspendu")} niveau="warning">
          {compte.suspensionReason}
        </Bandeau>
      ) : null}
      {compte ? (
        <Texte ton="discret">
          {t(compte.is2faEnabled ? "avec2fa" : "sans2fa")} ·{" "}
          {t(compte.emailVerifiedAt ? "adresseConfirmee" : "adresseNonConfirmee")}
        </Texte>
      ) : null}
      {compte && ecrire ? (
        <>
          <Bouton
            titre={compte.suspendedAt ? t("retablir") : t("suspendre")}
            variante={compte.suspendedAt ? "secondaire" : "danger"}
            onPress={() =>
              compte.suspendedAt
                ? confirme(
                    { titre: t("retablirTitre"), corps: t("retablirCorps"), bouton: t("retablir") },
                    () => retablir(compte.id),
                  )
                : setMotif(true)
            }
          />
          <Bouton
            titre={t("deconnecter")}
            variante="secondaire"
            onPress={() =>
              confirme(
                {
                  titre: t("deconnecterTitre"),
                  corps: t("deconnecterCorps"),
                  bouton: t("deconnecter"),
                },
                () => deconnecter(compte.id),
                true,
              )
            }
          />
        </>
      ) : null}
      <SaisieMotif
        compte={motif && compte ? compte : null}
        suspendre={suspendre}
        onFermer={() => setMotif(false)}
      />
    </Ecran>
  );
}
