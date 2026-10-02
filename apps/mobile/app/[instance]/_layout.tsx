import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { Chargement } from "@/composants/base";
import { EcranCadre } from "@/composants/instances";
import { useApplis } from "@/etat/applis";
import { ContexteInstance } from "@/etat/instance";
import { useCadreInstance } from "@/hooks/useCadreInstance";
import { cle } from "@/natif/cle";
import { aliasCle } from "@/noyau/instances";
import { useCouleurs } from "@/theme/theme";

/**
 * Le cadre d'un panel lié : biométrie à l'ouverture, panel toujours le même,
 * appareil toujours lié. Les écrans du panel ne s'affichent qu'une fois tout
 * cela vérifié.
 */
export default function CadreInstance() {
  const { instance: id } = useLocalSearchParams<{ instance: string }>();
  const { registre } = useApplis();
  const router = useRouter();
  const c = useCouleurs();
  const { cadre, reessayer } = useCadreInstance(id);

  const retirer = async () => {
    await cle.supprimer(aliasCle(id));
    await registre.retirer(id);
    router.replace("/");
  };
  const relier = (adresse: string) => router.replace({ pathname: "/ajouter", params: { adresse } });

  if (cadre.etat === "chargement") return <Chargement />;
  if (cadre.etat === "ouvert") {
    return (
      <ContexteInstance.Provider value={cadre.ouverte}>
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: c.surface },
            headerTintColor: c.text,
            contentStyle: { backgroundColor: c.bg },
          }}
        />
      </ContexteInstance.Provider>
    );
  }
  if (cadre.etat === "a-confirmer") {
    const { instance } = cadre;
    return (
      <EcranCadre
        etat="a-confirmer"
        instance={instance}
        onAgir={async () => {
          await cle.supprimer(aliasCle(id));
          await registre.marquerARelier(id);
          relier(instance.adresse);
        }}
        onRetirer={retirer}
      />
    );
  }
  if (cadre.etat === "a-relier") {
    return (
      <EcranCadre
        etat="a-relier"
        instance={cadre.instance}
        onAgir={() => relier(cadre.instance.adresse)}
        onRetirer={retirer}
      />
    );
  }
  return (
    <EcranCadre
      etat={cadre.etat}
      onAgir={cadre.etat === "introuvable" ? () => router.replace("/") : reessayer}
    />
  );
}
