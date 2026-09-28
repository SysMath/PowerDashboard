import { validateVariableValue } from "@gamedashboard/contracts";
import {
  allocations,
  type Database,
  eggs,
  eggVariables,
  nodes,
  servers,
  serverVariables,
} from "@gamedashboard/db";
import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { DATABASE } from "../../common/database.provider";
import { PlatformSettingsService } from "../admin/platform-settings.service";
import { WingsClientService } from "../wings/wings-client.service";

export interface StartupVariable {
  envVariable: string;
  name: string;
  description: string | null;
  value: string;
  defaultValue: string;
  isEditable: boolean;
  /** Contraintes de l'egg, affichées telles quelles : `required|string|max:20`. */
  rules: string;
}

export interface ServerSettings {
  id: string;
  shortId: string;
  name: string;
  description: string | null;
  eggName: string;
  dockerImage: string;
  /** Images déclarées par l'egg, étiquette vers adresse. */
  eggImages: Record<string, string>;
  nodeName: string;
  memoryMb: number;
  diskMb: number;
  cpuPct: number;
  swapMb: number;
  address: string;
  /** Coordonnées SFTP du node. Voir `sftpIsOpen`. */
  sftpHost: string;
  sftpPort: number;
  sftpUsername: string;
  /**
   * Vrai quand le panel répond aux demandes d'authentification du daemon.
   *
   * Le champ reste, bien qu'il vaille aujourd'hui toujours vrai : c'est lui
   * qui a dit pendant des mois que ces identifiants seraient refusés, et
   * l'écran continue de s'y fier plutôt que de le supposer. Le supprimer
   * ferait afficher des identifiants sans condition le jour où le SFTP est
   * coupé — ce qui est précisément le cas qu'il sert à couvrir.
   */
  sftpIsOpen: boolean;
  /**
   * Faux quand l'annuaire est obligatoire : le SFTP n'accepte alors que les
   * clés SSH (`SftpAuthService`). Le protocole ne sait rendre qu'un échec
   * d'authentification ; c'est cet écran qui dit pourquoi.
   */
  sftpPasswordAccepted: boolean;
  variables: StartupVariable[];
}

/** Port SFTP du daemon. Fixe dans Wings, et non configurable par serveur. */
const SFTP_PORT = 2022;

@Injectable()
export class ServerSettingsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(WingsClientService) private readonly wings: WingsClientService,
    @Inject(PlatformSettingsService) private readonly platform: PlatformSettingsService,
  ) {}

  /**
   * Paramètres d'un serveur.
   *
   * Les variables non visibles par le client sont **écartées par la requête**,
   * et non filtrées après coup : elles contiennent les mots de passe RCON et
   * les clés d'API des eggs, et un filtre appliqué plus tard est un filtre
   * qu'on peut oublier de réappliquer quand le code change.
   */
  async get(serverId: string, viewerEmail: string): Promise<ServerSettings> {
    const [row] = await this.db
      .select({
        id: servers.id,
        shortId: servers.uuidShort,
        name: servers.name,
        description: servers.description,
        dockerImage: servers.dockerImage,
        memoryMb: servers.memoryMb,
        diskMb: servers.diskMb,
        cpuPct: servers.cpuPct,
        swapMb: servers.swapMb,
        eggName: eggs.name,
        eggImages: eggs.dockerImages,
        nodeName: nodes.name,
        nodeFqdn: nodes.fqdn,
        ip: allocations.ip,
        ipAlias: allocations.ipAlias,
        port: allocations.port,
      })
      .from(servers)
      .innerJoin(eggs, eq(servers.eggId, eggs.id))
      .innerJoin(nodes, eq(servers.nodeId, nodes.id))
      .innerJoin(allocations, eq(servers.allocationId, allocations.id))
      .where(eq(servers.id, serverId))
      .limit(1);

    if (!row) throw new NotFoundException("Serveur introuvable.");

    const variables = await this.db
      .select({
        envVariable: eggVariables.envVariable,
        name: eggVariables.name,
        description: eggVariables.description,
        defaultValue: eggVariables.defaultValue,
        isEditable: eggVariables.userEditable,
        rules: eggVariables.rules,
        value: serverVariables.value,
      })
      .from(eggVariables)
      .leftJoin(
        serverVariables,
        and(
          eq(serverVariables.eggVariableId, eggVariables.id),
          eq(serverVariables.serverId, serverId),
        ),
      )
      .innerJoin(eggs, eq(eggVariables.eggId, eggs.id))
      .innerJoin(servers, eq(servers.eggId, eggs.id))
      .where(and(eq(servers.id, serverId), eq(eggVariables.userViewable, true)))
      .orderBy(asc(eggVariables.name));

    return {
      id: row.id,
      shortId: row.shortId,
      name: row.name,
      description: row.description,
      eggName: row.eggName,
      dockerImage: row.dockerImage,
      // Le client choisit **dans** ce que l'egg déclare, jamais librement :
      // une image arbitraire sortirait du catalogue éprouvé par son auteur.
      eggImages: (row.eggImages ?? {}) as Record<string, string>,
      nodeName: row.nodeName,
      memoryMb: row.memoryMb,
      diskMb: row.diskMb,
      cpuPct: row.cpuPct,
      swapMb: row.swapMb,
      address: `${row.ipAlias ?? row.ip}:${row.port}`,
      sftpHost: row.nodeFqdn,
      sftpPort: SFTP_PORT,
      // Forme imposée par Wings : `<compte>.<identifiant court du serveur>`.
      //
      // L'adresse est celle de **qui regarde**, jamais celle du propriétaire :
      // un sous-utilisateur se connecte avec son propre compte, et lui montrer
      // l'adresse du propriétaire le ferait essayer un identifiant qui n'est
      // pas le sien — puis conclure que le SFTP ne marche pas.
      sftpUsername: `${viewerEmail}.${row.shortId}`,
      sftpIsOpen: true,
      sftpPasswordAccepted: (await this.platform.ssoConfiguration()) === null,
      variables: variables.map((v) => ({
        envVariable: v.envVariable,
        name: v.name,
        description: v.description,
        // La valeur du serveur l'emporte ; à défaut, celle de l'egg. `??` et
        // non `||` : une variable volontairement vide est une valeur, pas une
        // absence, et la remplacer par le défaut réactiverait un réglage que
        // quelqu'un avait désactivé.
        value: v.value ?? v.defaultValue,
        defaultValue: v.defaultValue,
        isEditable: v.isEditable,
        rules: v.rules,
      })),
    };
  }

  /** Renomme. Sans effet sur le serveur de jeu, mais le daemon tient ce nom. */
  async rename(serverId: string, name: string, description: string | null): Promise<void> {
    const trimmed = name.trim();
    if (trimmed === "") throw new BadRequestException("Le nom ne peut pas être vide.");
    if (trimmed.length > 120) throw new BadRequestException("Nom trop long (120 caractères).");

    await this.db
      .update(servers)
      .set({ name: trimmed, description, updatedAt: new Date().toISOString() })
      .where(eq(servers.id, serverId));

    await this.sync(serverId);
  }

  /**
   * Écrit les variables de démarrage.
   *
   * Une variable non éditable est **refusée**, pas ignorée : le client qui la
   * soumet a soit contourné l'interface, soit rencontré un défaut, et dans les
   * deux cas il doit l'apprendre. L'ignorer en silence laisserait croire que la
   * valeur a été prise en compte.
   *
   * La liste des variables autorisées vient de l'egg, jamais du corps de la
   * requête : sinon n'importe quelle variable d'environnement pourrait être
   * injectée dans le conteneur.
   */
  async setVariables(serverId: string, values: Record<string, string>): Promise<void> {
    const allowed = await this.db
      .select({
        id: eggVariables.id,
        envVariable: eggVariables.envVariable,
        isEditable: eggVariables.userEditable,
        rules: eggVariables.rules,
      })
      .from(eggVariables)
      .innerJoin(eggs, eq(eggVariables.eggId, eggs.id))
      .innerJoin(servers, eq(servers.eggId, eggs.id))
      .where(eq(servers.id, serverId));

    const byName = new Map(allowed.map((v) => [v.envVariable, v]));

    for (const [envVariable, value] of Object.entries(values)) {
      const variable = byName.get(envVariable);
      if (!variable) {
        throw new BadRequestException(`Variable « ${envVariable} » inconnue pour ce serveur.`);
      }
      if (!variable.isEditable) {
        throw new BadRequestException(`Variable « ${envVariable} » non modifiable.`);
      }
      if (typeof value !== "string") {
        throw new BadRequestException(`Valeur invalide pour « ${envVariable} ».`);
      }
      /*
       * Les règles de l'egg s'appliquent ici, pas seulement à l'écran : la
       * valeur part dans l'environnement du conteneur et dans la commande de
       * démarrage, où `{{VAR}}` est substitué tel quel. Sans ce contrôle, un
       * accès `startup.update` vaut une commande arbitraire au lancement.
       */
      const problem = validateVariableValue(variable.rules, value);
      if (problem !== null) {
        throw new BadRequestException(`Valeur refusée pour « ${envVariable} » : ${problem}.`);
      }

      await this.db
        .insert(serverVariables)
        .values({ serverId, eggVariableId: variable.id, value })
        .onConflictDoUpdate({
          target: [serverVariables.serverId, serverVariables.eggVariableId],
          set: { value, updatedAt: new Date().toISOString() },
        });
    }

    await this.sync(serverId);
  }

  /**
   * Change l'image de conteneur, **parmi celles que l'egg déclare**.
   *
   * Liste fermée, contrairement à la fiche d'administration où le champ est
   * libre. Un client qui choisirait une image arbitraire sortirait du
   * catalogue éprouvé par l'auteur de l'egg, et ferait tirer au daemon une
   * adresse que personne n'a vérifiée.
   *
   * La vérification porte sur les **valeurs** et non sur les étiquettes : deux
   * eggs peuvent nommer « Java 21 » des images différentes, et c'est l'adresse
   * qui part au daemon.
   */
  async setDockerImage(serverId: string, image: string): Promise<void> {
    const [row] = await this.db
      .select({ images: eggs.dockerImages })
      .from(servers)
      .innerJoin(eggs, eq(servers.eggId, eggs.id))
      .where(eq(servers.id, serverId))
      .limit(1);

    const declared = Object.values((row?.images ?? {}) as Record<string, string>);
    if (!declared.includes(image)) {
      throw new BadRequestException(
        "Cette image ne figure pas parmi celles que l'egg de ce serveur déclare.",
      );
    }

    await this.db
      .update(servers)
      .set({ dockerImage: image, updatedAt: new Date().toISOString() })
      .where(eq(servers.id, serverId));

    await this.sync(serverId);
  }

  /**
   * Prévient le daemon d'un changement de configuration.
   *
   * L'échec n'annule rien : la base fait foi, et le daemon relit sa
   * configuration au démarrage suivant. Remonter l'erreur ferait croire que le
   * renommage n'a pas eu lieu, alors qu'il est bien enregistré.
   */
  private async sync(serverId: string): Promise<void> {
    await this.wings.syncServer(serverId).catch(() => undefined);
  }
}
