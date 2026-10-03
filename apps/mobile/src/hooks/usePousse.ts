import { useRouter } from "expo-router";
import { useEffect, useRef } from "react";
import { useTranslations } from "use-intl";
import { useApplis } from "@/etat/applis";
import type { InstanceOuverte } from "@/etat/instance";
import { coffre } from "@/natif/coffre";
import { jetonExpo, relaisConnus, TOUCHER_PAR_DEFAUT, useDernierToucher } from "@/natif/pousse";
import { cibleToucher, inscrirePousse } from "@/noyau/pousse";

const horloge = { maintenant: () => Date.now() };

/**
 * À l'ouverture d'un panel, dépose chez lui de quoi joindre ce téléphone
 * (ADR 0010, lot 4). Un échec ne gêne jamais l'ouverture : on retentera à la
 * suivante, et la cloche reste relevée à chaque fois.
 */
export function usePousse(ouverte: InstanceOuverte | null): void {
  const t = useTranslations("mobile.pousse");
  useEffect(() => {
    const descripteur = ouverte?.descripteur;
    if (!ouverte || !descripteur) return;
    let actif = true;
    (async () => {
      const jeton = await jetonExpo(t("canal"));
      if (!actif) return;
      await inscrirePousse(
        { fetch: (...args) => fetch(...args), coffre, horloge, relaisConnus },
        {
          instance: ouverte.instance,
          descripteur,
          jetonExpo: jeton,
          jetonAcces: () => ouverte.session.jeton(),
        },
      );
    })().catch(() => undefined);
    return () => {
      actif = false;
    };
  }, [ouverte, t]);
}

/** Le toucher d'une notification ouvre la cloche du panel qui l'a envoyée. */
export function useToucherNotification(): void {
  const { registre } = useApplis();
  const router = useRouter();
  const reponse = useDernierToucher();
  const traitee = useRef<string | null>(null);
  useEffect(() => {
    if (!reponse || reponse.actionIdentifier !== TOUCHER_PAR_DEFAUT) return;
    const id = reponse.notification.request.identifier;
    if (traitee.current === id) return;
    traitee.current = id;
    void registre.lister().then((instances) => {
      const cible = cibleToucher(reponse.notification.request.content.data, instances);
      if (cible) router.push(`/${cible.instanceId}/notifications`);
    });
  }, [reponse, registre, router]);
}
