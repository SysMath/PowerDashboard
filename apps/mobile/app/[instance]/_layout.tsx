import { useLocalSearchParams, useRouter } from "expo-router";
import { Chargement } from "@/composants/base";
import { CadreDemo, EcranCadre, PileEcrans } from "@/composants/instances";
import { useApplis } from "@/etat/applis";
import { ID_DEMO } from "@/etat/demo";
import { ContexteInstance } from "@/etat/instance";
import { useCadreInstance } from "@/hooks/useCadreInstance";
import { usePousse } from "@/hooks/usePousse";
import { cle } from "@/natif/cle";
import { aliasCle } from "@/noyau/instances";

/**
 * Le cadre d'un panel lié : biométrie à l'ouverture, panel toujours le même,
 * appareil toujours lié. Les écrans du panel ne s'affichent qu'une fois tout
 * cela vérifié.
 */
export default function Cadre() {
  const { instance: id } = useLocalSearchParams<{ instance: string }>();
  return id === ID_DEMO ? <CadreDemo /> : <CadreInstance id={id} />;
}

function CadreInstance({ id }: { id: string }) {
  const { registre } = useApplis();
  const router = useRouter();
  const { cadre, reessayer } = useCadreInstance(id);
  usePousse(cadre.etat === "ouvert" ? cadre.ouverte : null);

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
        <PileEcrans />
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
