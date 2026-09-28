"use client";

import { nodeOutageBlock, serverBlock } from "@gamedashboard/contracts";
import {
  AlertBanner,
  type ConsoleLabels,
  ConsoleView,
  formatMb,
  PageHeader,
  PowerControls,
  SERVER_STATE_META,
  ServerStatusBar,
  Skeleton,
  SparkChart,
} from "@gamedashboard/ui";
import { Terminal } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { useCommandHistory } from "@/lib/command-history";
import { useServerSocket } from "@/lib/use-server-socket";
import type { ClientServer } from "@/server/api/client";
import { ConsumptionExport } from "./consumption-export";
import { ServerBlockNotice } from "./server-block-notice";
import { ServerMetricsHistory } from "./server-metrics-history";

/** Fenêtre de mesures affichée dans les graphes, en secondes. */
const WINDOW = 60;

/**
 * Espace console : barre d'état, console, alimentation, graphes.
 *
 * Tout vient du websocket de Wings. Rien n'est simulé : un graphe inventé
 * pendant que le serveur est réellement à l'arrêt est pire qu'un graphe vide,
 * parce qu'il inspire confiance.
 */
export function ConsoleWorkspace({
  server,
  commands = [],
}: {
  server: ClientServer;
  /** Commandes du jeu déclarées par l'egg, pour l'autocomplétion. */
  commands?: string[];
}) {
  const t = useTranslations("console");
  const labels = useConsoleLabels();
  const [history, setHistory] = useCommandHistory(server.id);
  const tm = useTranslations("metrics");
  const router = useRouter();
  const { phase, state, stats, lines, install, send, power } = useServerSocket(
    server.id,
    // Le node est nommé dans les messages du daemon : sur un compte qui tient
    // plusieurs serveurs, savoir quelle machine parle vaut mieux que de lire
    // le nom d'un logiciel que le client n'a pas à connaître.
    server.nodeName,
  );
  const [cpu, setCpu] = useState<{ t: number; v: number }[]>([]);
  const [mem, setMem] = useState<{ t: number; v: number }[]>([]);

  /**
   * Les commandes ne sont rendues qu'après hydratation.
   *
   * Tout ce qui est interactif ici dépend d'un websocket que le serveur n'a
   * pas : il rend forcément « connexion en cours, tout désactivé », pendant
   * que le navigateur, dès la socket ouverte, rend l'inverse. React compare
   * les deux et signale une divergence — `disabled` vrai d'un côté, absent de
   * l'autre.
   *
   * Ce n'est pas un défaut à faire taire : le serveur a réellement tort. La
   * seule réponse juste est de ne pas lui faire rendre ce qu'il ignore.
   */
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  /**
   * Les graphes n'avancent qu'au rythme des mesures reçues.
   *
   * Pas de minuterie qui extrapole : une courbe qui continue de monter alors
   * que le daemon ne répond plus donnerait l'impression que tout va bien,
   * exactement au moment où ce n'est plus vrai.
   */
  useEffect(() => {
    if (!stats) return;
    setCpu((d) => slide(d, stats.cpuPct));
    setMem((d) => slide(d, stats.memoryBytes / 1024 / 1024));
  }, [stats]);

  /**
   * Avant hydratation, l'état est **inconnu**, pas « hors ligne ».
   *
   * Écrire « hors ligne » sur un serveur peut-être en marche est faux, et c'est
   * la première chose que quelqu'un lit en arrivant sur la page.
   */
  /*
   * L'état de **gestion** prime sur celui du conteneur.
   *
   * Le daemon rapporte « hors ligne » pendant une installation — ce qui est
   * exact pour lui : le conteneur ne tourne pas. Mais ce n'est pas ce que
   * l'utilisateur doit lire, et surtout pas ce sur quoi les boutons doivent se
   * régler. `server.state` vient de la base et dit ce que le panel est en
   * train de faire à ce serveur.
   */
  /*
   * La machine muette est un blocage comme un autre — et il prime.
   *
   * Un serveur peut être en ordre pour le panel et inatteignable en fait.
   * C'est alors la machine qui commande, parce que c'est elle qui fera échouer
   * tout ce qu'on tentera : console, alimentation, fichiers.
   */
  const blocage = nodeOutageBlock(server.nodeUnreachableSince) ?? serverBlock(server.state);

  /*
   * La machine ne répond plus : on ne sait rien de ce serveur.
   *
   * **« Hors ligne » est une affirmation, et elle est fausse ici.** Le
   * conteneur tourne peut-être encore — c'est le daemon qui est muet, pas le
   * serveur. Le panel affichait pourtant ce badge, à côté de mesures marquées
   * « Inconnu » : deux lectures contradictoires du même silence, dans la même
   * barre.
   *
   * `null` remet l'état au même rang que les mesures : inconnu, et dit comme
   * tel. La cause, elle, est annoncée une fois par le bandeau du cadre.
   */
  const machineMuette = server.nodeUnreachableSince !== null;
  const effective = blocage
    ? server.state
    : machineMuette
      ? null
      : mounted
        ? (state ?? "offline")
        : null;
  const meta =
    effective === null
      ? null
      : (SERVER_STATE_META[effective as keyof typeof SERVER_STATE_META] ??
        SERVER_STATE_META.offline);

  /*
   * Pendant une opération qui se termine seule, l'écran ne montre qu'elle.
   *
   * La console complète ment alors sur trois points à la fois : la barre d'état
   * affiche « Inconnu » partout — le conteneur ne tourne pas, il n'y a rien à
   * mesurer —, les quatre boutons d'alimentation sont présents et désactivés,
   * et la ligne de commande attend une commande qui partirait à un programme
   * qui n'existe pas encore.
   *
   * Ce qui compte à ce moment-là est ailleurs : la sortie du script
   * d'installation. On la garde, et on retire tout le reste. C'est la même
   * règle qui vide la barre latérale et masque le rappel du contrat de licence
   * — trois façons de proposer des gestes qu'aucun n'aboutit.
   *
   * `transient` et non « bloqué » : une installation **échouée** doit au
   * contraire tout rendre, puisqu'il faut alors agir pour en sortir.
   */
  if (blocage?.transient) {
    return (
      <div className="mx-auto flex max-w-[1400px] flex-col gap-5">
        {machineMuette ? null : <ServerBlockNotice block={blocage} install={install} />}
        <PageHeader
          icon={<Terminal />}
          title={blocage.label}
          subtitle={t("installSubtitle")}
          breadcrumbs={[{ label: t("myServers"), href: "/servers" }, { label: server.name }]}
        />
        {mounted ? (
          // En lecture seule : ni envoi de commande, ni bouton de dépôt. Le
          // daemon parle, on écoute.
          <ConsoleView lines={lines} labels={labels} placeholder={t("placeholder")} disabled />
        ) : (
          <Skeleton className="h-[420px] w-full" />
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-5">
      {blocage && !machineMuette ? <ServerBlockNotice block={blocage} install={install} /> : null}

      <PageHeader
        icon={<Terminal />}
        title={t("title")}
        subtitle={t("subtitle")}
        breadcrumbs={[{ label: t("myServers"), href: "/servers" }, { label: server.name }]}
      />

      {/*
        Le websocket a forcément lâché quand la machine est tombée — mais
        « Rechargez la page pour vous reconnecter » est alors un conseil qui ne
        peut pas marcher, et qui laisse croire que le problème est local. Le
        bandeau de panne de machine, posé plus haut par le cadre du serveur,
        dit déjà ce qu'il y a à savoir. On se tait plutôt que de le contredire.
      */}
      {mounted && !machineMuette && (phase === "error" || phase === "closed") ? (
        <AlertBanner
          variant={phase === "error" ? "danger" : "warning"}
          title={phase === "error" ? t("unavailable") : t("interrupted")}
        >
          {phase === "error" ? t("unavailableBody") : t("interruptedBody")}
        </AlertBanner>
      ) : null}

      <ServerStatusBar
        name={server.name}
        address={server.address}
        /*
         * Trois lectures du même silence, et elles ne disent pas la même
         * chose : « Connexion… » pendant qu'on ouvre la socket, « Machine
         * injoignable » quand le node est tombé, et l'état réel sinon. Les
         * confondre en « Hors ligne » revenait à affirmer que le serveur est
         * arrêté chaque fois qu'on ne savait rien.
         */
        stateLabel={
          machineMuette
            ? t("nodeSilent")
            : meta === null || phase === "connecting"
              ? t("connecting")
              : meta.label
        }
        tone={machineMuette || meta === null || phase === "connecting" ? "neutral" : meta.tone}
        // Aucun battement quand la machine est muette : une pastille qui pulse
        // fait attendre un changement, et rien ne changera avant qu'elle
        // revienne.
        pulse={!machineMuette && (meta === null || phase === "connecting" || meta.pulse)}
        metrics={[
          {
            label: tm("cpu"),
            // `null` tant qu'aucune mesure n'est parvenue : la barre est
            // hachurée, et personne ne lit « 0 % » comme « au repos ».
            value: stats?.cpuPct ?? null,
            max: 100,
            format: (v) => `${v.toFixed(1)} %`,
          },
          {
            label: tm("memory"),
            value: stats ? stats.memoryBytes / 1024 / 1024 : null,
            max: server.memoryMaxMb,
            format: (v) => formatMb(v, 1),
          },
          {
            label: tm("disk"),
            value: stats ? stats.diskBytes / 1024 / 1024 : null,
            max: server.diskMaxMb,
            format: (v) => formatMb(v, 1),
          },
        ]}
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <SparkChart
            title={t("cpuChart")}
            data={cpu}
            max={100}
            unit=" %"
            format={(v) => v.toFixed(2)}
          />
          <SparkChart
            title={t("memoryChart")}
            data={mem}
            max={server.memoryMaxMb}
            format={(v) => formatMb(v, 0)}
          />
        </div>
      </ServerStatusBar>

      {/* Les deux blocs interactifs n'existent qu'après hydratation : leur état
          dépend entièrement de la socket, que le serveur n'a pas. Un squelette
          de même hauteur évite que la page saute au montage. */}
      {mounted ? (
        <ConsoleView
          lines={lines}
          labels={labels}
          placeholder={t("placeholder")}
          history={history}
          onHistoryChange={setHistory}
          commands={commands}
          // Pendant une installation, la ligne de commande est fermée : ce
          // qu'on y taperait partirait à un programme qui n'existe pas encore.
          disabled={blocage !== null || phase !== "open" || effective !== "running"}
          onSend={send}
          /*
           * Le bouton menait à un message « à venir ». L'envoi de fichiers
           * existe maintenant, mais il vit dans le gestionnaire de fichiers —
           * c'est là qu'on voit où l'on dépose, et savoir où l'on dépose est
           * justement ce qui manque le plus quand on envoie quelque chose. Le
           * bouton y conduit, plutôt que d'ouvrir une sélection de fichier
           * sans destination visible.
           */
          onUpload={() => router.push(`/server/${server.id}/files`)}
        />
      ) : (
        <Skeleton className="h-[420px] w-full" />
      )}

      <div className="flex justify-center">
        {mounted ? (
          <PowerControls
            state={effective as never}
            // L'état de gestion l'emporte : pendant une installation, aucun des
            // quatre ordres n'a de sens, et l'API les refuserait tous.
            blocked={blocage !== null}
            // L'ordre part par le websocket déjà ouvert : c'est le même canal que
            // celui qui rapportera le changement d'état, donc pas de fenêtre où
            // l'interface affiche un état que le daemon n'a pas confirmé.
            onSignal={(signal) => power(signal)}
          />
        ) : (
          <Skeleton className="h-9 w-80" />
        )}
      </div>

      {/* Sous le direct, pas dans un onglet à part : la question « depuis
          quand ? » se pose en regardant la courbe du moment. Lu en base, il
          reste lisible quand le daemon se tait. */}
      <ServerMetricsHistory server={server} />
      {/* Les mêmes relevés, résumés par jour et à emporter : pour vérifier une
          facture à l'usage, ou la faire soi-même. */}
      <ConsumptionExport
        endpoint={`/api/servers/${encodeURIComponent(server.id)}/consumption-export`}
        audience="server"
      />
    </div>
  );
}

/** Ajoute un point et fait glisser la fenêtre. */
function slide(data: { t: number; v: number }[], value: number) {
  const next = [...data, { t: (data.at(-1)?.t ?? 0) + 1, v: value }];
  return next.length > WINDOW ? next.slice(next.length - WINDOW) : next;
}

/** Les textes de la console, dans la langue du compte. */
function useConsoleLabels(): Partial<ConsoleLabels> {
  const t = useTranslations("console");
  return useMemo(
    () => ({
      command: t("command"),
      upload: t("upload"),
      send: t("send"),
      waiting: t("waiting"),
      noMatch: t("noMatch"),
      source: t("source"),
      sources: { all: t("sourceAll"), server: t("sourceServer"), system: t("sourceSystem") },
      levels: t("levels"),
      levelNames: { error: t("levelError"), warn: t("levelWarn"), info: t("levelInfo") },
      search: t("search"),
      clearSearch: t("clearSearch"),
      suggestions: t("suggestions"),
      fromHistory: t("fromHistory"),
      fromEgg: t("fromEgg"),
      shown: (shown: number, total: number) => t("shown", { shown, total }),
    }),
    [t],
  );
}
