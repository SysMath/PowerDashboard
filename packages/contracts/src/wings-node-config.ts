/**
 * Configuration d'un node, telle que `wings configure` vient la chercher.
 *
 * Wings n'est pas modifié : c'est donc lui qui impose la forme, et ce fichier
 * ne fait que s'y conformer. Le contrat est relevé dans sa source
 * (`cmd/configure.go` et `config/config.go`), et non deviné :
 *
 *     GET {panel}/api/application/nodes/{node}/configuration
 *     Accept:        application/vnd.pterodactyl.v1+json
 *     Authorization: Bearer <clé applicative>
 *
 * La réponse est le **JSON nu** de la configuration, sans enveloppe `data`.
 * Wings part de ses propres valeurs par défaut puis désérialise cette réponse
 * par-dessus : tout ce qu'on n'envoie pas reste au choix de l'exploitant de la
 * machine, ce qui est exactement le bon partage. Le panel ne décide ni des
 * chemins, ni de l'utilisateur système, ni du fuseau horaire.
 *
 * Deux pièges relevés dans la source, qui ne se devinent pas :
 *
 * 1. **`--node` doit être passé en option.** L'invite interactive n'accepte
 *    qu'un entier décimal (`^(\d+)$`), héritage des identifiants numériques de
 *    Pterodactyl. Nos nodes sont des UUID. L'option, elle, n'est pas validée :
 *    `wings configure --node <uuid>` passe, l'invite non.
 * 2. **Plusieurs clés envoyées sont inertes.** `system.data`, `allowed_mounts`
 *    et `remote` portent `json:"-"` côté Wings : il ne les lit jamais depuis
 *    cette réponse. On les émet quand même, parce que c'est ce que Pterodactyl
 *    émet et que les outils et la documentation existants s'y attendent — mais
 *    changer leur valeur ici ne produira aucun effet sur le daemon.
 */

/**
 * Préfixe imposé par Wings, sans `v1`.
 *
 * Ce n'est pas notre API applicative (`/api/v1/application`) : c'est un chemin
 * codé en dur dans le daemon. Le distinguer par une constante évite qu'on
 * « harmonise » un jour les deux, ce qui rendrait `wings configure` muet.
 */
export const WINGS_CONFIGURE_PREFIX = "/api/application";

/** Entête que Wings envoie, et que le panel doit accepter. */
export const WINGS_CONFIGURE_ACCEPT = "application/vnd.pterodactyl.v1+json";

export function wingsNodeConfigurationPath(nodeId: string): string {
  return `${WINGS_CONFIGURE_PREFIX}/nodes/${nodeId}/configuration`;
}

export interface WingsNodeConfiguration {
  debug: boolean;
  /**
   * Nom que Wings emploie pour ses conteneurs et ses journaux.
   *
   * Celui de la plateforme, pas « Pterodactyl » : un exploitant qui lit
   * `docker ps` sur sa machine doit y reconnaître le panel qui la pilote.
   */
  app_name: string;
  uuid: string;
  token_id: string;
  token: string;
  api: {
    host: string;
    port: number;
    ssl: { enabled: boolean; cert: string; key: string };
    upload_limit: number;
  };
  system: { data: string; sftp: { bind_port: number } };
  allowed_mounts: string[];
  remote: string;
}

export interface WingsNodeConfigurationInput {
  id: string;
  fqdn: string;
  scheme: string;
  daemonPort: number;
  daemonSftpPort: number;
  tokenId: string;
  token: string;
  panelOrigin: string;
  /** Marque de la plateforme. Vide retombe sur le nom du produit. */
  appName?: string;
}

/**
 * Racine des certificats Let's Encrypt, telle que `certbot` les dépose.
 *
 * Le panel ne peut pas savoir où l'exploitant range ses certificats ; il
 * propose la disposition la plus répandue, que Wings relira au démarrage.
 * Toute autre disposition se corrige dans le `config.yml` du daemon, qui est
 * sa machine et sa décision.
 */
const LETSENCRYPT = "/etc/letsencrypt/live";

/**
 * Limite d'envoi de fichiers, en mégaoctets.
 *
 * La valeur par défaut de Wings. Elle n'est pas stockée par node : la rendre
 * réglable demanderait une colonne, un champ de formulaire et une migration
 * pour un réglage que personne n'a encore eu besoin de changer.
 */
const UPLOAD_LIMIT_MB = 100;

export function buildWingsNodeConfiguration(
  node: WingsNodeConfigurationInput,
): WingsNodeConfiguration {
  const secure = node.scheme === "https";

  return {
    // Le mode verbeux est une décision d'exploitation, prise sur la machine.
    // L'imposer depuis le panel écraserait un diagnostic en cours.
    debug: false,
    app_name: node.appName?.trim() || "GameDashboard",
    uuid: node.id,
    token_id: node.tokenId,
    token: node.token,
    api: {
      // Wings écoute sur toutes les interfaces : c'est le pare-feu de la
      // machine qui restreint, pas une adresse de liaison que le panel devine.
      host: "0.0.0.0",
      port: node.daemonPort,
      ssl: {
        enabled: secure,
        cert: secure ? `${LETSENCRYPT}/${node.fqdn}/fullchain.pem` : "",
        key: secure ? `${LETSENCRYPT}/${node.fqdn}/privkey.pem` : "",
      },
      upload_limit: UPLOAD_LIMIT_MB,
    },
    system: {
      // Inerte côté Wings (`json:"-"`), émis pour la parité. Voir l'en-tête.
      data: "/var/lib/pterodactyl/volumes",
      sftp: { bind_port: node.daemonSftpPort },
    },
    // Inertes également. Les montages autorisés se déclarent dans le
    // `config.yml` du daemon : c'est l'exploitant de la machine qui décide
    // quels répertoires de l'hôte un conteneur peut voir, pas le panel.
    allowed_mounts: [],
    remote: node.panelOrigin,
  };
}

/** L'origine sans ses barres finales, en temps linéaire (pas de regex `\/+$`). */
function sansBarresFinales(origine: string): string {
  let fin = origine.length;
  while (fin > 0 && origine[fin - 1] === "/") fin--;
  return origine.slice(0, fin);
}

/**
 * La ligne de commande à recopier sur la machine.
 *
 * Le jeton demandé est une **clé applicative**, pas le jeton du daemon : c'est
 * la clé qui autorise à venir chercher la configuration, et le jeton du daemon
 * est ce qu'on y trouve. Les confondre ferait recopier à la main le secret
 * qu'on cherchait justement à ne plus manipuler.
 */
export function wingsConfigureCommand(input: {
  panelOrigin: string;
  nodeId: string;
  token?: string;
}): string {
  return [
    "wings configure",
    `--panel-url ${sansBarresFinales(input.panelOrigin)}`,
    `--token ${input.token ?? "<clé applicative>"}`,
    // Toujours en option : l'invite interactive refuse un UUID.
    `--node ${input.nodeId}`,
  ].join(" ");
}
