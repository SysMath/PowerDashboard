import { NODE_AGENT_FUNCTIONS, type NodeAgentFunction } from "@gamedashboard/contracts";
import { Stack, useLocalSearchParams } from "expo-router";
import { useTranslations } from "use-intl";
import { CarteMachine } from "@/composants/administration";
import { Bandeau, Carte, Chargement, Ecran, Pastille, Rangee, Texte } from "@/composants/base";
import { useAgent, useMachines } from "@/hooks/useAdministration";

/** Une machine : sa santé, son agent et ce qu'il offre. Rien ne s'y règle. */
export default function Machine() {
  const { machine: id } = useLocalSearchParams<{ machine: string }>();
  const t = useTranslations("mobile.administration.machines");
  const machines = useMachines();
  const agent = useAgent(id);
  const node = machines.donnees?.find((autre) => autre.id === id);
  const fonctions = Object.entries(agent.donnees?.capabilities ?? {});

  return (
    <Ecran>
      <Stack.Screen options={{ title: node?.name ?? t("titre") }} />
      {machines.erreur ? <Bandeau titre={machines.erreur} niveau="danger" /> : null}
      {node ? <CarteMachine node={node} /> : <Chargement />}
      {node?.maintenance ? <Bandeau titre={t("maintenance")} niveau="warning" /> : null}
      <Carte>
        <Texte ton="titre">{t("agent")}</Texte>
        {agent.erreur ? <Texte ton="danger">{agent.erreur}</Texte> : null}
        {agent.donnees ? (
          <Texte ton="discret">
            {t(`agentEtat.${agent.donnees.status}`)}
            {agent.donnees.version ? ` · ${agent.donnees.version}` : ""}
          </Texte>
        ) : null}
        {fonctions.map(([nom, capacite]) => (
          <Rangee key={nom}>
            <Pastille
              niveau={capacite.writable ? "success" : capacite.offered ? "warning" : "neutre"}
            />
            <Texte>{NODE_AGENT_FUNCTIONS[nom as NodeAgentFunction]?.label ?? nom}</Texte>
            {capacite.reason ? <Texte ton="discret">{capacite.reason}</Texte> : null}
          </Rangee>
        ))}
      </Carte>
    </Ecran>
  );
}
