import { serverBlock } from "@gamedashboard/contracts";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { EulaNotice } from "@/components/eula-notice";
import { NodeOutageNotice } from "@/components/node-outage-notice";
import { ServerBlockProvider } from "@/components/server-block-context";
import { PanelShell } from "@/components/shell";
import { serverNav } from "@/config/navigation";
import { toShellServer } from "@/lib/server-view";
import { displayName } from "@/lib/session-user";
import { fetchActiveAnnouncements } from "@/server/api/announcements";
import { fetchFeatures, fetchMe, fetchMyServer, fetchMyServers } from "@/server/api/client";
import { fetchEulaState } from "@/server/api/engine";
import { fetchNotifications } from "@/server/api/notifications";

/** Layout partagé par toutes les pages d'un serveur : sidebar dépendante de l'id. */
export default async function ServerLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const [t, courant, servers, notifications, me, announcements, features] = await Promise.all([
    getTranslations("nav"),
    // Le serveur regardé, demandé **par son identifiant**. Voir plus bas.
    fetchMyServer(id),
    fetchMyServers(),
    fetchNotifications(),
    fetchMe(),
    fetchActiveAnnouncements(),
    fetchFeatures(),
  ]);

  /**
   * Le contrôle d'accès est celui de l'API, et rien d'autre.
   *
   * Il regardait « ce serveur est-il dans ma liste ? » — c'est-à-dire la
   * propriété et l'invitation, et rien de plus. Un administrateur et un
   * revendeur se voyaient donc refuser la mise en page entière, **avant**
   * toute page : d'où un « Page introuvable » sans même la barre latérale,
   * sur un serveur dont l'API leur rendait pourtant la fiche.
   *
   * C'était la troisième copie de la même règle — après la route et la lecture
   * unitaire. Elle est supprimée plutôt que corrigée : `fetchMyServer` demande
   * à l'API, qui seule connaît le propriétaire, l'invité, le personnel et le
   * revendeur qui héberge. Une quatrième copie ne peut plus diverger, puisqu'il
   * n'y en a plus qu'une.
   *
   * La réponse reste « introuvable » et non « interdit » : il ne faut pas
   * pouvoir distinguer un serveur qui n'existe pas d'un serveur qui n'est pas
   * le sien.
   */
  if (!courant) notFound();

  /*
   * Pendant une opération qui se termine seule, on ne propose rien.
   *
   * Installation, restauration, transfert : le daemon écrit dans le volume, et
   * l'API refuse toute écriture. Chaque entrée de la barre latérale mène alors
   * à un écran qui ne peut que dire non — le gestionnaire de fichiers montre
   * une arborescence en train d'être peuplée, les sauvegardes refusent, les
   * bases refusent. Les laisser revient à inviter à des gestes qu'on sait
   * voués à l'échec.
   *
   * Le sélecteur de serveur, lui, reste : c'est le seul chemin pour aller
   * ailleurs pendant qu'on attend.
   *
   * `transient` et non « bloqué » : un serveur suspendu ou dont l'installation
   * a échoué garde toute sa barre latérale. Il faut précisément pouvoir agir
   * pour en sortir, et c'est par « Paramètres » qu'on relance une
   * installation.
   */
  const enCours =
    serverBlock(courant.state)?.transient === true || courant.nodeUnreachableSince !== null;

  return (
    <PanelShell
      sections={
        enCours ? [] : serverNav(id, t, { ...features, snapshots: courant.snapshots === true })
      }
      serverId={id}
      /*
       * Le serveur regardé est ajouté s'il n'est pas déjà dans la liste.
       *
       * C'est le cas d'un administrateur ou d'un revendeur qui ouvre le serveur
       * d'un client : il y a droit, mais ce n'est pas le sien. Sans cet ajout,
       * le sélecteur de la coquille n'aurait rien à afficher pour la page en
       * cours — on lirait le nom du serveur dans le fil d'Ariane et le vide
       * juste à côté.
       */
      servers={(servers.some((s) => s.id === id) ? servers : [...servers, courant]).map(
        toShellServer,
      )}
      notifications={notifications}
      userName={displayName(me)}
      userEmail={me.email}
      userRole={me.role}
      userAuthMethod={me.authMethod}
      impersonatedBy={me.impersonator?.email ?? null}
      announcements={announcements}
      userAvatarUrl={me.avatarUrl}
    >
      {/*
        Le rappel du contrat vit ici, et non sur le seul écran « Moteur ».
        Le message qui l'appelle apparaît dans la console : voir le problème
        à un endroit et sa solution à un autre ne relie rien.

        L'échec de lecture ne casse pas la page : un daemon muet sur un
        fichier ne doit pas empêcher d'ouvrir son serveur.

        **Masqué pendant une installation**, et pour une raison de fond : le
        contrat se lit dans `eula.txt`, que le script d'installation est en
        train d'écrire. Le rappel apparaissait donc au-dessus de
        « Installation en cours », pressant d'accepter une licence pour
        démarrer un serveur qui n'existe pas encore. Deux avertissements
        empilés, dont l'un ne demande rien qu'on puisse faire.
      */}
      {/*
        La panne de machine passe **avant** tout le reste, et fait taire le
        reste. Quand le node ne répond pas, le contrat de licence ne peut pas
        être lu : réclamer de l'accepter accuserait le client d'un manquement
        qui n'existe peut-être pas, et masquerait la vraie cause.
      */}
      <NodeOutageNotice nodeName={courant.nodeName} since={courant.nodeUnreachableSince} />
      {enCours ? null : (
        <EulaNotice serverId={id} eula={await fetchEulaState(id).catch(() => null)} />
      )}
      {/*
        L'état de gestion est fourni ici parce qu'il est déjà lu ici.
        Chaque écran y prend de quoi se taire : l'API refuse désormais
        d'écrire sur un serveur bloqué, et un bouton qui reste actif ne fait
        qu'apprendre la règle par l'échec.
      */}
      <ServerBlockProvider
        state={courant.state}
        nodeUnreachableSince={courant.nodeUnreachableSince}
      >
        {children}
      </ServerBlockProvider>
    </PanelShell>
  );
}
