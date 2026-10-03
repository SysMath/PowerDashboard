import { CameraView, useCameraPermissions } from "expo-camera";
import { Stack, useRouter } from "expo-router";
import { useRef } from "react";
import { View } from "react-native";
import { useTranslations } from "use-intl";
import { Bouton, Ecran, Texte } from "@/composants/base";

/**
 * Lire le code QR du panel (Compte › Sécurité). Il ne porte que l'adresse :
 * elle repart vers l'écran d'ajout, qui la vérifie comme une adresse tapée.
 */
export default function Scanner() {
  const t = useTranslations("mobile.scanner");
  const router = useRouter();
  const [permission, demander] = useCameraPermissions();
  const lu = useRef(false);

  if (!permission?.granted) {
    return (
      <Ecran>
        <Stack.Screen options={{ title: t("titre") }} />
        <Texte>{t("permission")}</Texte>
        <Bouton titre={t("autoriser")} onPress={demander} />
      </Ecran>
    );
  }
  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: t("titre") }} />
      <CameraView
        style={{ flex: 1 }}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={({ data }) => {
          if (lu.current) return;
          lu.current = true;
          router.replace({ pathname: "/ajouter", params: { adresse: data } });
        }}
      />
    </View>
  );
}
