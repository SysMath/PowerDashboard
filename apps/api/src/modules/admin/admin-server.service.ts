import {
  platformAccessOf,
  platformMayProvision,
  reinstallBlocked,
  serverBlock,
} from "@gamedashboard/contracts";
import {
  allocations,
  type Database,
  eggs,
  eggVariables,
  nodes,
  servers,
  serverVariables,
  users,
} from "@gamedashboard/db";
import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DATABASE } from "../../common/database.provider";
import { isUuid } from "../../common/uuid";
import { WingsClientService } from "../wings/wings-client.service";
import { WingsTokenService } from "../wings/wings-token.service";

/**
 * Fiche d'administration d'un serveur : ce que l'espace client ne montre pas.
 *
 * L'espace client borne délibérément ce qu'un propriétaire peut changer — une
 * commande de démarrage libre lui permettrait d'exécuter ce qu'il veut dans le
 * conteneur, et une image arbitraire de sortir du catalogue éprouvé par l'egg.
 * Ces deux leviers existent quand même, parce qu'un hébergeur en a besoin : ils
 * vivent donc ici, derrière la garde d'administration.
 *
 * La pièce maîtresse est la **commande résolue**. Le panel remet au daemon un
 * environnement et une invocation à gabarits ; ce qui tourne réellement est le
 * résultat des deux. Ne montrer que le gabarit a coûté cher : un environnement
 * vide donnait `java -jar` sans rien derrière, et rien à l'écran ne le disait.
 * Afficher ce que Wings exécutera rend ce genre d'écart visible avant le
 * démarrage, pas après.
 */

export interface AdminServerVariable {
  name: string;
  envVariable: string;
  description: string | null;
  value: string;
  defaultValue: string;
  rules: string | null;
  /** Le propriétaire peut-il la voir, la modifier ? Ici, l'administration le peut toujours. */
  userViewable: boolean;
  userEditable: boolean;
}

export interface AdminServerDetail {
  id: string;
  shortId: string;
  name: string;
  description: string | null;
  state: string | null;
  owner: { id: string; name: string; email: string };
  node: { id: string; name: string; fqdn: string };
  egg: { id: string; name: string; images: Record<string, string> };
  dockerImage: string;
  startup: string;
  /** L'invocation, gabarits remplacés : ce que le conteneur lancera vraiment. */
  resolvedStartup: string;
  /** Gabarits présents dans la commande qu'aucune variable ne renseigne. */
  unresolvedPlaceholders: string[];
  resources: {
    memoryMb: number;
    swapMb: number;
    diskMb: number;
    cpuPct: number;
    ioWeight: number;
    threads: string | null;
    oomKiller: boolean;
  };
  limits: { backups: number; databases: number; allocations: number };
  variables: AdminServerVariable[];
  ports: { id: string; ip: string; port: number; isDefault: boolean }[];
}

@Injectable()
export class AdminServerService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(WingsClientService) private readonly wings: WingsClientService,
    @Inject(WingsTokenService) private readonly tokens: WingsTokenService,
  ) {}

  async detail(serverId: string): Promise<AdminServerDetail> {
    const [row] = await this.db
      .select({
        id: servers.id,
        shortId: servers.uuidShort,
        name: servers.name,
        description: servers.description,
        state: servers.state,
        dockerImage: servers.dockerImage,
        startup: servers.startup,
        memoryMb: servers.memoryMb,
        swapMb: servers.swapMb,
        diskMb: servers.diskMb,
        cpuPct: servers.cpuPct,
        ioWeight: servers.ioWeight,
        threads: servers.threads,
        oomKiller: servers.oomKiller,
        backupLimit: servers.backupLimit,
        databaseLimit: servers.databaseLimit,
        allocationLimit: servers.allocationLimit,
        allocationId: servers.allocationId,
        ownerId: users.id,
        ownerFirst: users.nameFirst,
        ownerLast: users.nameLast,
        ownerEmail: users.email,
        nodeId: nodes.id,
        nodeName: nodes.name,
        nodeFqdn: nodes.fqdn,
        eggId: eggs.id,
        eggName: eggs.name,
        eggImages: eggs.dockerImages,
      })
      .from(servers)
      .innerJoin(users, eq(servers.ownerId, users.id))
      .innerJoin(nodes, eq(servers.nodeId, nodes.id))
      .innerJoin(eggs, eq(servers.eggId, eggs.id))
      .where(eq(servers.id, serverId))
      .limit(1);

    if (!row) throw new NotFoundException("Serveur introuvable.");

    const variables = await this.variablesOf(serverId);
    const ports = await this.db
      .select({ id: allocations.id, ip: allocations.ip, port: allocations.port })
      .from(allocations)
      .where(eq(allocations.serverId, serverId));

    const environment = Object.fromEntries(variables.map((v) => [v.envVariable, v.value]));
    // Les variables que le panel calcule : l'egg ne peut pas les connaître,
    // elles dépendent du plan et de l'allocation de ce serveur précis.
    const defaultPort = ports.find((p) => p.id === row.allocationId) ?? ports[0];
    environment.SERVER_MEMORY = String(row.memoryMb);
    environment.SERVER_IP = defaultPort?.ip ?? "";
    environment.SERVER_PORT = String(defaultPort?.port ?? "");

    return {
      id: row.id,
      shortId: row.shortId,
      name: row.name,
      description: row.description,
      state: row.state,
      owner: {
        id: row.ownerId,
        name: `${row.ownerFirst} ${row.ownerLast}`,
        email: row.ownerEmail,
      },
      node: { id: row.nodeId, name: row.nodeName, fqdn: row.nodeFqdn },
      egg: {
        id: row.eggId,
        name: row.eggName,
        images: (row.eggImages ?? {}) as Record<string, string>,
      },
      dockerImage: row.dockerImage,
      startup: row.startup,
      resolvedStartup: resolveTemplate(row.startup, environment),
      unresolvedPlaceholders: unresolvedIn(row.startup, environment),
      resources: {
        memoryMb: row.memoryMb,
        swapMb: row.swapMb,
        diskMb: row.diskMb,
        cpuPct: row.cpuPct,
        ioWeight: row.ioWeight,
        threads: row.threads,
        oomKiller: row.oomKiller,
      },
      limits: {
        backups: row.backupLimit,
        databases: row.databaseLimit,
        allocations: row.allocationLimit,
      },
      variables,
      ports: ports.map((p) => ({ ...p, isDefault: p.id === row.allocationId })),
    };
  }

  /**
   * Change l'image de conteneur et la commande de démarrage.
   *
   * Le daemon est **prévenu**, et ce n'est pas optionnel : Wings ne relit la
   * configuration qu'au démarrage et sur cet appel. Sans lui, le panel
   * afficherait la nouvelle image pendant que le conteneur continuerait de
   * tourner sur l'ancienne — un écart qui ne se découvre qu'au prochain
   * redémarrage, longtemps après qu'on ait oublié le changement.
   */
  /**
   * Change le propriétaire d'un serveur.
   *
   * La fiche d'administration laissait déjà modifier l'exécution, les
   * variables, les ressources et la machine — mais pas **à qui** le serveur
   * appartient. Un compte fusionné, une reprise d'activité, un client qui
   * rachète le serveur d'un autre : il fallait passer par la base.
   *
   * Trois choses ne bougent pas, et chacune pour une raison :
   *
   * - **le rattachement au revendeur** reste, parce qu'il dit *qui héberge*,
   *   pas *qui possède*. Le déplacer ferait changer de parc un serveur qui
   *   n'a pas déménagé, et fausserait l'enveloppe des deux revendeurs d'un
   *   coup ;
   * - **les sous-utilisateurs** restent : ce sont des invitations à ce
   *   serveur, pas au compte. Les effacer priverait une équipe de son accès
   *   sans que personne l'ait demandé ;
   * - **l'identifiant court**, évidemment : c'est le nom du serveur pour le
   *   daemon et pour tous les journaux déjà écrits.
   */
  async setOwner(serverId: string, ownerId: string): Promise<void> {
    /*
     * Deux identifiants contrôlés avant d'atteindre la base : PostgreSQL
     * refusait la conversion d'une valeur illisible en UUID, et le refus
     * devenait une erreur 500. Illisible veut dire inconnu, et se dit comme
     * tel.
     */
    if (!isUuid(ownerId)) {
      throw new BadRequestException("Compte destinataire inconnu.");
    }
    if (!isUuid(serverId)) throw new NotFoundException("Serveur introuvable.");

    const [cible] = await this.db
      .select({ id: users.id, role: users.role, access: users.platformAccess })
      .from(users)
      .where(eq(users.id, ownerId))
      .limit(1);

    if (!cible) throw new BadRequestException("Compte destinataire inconnu.");

    /*
     * Un revendeur qui n'accorde pas le provisionnement ne se voit pas imposer
     * un serveur.
     *
     * Même raison qu'à la création : il loue son propre matériel et répond de
     * ce qui y tourne. Lui transférer un serveur reviendrait à engager sa
     * responsabilité à sa place — et c'est exactement ce que son réglage
     * refuse.
     */
    if (cible.role === "reseller" && !platformMayProvision(platformAccessOf(cible.access))) {
      throw new BadRequestException(
        "Ce revendeur n'autorise pas la plateforme à disposer de son compte. Il peut l'ouvrir depuis ses réglages.",
      );
    }

    const [avant] = await this.db
      .select({ ownerId: servers.ownerId })
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);

    const [updated] = await this.db
      .update(servers)
      .set({ ownerId, updatedAt: new Date().toISOString() })
      .where(eq(servers.id, serverId))
      .returning({ id: servers.id });

    if (!updated) throw new NotFoundException("Serveur introuvable.");

    /*
     * La configuration du daemon n'a rien à apprendre ici : la propriété est
     * une notion du panel, et Wings ne connaît qu'un identifiant de serveur,
     * un conteneur et des limites.
     *
     * **Ses jetons de console, si.** Celui de l'ancien propriétaire vit dix
     * minutes et Wings ne revérifie pas qui le porte : sans révocation, il
     * gardait la console d'un serveur qui n'était plus le sien — ce que la
     * suspension et le retrait d'un sous-utilisateur empêchent déjà. Ceux des
     * sous-utilisateurs restent : ils sont toujours invités.
     *
     * Un node injoignable n'annule pas le transfert : la base fait foi, et le
     * jeton expire de lui-même.
     */
    if (avant && avant.ownerId !== ownerId) {
      const jtis = this.tokens.revocableFor(serverId, avant.ownerId);
      await this.wings.denyWebsocketTokens(serverId, jtis).catch(() => undefined);
    }
  }

  /**
   * Change le jeu d'un serveur, sans le détruire.
   *
   * **Ce qui n'existait pas.** Passer de Paper à Forge, ou de Minecraft à
   * Rust, demandait jusqu'ici de supprimer le serveur et d'en recréer un : le
   * client perdait son identifiant court, ses sous-utilisateurs, ses
   * planifications, ses clés SFTP et son historique — et l'hébergeur voyait
   * passer une résiliation suivie d'une commande dans sa comptabilité. Tout
   * cela pour changer un jar.
   *
   * Ce que le changement emporte, et qui est dit avant de cliquer :
   *
   * - **les variables** de l'ancien egg sont retirées et remplacées par celles
   *   du nouveau, à leurs valeurs par défaut. Les garder écrirait des lignes
   *   que plus rien ne relit, et en laisserait manquer d'autres — un conteneur
   *   à l'environnement incomplet ;
   * - **la commande de démarrage et l'image** repassent à celles du nouvel
   *   egg. Une commande taillée à la main pour l'ancien jeu n'a aucun sens
   *   pour le nouveau, et la reconduire donnerait un conteneur qui ne démarre
   *   pas sans qu'on sache pourquoi ;
   * - **les fichiers du volume restent.** C'est délibéré : ils appartiennent
   *   au client, et c'est la réinstallation — demandée à part — qui fait
   *   tourner le script du nouvel egg par-dessus.
   *
   * La réinstallation est le point important. Sans elle, le serveur porte le
   * nom d'un jeu dont aucun fichier n'est présent. Avec elle, c'est le script
   * de l'egg qui fabrique le serveur dans le conteneur — c'est par ce chemin
   * que **Forge et NeoForge** deviennent installables, eux qui ne distribuent
   * qu'un installeur et non un serveur prêt à poser.
   */
  async setEgg(serverId: string, eggId: string, reinstall: boolean): Promise<void> {
    const [serveur] = await this.db
      .select({ id: servers.id, eggId: servers.eggId, state: servers.state })
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);

    if (!serveur) throw new NotFoundException("Serveur introuvable.");

    /*
     * Un serveur occupé ne change pas de jeu.
     *
     * Même règle que la réinstallation, et pour la même raison : pendant une
     * installation, une restauration ou un transfert, le daemon écrit dans le
     * volume. Changer l'egg sous lui donnerait un serveur à moitié de chaque.
     * L'installation échouée fait exception — c'est précisément l'état d'où
     * l'on veut pouvoir repartir sur un autre jeu.
     */
    const bloc = serverBlock(serveur.state);
    if (reinstallBlocked(serveur.state) && bloc) {
      throw new BadRequestException(`${bloc.label} : ${bloc.body}`);
    }

    if (serveur.eggId === eggId) {
      throw new BadRequestException("Ce serveur tourne déjà sur ce jeu.");
    }

    const nouveau = await this.eggFor(eggId);

    await this.db.transaction(async (tx) => {
      // Les valeurs de l'ancien egg partent d'abord : la contrainte d'unicité
      // porte sur (serveur, variable d'egg), et deux eggs peuvent déclarer le
      // même `envVariable` sans que ce soit la même variable.
      await tx.delete(serverVariables).where(eq(serverVariables.serverId, serverId));

      const declarees = await tx
        .select({ id: eggVariables.id, defaultValue: eggVariables.defaultValue })
        .from(eggVariables)
        .where(eq(eggVariables.eggId, eggId));

      if (declarees.length > 0) {
        await tx.insert(serverVariables).values(
          declarees.map((variable) => ({
            serverId,
            eggVariableId: variable.id,
            value: variable.defaultValue,
          })),
        );
      }

      await tx
        .update(servers)
        .set({
          eggId: nouveau.id,
          startup: nouveau.startup,
          dockerImage: nouveau.defaultImage,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(servers.id, serverId));
    });

    /*
     * Le daemon apprend le nouvel environnement **avant** qu'on lui demande de
     * réinstaller : il relit la configuration du serveur au début du script,
     * et l'ordre inverse ferait tourner le script du nouvel egg avec les
     * variables de l'ancien.
     *
     * L'échec de la synchronisation n'est donc pas avalé ici, contrairement
     * aux autres écritures de ce service : réinstaller sur un node qui n'a pas
     * reçu le changement produirait un serveur incohérent, et l'erreur doit
     * remonter à l'écran plutôt que d'attendre le prochain démarrage.
     */
    if (reinstall) {
      await this.wings.syncServer(serverId);
      await this.wings.reinstallServer(serverId);
      return;
    }

    await this.wings.syncServer(serverId).catch(() => undefined);
  }

  async setRuntime(
    serverId: string,
    input: { dockerImage?: string; startup?: string; oomKiller?: boolean },
  ): Promise<void> {
    const patch: Record<string, unknown> = {};

    /*
     * Le tueur de mémoire vit ici, et non dans l'espace client.
     *
     * Le désactiver laisse un conteneur consommer au-delà de sa limite sans
     * jamais être arrêté : ce n'est pas un confort de jeu, c'est une décision
     * qui engage la machine entière et donc les voisins du serveur. Elle
     * revient à l'hébergeur, qui en répond.
     */
    if (input.oomKiller !== undefined) patch.oomKiller = input.oomKiller;

    if (input.dockerImage !== undefined) {
      const image = input.dockerImage.trim();
      if (image === "")
        throw new BadRequestException("L'image de conteneur ne peut pas être vide.");
      patch.dockerImage = image;
    }

    if (input.startup !== undefined) {
      const startup = input.startup.trim();
      if (startup === "")
        throw new BadRequestException("La commande de démarrage ne peut pas être vide.");
      patch.startup = startup;
    }

    if (Object.keys(patch).length === 0) return;

    const [updated] = await this.db
      .update(servers)
      .set({ ...patch, updatedAt: new Date().toISOString() })
      .where(eq(servers.id, serverId))
      .returning({ id: servers.id });

    if (!updated) throw new NotFoundException("Serveur introuvable.");

    // Sans attendre l'issue : un node injoignable ne doit pas empêcher
    // d'enregistrer le changement, qu'il relira à son prochain démarrage.
    await this.wings.syncServer(serverId).catch(() => undefined);
  }

  /**
   * Écrit une variable d'egg, **y compris celles fermées au propriétaire**.
   *
   * C'est la différence avec l'espace client, et elle est voulue : `userEditable`
   * borne ce qu'un client peut changer, pas ce que l'hébergeur peut réparer.
   * Une variable inconnue de l'egg est refusée — l'accepter écrirait une ligne
   * que rien ne relira jamais.
   */
  async setVariable(serverId: string, envVariable: string, value: string): Promise<void> {
    const [variable] = await this.db
      .select({ id: eggVariables.id })
      .from(eggVariables)
      .innerJoin(servers, eq(servers.eggId, eggVariables.eggId))
      .where(and(eq(servers.id, serverId), eq(eggVariables.envVariable, envVariable)))
      .limit(1);

    if (!variable) {
      throw new BadRequestException(`L'egg de ce serveur ne déclare pas « ${envVariable} ».`);
    }

    await this.db
      .insert(serverVariables)
      .values({ serverId, eggVariableId: variable.id, value })
      .onConflictDoUpdate({
        target: [serverVariables.serverId, serverVariables.eggVariableId],
        set: { value, updatedAt: new Date().toISOString() },
      });

    await this.wings.syncServer(serverId).catch(() => undefined);
  }

  /**
   * L'egg, tel que la création le lit — mêmes règles, à dessein.
   *
   * Un egg désactivé est traité comme inexistant : il n'a pas été relu par un
   * administrateur, et son script d'installation non plus. Le déclarer
   * disponible au changement mais pas à la création ouvrirait une seconde
   * porte sur le même script, moins gardée que la première.
   */
  private async eggFor(eggId: string) {
    const [row] = await this.db
      .select({
        id: eggs.id,
        startup: eggs.startup,
        dockerImages: eggs.dockerImages,
        enabled: eggs.enabled,
      })
      .from(eggs)
      .where(eq(eggs.id, eggId))
      .limit(1);

    if (!row?.enabled) throw new BadRequestException("Jeu indisponible.");

    // Le format Pterodactyl est `{ "Java 21": "ghcr.io/..." }` : l'ordre des
    // clés porte l'intention de l'auteur, la première est sa recommandation.
    const images = Object.values((row.dockerImages ?? {}) as Record<string, string>);
    const defaultImage = images[0];
    if (!defaultImage) throw new BadRequestException("Ce jeu n'a pas d'image Docker configurée.");

    return { id: row.id, startup: row.startup, defaultImage };
  }

  private async variablesOf(serverId: string): Promise<AdminServerVariable[]> {
    const declared = await this.db
      .select({
        id: eggVariables.id,
        name: eggVariables.name,
        envVariable: eggVariables.envVariable,
        description: eggVariables.description,
        defaultValue: eggVariables.defaultValue,
        rules: eggVariables.rules,
        userViewable: eggVariables.userViewable,
        userEditable: eggVariables.userEditable,
      })
      .from(eggVariables)
      .innerJoin(servers, eq(servers.eggId, eggVariables.eggId))
      .where(eq(servers.id, serverId));

    const set = await this.db
      .select({ eggVariableId: serverVariables.eggVariableId, value: serverVariables.value })
      .from(serverVariables)
      .where(eq(serverVariables.serverId, serverId));

    const values = new Map(set.map((v) => [v.eggVariableId, v.value]));

    return declared.map((variable) => ({
      name: variable.name,
      envVariable: variable.envVariable,
      description: variable.description,
      // La valeur du serveur si elle existe, la valeur par défaut sinon :
      // c'est ce que le daemon recevra, et donc ce qu'il faut montrer.
      value: values.get(variable.id) ?? variable.defaultValue,
      defaultValue: variable.defaultValue,
      rules: variable.rules,
      userViewable: variable.userViewable,
      userEditable: variable.userEditable,
    }));
  }
}

/**
 * Remplace les gabarits `{{NOM}}` par leur valeur.
 *
 * Même règle que Wings, y compris pour l'absence : un gabarit sans valeur
 * devient **vide**, il ne reste pas tel quel. C'est précisément ce qui produit
 * `java -jar` sans rien derrière, et c'est pour le rendre visible que cette
 * fonction reproduit le comportement du daemon plutôt qu'un affichage flatteur.
 */
export function resolveTemplate(template: string, environment: Record<string, string>): string {
  return template.replace(
    /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g,
    (_, name: string) => environment[name] ?? "",
  );
}

/** Les gabarits qu'aucune variable ne renseigne, pour pouvoir les nommer. */
export function unresolvedIn(template: string, environment: Record<string, string>): string[] {
  const found = template.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g);
  const missing = new Set<string>();
  for (const match of found) {
    const name = match[1];
    if (name && (environment[name] ?? "") === "") missing.add(name);
  }
  return [...missing];
}
