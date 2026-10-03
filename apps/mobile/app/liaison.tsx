import { useRouter } from "expo-router";
import { useEffect } from "react";
import { Chargement } from "@/composants/base";

/**
 * `gamedashboard://liaison` : le retour du navigateur.
 *
 * L'écran d'ajout le reçoit lui-même (`openAuthSessionAsync`) ; sur Android,
 * le routeur l'ouvre aussi comme une page. Elle se retire aussitôt, et rend
 * la main à l'écran d'ajout, resté dessous, qui termine la liaison.
 */
export default function RetourLiaison() {
  const router = useRouter();
  useEffect(() => {
    if (router.canGoBack()) router.back();
    else router.replace("/");
  }, [router]);
  return <Chargement />;
}
