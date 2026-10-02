import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import { Bandeau, Bouton, Champ, Chargement, Ecran, Texte } from "@/composants/base";
import { FicheInstance } from "@/composants/instances";
import { useAjout } from "@/hooks/useAjout";
import { nomParDefaut } from "@/natif/appareil";
import { ouvrirConfidentialite } from "@/natif/navigateur";

/** Ajouter un panel : son adresse (ou son code QR), sa fiche, puis la liaison. */
export default function Ajouter() {
  const t = useTranslations("mobile.ajout");
  const ti = useTranslations("mobile.instances");
  const router = useRouter();
  const { adresse: scannee } = useLocalSearchParams<{ adresse?: string }>();
  const { etape, verifier, relier, recommencer } = useAjout();
  const [adresse, setAdresse] = useState(scannee ?? "");
  const [nom, setNom] = useState(nomParDefaut);

  // biome-ignore lint/correctness/useExhaustiveDependencies: seule l'adresse scannée relance
  useEffect(() => {
    if (scannee) void verifier(scannee);
  }, [scannee]);

  return (
    <Ecran>
      <Stack.Screen options={{ title: t("titre") }} />
      {etape.etape === "saisie" ? (
        <>
          <Texte>{t("intro")}</Texte>
          {etape.probleme ? <Bandeau titre={etape.probleme} niveau="danger" /> : null}
          <Champ
            libelle={t("adresse.libelle")}
            value={adresse}
            onChangeText={setAdresse}
            placeholder="panel.example.com"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            onSubmitEditing={() => verifier(adresse)}
          />
          <Bouton titre={t("verifier")} onPress={() => verifier(adresse)} />
          <Bouton
            titre={t("scanner")}
            variante="secondaire"
            onPress={() => router.push("/scanner")}
          />
          <Bouton
            titre={ti("confidentialite")}
            variante="secondaire"
            onPress={ouvrirConfidentialite}
          />
        </>
      ) : etape.etape === "verification" ? (
        <Chargement />
      ) : (
        <>
          <FicheInstance adresse={etape.adresse} descripteur={etape.descripteur} />
          {etape.etape === "fiche" && etape.probleme ? (
            <Bandeau titre={etape.probleme} niveau="danger" />
          ) : null}
          <Champ libelle={t("nomAppareil")} value={nom} onChangeText={setNom} maxLength={80} />
          <Bouton
            titre={t("seConnecter")}
            inactif={etape.etape === "liaison" || nom.trim() === ""}
            onPress={() => relier(nom.trim())}
          />
          <Bouton titre={t("autreAdresse")} variante="secondaire" onPress={recommencer} />
        </>
      )}
    </Ecran>
  );
}
