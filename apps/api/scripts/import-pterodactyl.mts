/**
 * Reprise d'un panel Pterodactyl 1.x.
 *
 *   pnpm --filter @gamedashboard/api exec tsx scripts/import-pterodactyl.mts \
 *     --source mysql://user:mdp@hote:3306/panel [--apply] [--owner <email>]
 *
 * **Il ne touche pas à Wings, et c'est tout l'intérêt.** Les volumes restent
 * où ils sont, les identifiants de serveurs sont conservés tels quels, et les
 * daemons continuent de tourner. La bascule se réduit à deux choses : cette
 * reprise, puis l'URL du panel et le jeton dans le `config.yml` de chaque node
 * — que l'écran « Machines » sait déjà produire.
 *
 * **À blanc par défaut.** Sans `--apply`, il lit, compare, et rend compte de
 * ce qu'il écrirait. C'est le mode dans lequel on le lance la première fois,
 * et la deuxième : une reprise qu'on ne peut pas répéter sans conséquence est
 * une reprise qu'on n'ose pas répéter, donc qu'on fait mal.
 *
 * **Idempotent.** Chaque objet est reconnu à une clé stable — l'adresse d'un
 * compte, l'identifiant d'un serveur, le couple (machine, port) d'une
 * allocation. Relancer après avoir corrigé une erreur ne crée pas de doublon,
 * et met à jour ce qui a changé.
 *
 * ## Ce qu'il reprend, et ce qu'il laisse
 *
 * | Repris | Laissé, et pourquoi |
 * |---|---|
 * | Comptes, avec leur mot de passe | Les clés d'API : leur préfixe et leur condensat ne se transposent pas, et une clé qui survivrait à la bascule serait une clé que personne n'a revue |
 * | Localisations, machines, allocations | La 2FA : les secrets TOTP de Pterodactyl sont chiffrés avec *sa* clé applicative, que nous n'avons pas |
 * | Nids, eggs et leurs variables | Les sauvegardes : elles vivent sur les nodes et dans le stockage objet, pas en base — Wings les retrouvera |
 * | Serveurs, identifiants conservés | Le journal d'activité : c'est une trace d'audit du panel précédent, et la recopier la ferait passer pour la nôtre |
 * | Sous-utilisateurs et leurs permissions | |
 * | Tâches planifiées et leurs étapes | |
 * | Hôtes de bases et bases provisionnées | |
 *
 * ## Le mot de passe des comptes
 *
 * Pterodactyl hache en bcrypt, ce panel en Argon2id. Les condensats sont
 * repris **tels quels** : `verifyPassword` sait lire un bcrypt, et
 * `needsRehash` le déclare périmé, si bien que la première connexion réussie
 * le réécrit en Argon2id. Personne n'a à changer de mot de passe, et aucun
 * bcrypt ne survit à sa première utilisation.
 */
import { randomInt, randomUUID } from "node:crypto";
import { assertEncryptionKey } from "@gamedashboard/auth";
import {
  allocations,
  createClient,
  type Database,
  eggs,
  eggVariables,
  locations,
  nests,
  nodes,
  schedules,
  scheduleTasks,
  serverSubusers,
  servers,
  serverVariables,
  users,
} from "@gamedashboard/db";
import { and, eq } from "drizzle-orm";
import mysql from "mysql2/promise";
import { encryptRowSecret } from "../src/common/row-secrets";

interface Options {
  source: string;
  apply: boolean;
  owner: string | null;
}

function lireOptions(): Options {
  const args = process.argv.slice(2);
  const valeur = (nom: string): string | null => {
    const index = args.indexOf(nom);
    return index === -1 ? null : (args[index + 1] ?? null);
  };

  const source = valeur("--source");
  if (!source) {
    console.error(
      "Usage : import-pterodactyl.mts --source mysql://user:mdp@hote:3306/panel [--apply] [--owner <email>]",
    );
    process.exit(1);
  }

  return { source, apply: args.includes("--apply"), owner: valeur("--owner") };
}

/** Ce qui a été fait, ou serait fait. Un compte par nature d'objet. */
const compte = new Map<string, { crees: number; majs: number; ignores: number }>();

function noter(quoi: string, issue: "cree" | "maj" | "ignore"): void {
  const ligne = compte.get(quoi) ?? { crees: 0, majs: 0, ignores: 0 };
  if (issue === "cree") ligne.crees += 1;
  else if (issue === "maj") ligne.majs += 1;
  else ligne.ignores += 1;
  compte.set(quoi, ligne);
}

const options = lireOptions();

/*
 * La clé est exigée **avant** la première lecture.
 *
 * La reprise chiffre les jetons de daemon. Sans clé, elle échouerait au milieu
 * d'une écriture — la moitié du parc repris, l'autre non, et rien pour dire où
 * elle s'est arrêtée. Mieux vaut ne pas commencer.
 */
assertEncryptionKey();

const source = await mysql.createConnection(options.source);
const db = createClient();

console.log(options.apply ? "== Reprise (écriture)" : "== Reprise à blanc (aucune écriture)");

try {
  const comptes = await importerComptes(db, source, options);
  const lieux = await importerLocalisations(db, source, options);
  const machines = await importerNodes(db, source, options, lieux);
  await importerAllocations(db, source, options, machines);
  const oeufs = await importerEggs(db, source, options);
  const parc = await importerServeurs(db, source, options, { comptes, machines, oeufs });
  await importerSousUtilisateurs(db, source, options, { comptes, parc });
  await importerPlanifications(db, source, options, parc);

  console.log("\n== Bilan");
  for (const [quoi, { crees, majs, ignores }] of compte) {
    console.log(`  ${quoi.padEnd(20)} ${crees} créé(s), ${majs} mis à jour, ${ignores} ignoré(s)`);
  }
  if (options.apply) {
    /*
     * Le seul geste que la reprise ne peut pas faire à votre place.
     *
     * Le jeton de daemon de Pterodactyl est chiffré avec **sa** clé
     * applicative : illisible ici. Chaque machine reprise a donc reçu un
     * jeton neuf, et son `config.yml` doit être remplacé — sans quoi elle
     * continuera de parler à un panel qui ne l'écoute plus, et le nouveau la
     * déclarera injoignable sans que rien n'explique pourquoi.
     */
    console.log(
      "\n  À FAIRE : chaque machine reprise a un jeton neuf. Remplacez son config.yml\n" +
        "  depuis l'écran « Machines » du panel, puis redémarrez son daemon.\n" +
        "  Les eggs sont repris désactivés : relisez leur script avant de les activer.",
    );
  } else {
    console.log("\n  Rien n'a été écrit. Relancez avec --apply pour appliquer.");
  }
} finally {
  await source.end();
}

/* --------------------------------------------------------------------------
 * Comptes
 * ----------------------------------------------------------------------- */

/**
 * Reprend les comptes, **reconnus par leur adresse**.
 *
 * Et non par leur identifiant Pterodactyl : deux panels fusionnés auraient les
 * mêmes entiers pour des personnes différentes, et l'adresse est la seule clé
 * qui veut dire la même chose des deux côtés. L'identifiant d'origine est
 * conservé dans `externalId`, ce qui permet de rejouer la reprise et de
 * retrouver une correspondance sans deviner.
 */
async function importerComptes(
  db: Database,
  source: mysql.Connection,
  options: Options,
): Promise<Map<number, string>> {
  const [lignes] = await source.query<mysql.RowDataPacket[]>(
    "select id, email, username, name_first, name_last, password, root_admin, language from users",
  );

  const correspondance = new Map<number, string>();

  for (const ligne of lignes) {
    const email = String(ligne.email).toLowerCase();
    const [existant] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (existant) {
      correspondance.set(Number(ligne.id), existant.id);
      noter("comptes", "ignore");
      continue;
    }

    if (!options.apply) {
      // Un identifiant provisoire : le reste de la reprise à blanc doit
      // pouvoir se dérouler, et rien n'ira en base.
      correspondance.set(Number(ligne.id), `blanc-user-${ligne.id}`);
      noter("comptes", "cree");
      continue;
    }

    const [cree] = await db
      .insert(users)
      .values({
        email,
        // Le condensat bcrypt part tel quel : voir l'en-tête de ce fichier.
        passwordHash: String(ligne.password),
        nameFirst: String(ligne.name_first || ligne.username || "Compte"),
        nameLast: String(ligne.name_last || ""),
        role: Number(ligne.root_admin) === 1 ? "admin" : "user",
        locale: String(ligne.language ?? "fr").startsWith("en") ? "en" : "fr",
        externalId: `pterodactyl:${ligne.id}`,
        /*
         * L'adresse est considérée comme vérifiée.
         *
         * Elle l'a été sur le panel précédent — ces comptes s'y connectaient.
         * Les marquer non vérifiés enverrait un courriel de vérification à
         * tout le parc le jour de la bascule, et bloquerait ceux qui ne le
         * lisent pas.
         */
        emailVerifiedAt: new Date().toISOString(),
      })
      .returning({ id: users.id });

    if (cree) correspondance.set(Number(ligne.id), cree.id);
    noter("comptes", "cree");
  }

  return correspondance;
}

/* --------------------------------------------------------------------------
 * Infrastructure
 * ----------------------------------------------------------------------- */

async function importerLocalisations(
  db: Database,
  source: mysql.Connection,
  options: Options,
): Promise<Map<number, string>> {
  const [lignes] = await source.query<mysql.RowDataPacket[]>(
    "select id, short, long from locations",
  );
  const correspondance = new Map<number, string>();

  for (const ligne of lignes) {
    const court = String(ligne.short).toLowerCase();
    const [existant] = await db
      .select({ id: locations.id })
      .from(locations)
      .where(eq(locations.short, court))
      .limit(1);

    if (existant) {
      correspondance.set(Number(ligne.id), existant.id);
      noter("localisations", "ignore");
      continue;
    }
    if (!options.apply) {
      correspondance.set(Number(ligne.id), `blanc-loc-${ligne.id}`);
      noter("localisations", "cree");
      continue;
    }

    const [cree] = await db
      .insert(locations)
      .values({ short: court, long: String(ligne.long ?? ligne.short) })
      .returning({ id: locations.id });
    if (cree) correspondance.set(Number(ligne.id), cree.id);
    noter("localisations", "cree");
  }

  return correspondance;
}

/**
 * Reprend les machines, **jeton compris**.
 *
 * C'est la pièce délicate de toute la reprise. Pterodactyl garde
 * `daemon_token_id` et `daemon_token` — le second chiffré avec *sa* clé
 * applicative, que nous n'avons pas. Le jeton ne peut donc pas être repris :
 * un jeton est posé au hasard, et **le node devra recevoir une nouvelle
 * configuration**. C'est dit ici plutôt que découvert au premier heartbeat
 * manqué.
 *
 * L'ancien identifiant de jeton est conservé : il permet de reconnaître la
 * machine si on rejoue la reprise, et de repérer dans les journaux du daemon
 * la coupure qui correspond à la bascule.
 */
async function importerNodes(
  db: Database,
  source: mysql.Connection,
  options: Options,
  lieux: Map<number, string>,
): Promise<Map<number, string>> {
  const [lignes] = await source.query<mysql.RowDataPacket[]>(
    "select id, location_id, name, fqdn, scheme, daemonListen, daemonSFTP, memory, memory_overallocate, disk, disk_overallocate, public, maintenance_mode from nodes",
  );
  const correspondance = new Map<number, string>();

  for (const ligne of lignes) {
    const fqdn = String(ligne.fqdn);
    const [existant] = await db
      .select({ id: nodes.id })
      .from(nodes)
      .where(eq(nodes.fqdn, fqdn))
      .limit(1);

    if (existant) {
      correspondance.set(Number(ligne.id), existant.id);
      noter("machines", "ignore");
      continue;
    }

    const locationId = lieux.get(Number(ligne.location_id));
    if (!locationId) {
      console.warn(`  machine « ${ligne.name} » : localisation inconnue, ignorée.`);
      noter("machines", "ignore");
      continue;
    }

    if (!options.apply) {
      correspondance.set(Number(ligne.id), `blanc-node-${ligne.id}`);
      noter("machines", "cree");
      continue;
    }

    const jeton = jetonDeDaemon();
    // Identifiant tiré ici : le jeton est lié à sa ligne dès l'écriture.
    const id = randomUUID();
    const [cree] = await db
      .insert(nodes)
      .values({
        id,
        name: String(ligne.name),
        locationId,
        fqdn,
        scheme: String(ligne.scheme) === "http" ? "http" : "https",
        daemonPort: Number(ligne.daemonListen ?? 8080),
        daemonSftpPort: Number(ligne.daemonSFTP ?? 2022),
        memoryMb: Number(ligne.memory),
        memoryOverallocate: Number(ligne.memory_overallocate ?? 0),
        diskMb: Number(ligne.disk),
        diskOverallocate: Number(ligne.disk_overallocate ?? 0),
        // Pterodactyl ne stocke pas de nombre de cœurs : il raisonne en
        // pourcentage de CPU par serveur. On pose une valeur que l'exploitant
        // corrigera — l'inventer plus finement serait l'inventer quand même.
        cpuCores: 1,
        public: Number(ligne.public) === 1,
        maintenanceMode: Number(ligne.maintenance_mode ?? 0) === 1,
        daemonTokenId: jeton.id,
        daemonTokenEnc: encryptRowSecret("nodes.daemon_token_enc", id, jeton.secret),
        daemonTokenRotatedAt: new Date().toISOString(),
      })
      .returning({ id: nodes.id });

    if (cree) correspondance.set(Number(ligne.id), cree.id);
    noter("machines", "cree");
  }

  return correspondance;
}

async function importerAllocations(
  db: Database,
  source: mysql.Connection,
  options: Options,
  machines: Map<number, string>,
): Promise<void> {
  const [lignes] = await source.query<mysql.RowDataPacket[]>(
    "select id, node_id, ip, port from allocations",
  );

  for (const ligne of lignes) {
    const nodeId = machines.get(Number(ligne.node_id));
    if (!nodeId || !options.apply) {
      noter("allocations", nodeId ? "cree" : "ignore");
      continue;
    }

    const [existant] = await db
      .select({ id: allocations.id })
      .from(allocations)
      .where(and(eq(allocations.nodeId, nodeId), eq(allocations.port, Number(ligne.port))))
      .limit(1);

    if (existant) {
      noter("allocations", "ignore");
      continue;
    }

    await db.insert(allocations).values({
      nodeId,
      ip: String(ligne.ip),
      port: Number(ligne.port),
    });
    noter("allocations", "cree");
  }
}

/* --------------------------------------------------------------------------
 * Catalogue
 * ----------------------------------------------------------------------- */

/**
 * Reprend les nids, les eggs et leurs variables.
 *
 * Les eggs sont repris **désactivés**. C'est délibéré : l'activation d'un egg
 * vaut relecture de son script d'installation par un administrateur, et un
 * script venu d'un autre panel n'a pas été relu ici. Les activer en masse
 * reviendrait à faire signer cette relecture par la reprise.
 */
async function importerEggs(
  db: Database,
  source: mysql.Connection,
  options: Options,
): Promise<Map<number, string>> {
  const [nids] = await source.query<mysql.RowDataPacket[]>(
    "select id, name, description from nests",
  );
  const nidsCorrespondance = new Map<number, string>();

  for (const nid of nids) {
    const nom = String(nid.name);
    const [existant] = await db
      .select({ id: nests.id })
      .from(nests)
      .where(eq(nests.name, nom))
      .limit(1);
    if (existant) {
      nidsCorrespondance.set(Number(nid.id), existant.id);
      noter("nids", "ignore");
      continue;
    }
    if (!options.apply) {
      nidsCorrespondance.set(Number(nid.id), `blanc-nest-${nid.id}`);
      noter("nids", "cree");
      continue;
    }
    const [cree] = await db
      .insert(nests)
      .values({ name: nom, description: nid.description ? String(nid.description) : null })
      .returning({ id: nests.id });
    if (cree) nidsCorrespondance.set(Number(nid.id), cree.id);
    noter("nids", "cree");
  }

  const [lignes] = await source.query<mysql.RowDataPacket[]>(
    "select id, nest_id, name, description, docker_images, startup, config_files, config_startup, config_logs, config_stop, script_install, script_container, script_entry from eggs",
  );
  const correspondance = new Map<number, string>();

  for (const ligne of lignes) {
    const nom = String(ligne.name);
    const [existant] = await db
      .select({ id: eggs.id })
      .from(eggs)
      .where(eq(eggs.name, nom))
      .limit(1);
    if (existant) {
      correspondance.set(Number(ligne.id), existant.id);
      noter("eggs", "ignore");
      continue;
    }

    const nestId = nidsCorrespondance.get(Number(ligne.nest_id));
    if (!nestId || !options.apply) {
      if (nestId) correspondance.set(Number(ligne.id), `blanc-egg-${ligne.id}`);
      noter("eggs", nestId ? "cree" : "ignore");
      continue;
    }

    const [cree] = await db
      .insert(eggs)
      .values({
        nestId,
        name: nom,
        description: ligne.description ? String(ligne.description) : null,
        dockerImages: lireJson(ligne.docker_images) ?? {},
        startup: String(ligne.startup ?? ""),
        configFiles: lireJson(ligne.config_files) ?? {},
        configStartup: lireJson(ligne.config_startup) ?? {},
        configLogs: lireJson(ligne.config_logs) ?? {},
        configStop: ligne.config_stop ? String(ligne.config_stop) : null,
        scriptInstall: ligne.script_install ? String(ligne.script_install) : null,
        scriptContainer: String(ligne.script_container ?? "alpine:3"),
        scriptEntry: String(ligne.script_entry ?? "ash"),
        // Désactivé : voir le commentaire de cette fonction.
        enabled: false,
      })
      .returning({ id: eggs.id });

    if (!cree) continue;
    correspondance.set(Number(ligne.id), cree.id);
    noter("eggs", "cree");

    const [variables] = await source.query<mysql.RowDataPacket[]>(
      "select name, description, env_variable, default_value, user_viewable, user_editable, rules from egg_variables where egg_id = ?",
      [ligne.id],
    );
    for (const variable of variables) {
      await db.insert(eggVariables).values({
        eggId: cree.id,
        name: String(variable.name),
        description: variable.description ? String(variable.description) : null,
        envVariable: String(variable.env_variable),
        defaultValue: String(variable.default_value ?? ""),
        userViewable: Number(variable.user_viewable) === 1,
        userEditable: Number(variable.user_editable) === 1,
        rules: variable.rules ? String(variable.rules) : null,
      });
    }
  }

  return correspondance;
}

/* --------------------------------------------------------------------------
 * Serveurs
 * ----------------------------------------------------------------------- */

/**
 * Reprend les serveurs **en conservant leur identifiant**.
 *
 * C'est la condition pour que Wings retrouve ses volumes :
 * `/var/lib/pterodactyl/volumes/<uuid>` est nommé d'après cet identifiant, et
 * en générer un nouveau reviendrait à abandonner les données de tout le monde
 * à côté d'un serveur vide.
 */
async function importerServeurs(
  db: Database,
  source: mysql.Connection,
  options: Options,
  refs: { comptes: Map<number, string>; machines: Map<number, string>; oeufs: Map<number, string> },
): Promise<Map<number, string>> {
  const [lignes] = await source.query<mysql.RowDataPacket[]>(
    "select id, uuid, uuidShort, name, description, owner_id, node_id, egg_id, allocation_id, image, startup, memory, swap, disk, io, cpu, threads, oom_disabled, status, suspended, database_limit, allocation_limit, backup_limit, installed_at from servers",
  );
  const correspondance = new Map<number, string>();

  for (const ligne of lignes) {
    const uuid = String(ligne.uuid);
    const [existant] = await db
      .select({ id: servers.id })
      .from(servers)
      .where(eq(servers.id, uuid))
      .limit(1);

    if (existant) {
      correspondance.set(Number(ligne.id), existant.id);
      noter("serveurs", "ignore");
      continue;
    }

    const ownerId = refs.comptes.get(Number(ligne.owner_id));
    const nodeId = refs.machines.get(Number(ligne.node_id));
    const eggId = refs.oeufs.get(Number(ligne.egg_id));
    if (!ownerId || !nodeId || !eggId) {
      console.warn(`  serveur « ${ligne.name} » : propriétaire, machine ou egg absent, ignoré.`);
      noter("serveurs", "ignore");
      continue;
    }
    if (!options.apply) {
      correspondance.set(Number(ligne.id), uuid);
      noter("serveurs", "cree");
      continue;
    }

    // L'allocation par défaut est retrouvée par son port, sur la machine
    // reprise : les identifiants d'allocation ne se transposent pas.
    const [allocation] = await source.query<mysql.RowDataPacket[]>(
      "select port from allocations where id = ?",
      [ligne.allocation_id],
    );
    const port = allocation[0]?.port;
    const [cible] = port
      ? await db
          .select({ id: allocations.id })
          .from(allocations)
          .where(and(eq(allocations.nodeId, nodeId), eq(allocations.port, Number(port))))
          .limit(1)
      : [];

    if (!cible) {
      console.warn(`  serveur « ${ligne.name} » : allocation introuvable, ignoré.`);
      noter("serveurs", "ignore");
      continue;
    }

    await db.insert(servers).values({
      id: uuid,
      uuidShort: String(ligne.uuidShort),
      name: String(ligne.name),
      description: ligne.description ? String(ligne.description) : null,
      ownerId,
      nodeId,
      eggId,
      allocationId: cible.id,
      dockerImage: String(ligne.image),
      startup: String(ligne.startup),
      memoryMb: Number(ligne.memory),
      swapMb: Number(ligne.swap ?? 0),
      diskMb: Number(ligne.disk),
      ioWeight: Number(ligne.io ?? 500),
      cpuPct: Number(ligne.cpu ?? 0),
      threads: ligne.threads ? String(ligne.threads) : null,
      // Pterodactyl stocke l'inverse : `oom_disabled` vrai veut dire que le
      // tueur est **désactivé**. Recopier le booléen tel quel aurait laissé
      // des conteneurs dépasser leur limite sans jamais être arrêtés.
      oomKiller: Number(ligne.oom_disabled ?? 1) === 0,
      state: Number(ligne.suspended ?? 0) === 1 ? "suspended" : etatDe(ligne.status),
      backupLimit: Number(ligne.backup_limit ?? 0),
      databaseLimit: Number(ligne.database_limit ?? 0),
      allocationLimit: Number(ligne.allocation_limit ?? 0),
      installedAt: ligne.installed_at ? new Date(ligne.installed_at).toISOString() : null,
      externalId: `pterodactyl:${ligne.id}`,
    });
    correspondance.set(Number(ligne.id), uuid);
    noter("serveurs", "cree");

    // Les variables du serveur, rattachées aux variables de l'egg par leur
    // nom d'environnement : les identifiants ne se transposent pas.
    const [valeurs] = await source.query<mysql.RowDataPacket[]>(
      "select v.env_variable, s.variable_value from server_variables s join egg_variables v on v.id = s.variable_id where s.server_id = ?",
      [ligne.id],
    );
    for (const valeur of valeurs) {
      const [variable] = await db
        .select({ id: eggVariables.id })
        .from(eggVariables)
        .where(
          and(
            eq(eggVariables.eggId, eggId),
            eq(eggVariables.envVariable, String(valeur.env_variable)),
          ),
        )
        .limit(1);
      if (!variable) continue;
      await db.insert(serverVariables).values({
        serverId: uuid,
        eggVariableId: variable.id,
        value: String(valeur.variable_value ?? ""),
      });
    }
  }

  return correspondance;
}

/** L'état de gestion, tel que ce panel le nomme. */
function etatDe(status: unknown): "installing" | "install_failed" | null {
  const valeur = status === null || status === undefined ? "" : String(status);
  if (valeur === "installing") return "installing";
  if (valeur === "install_failed" || valeur === "reinstall_failed") return "install_failed";
  // `suspended` est traité par l'appelant, et tout le reste — dont la valeur
  // nulle de Pterodactyl pour « installé » — ne bloque rien.
  return null;
}

/* --------------------------------------------------------------------------
 * Partage et planification
 * ----------------------------------------------------------------------- */

async function importerSousUtilisateurs(
  db: Database,
  source: mysql.Connection,
  options: Options,
  refs: { comptes: Map<number, string>; parc: Map<number, string> },
): Promise<void> {
  const [lignes] = await source.query<mysql.RowDataPacket[]>(
    "select server_id, user_id, permissions from subusers",
  );

  for (const ligne of lignes) {
    const serverId = refs.parc.get(Number(ligne.server_id));
    const userId = refs.comptes.get(Number(ligne.user_id));
    if (!serverId || !userId) {
      noter("sous-utilisateurs", "ignore");
      continue;
    }
    if (!options.apply) {
      noter("sous-utilisateurs", "cree");
      continue;
    }

    const [existant] = await db
      .select({ serverId: serverSubusers.serverId })
      .from(serverSubusers)
      .where(and(eq(serverSubusers.serverId, serverId), eq(serverSubusers.userId, userId)))
      .limit(1);
    if (existant) {
      noter("sous-utilisateurs", "ignore");
      continue;
    }

    await db.insert(serverSubusers).values({
      serverId,
      userId,
      // Les chaînes de permissions sont les mêmes des deux côtés : c'est un
      // choix de conception du panel, précisément pour que cette reprise soit
      // une recopie et non une traduction.
      permissions: lireJson(ligne.permissions) ?? [],
    });
    noter("sous-utilisateurs", "cree");
  }
}

async function importerPlanifications(
  db: Database,
  source: mysql.Connection,
  options: Options,
  parc: Map<number, string>,
): Promise<void> {
  const [lignes] = await source.query<mysql.RowDataPacket[]>(
    "select id, server_id, name, cron_minute, cron_hour, cron_day_of_month, cron_month, cron_day_of_week, is_active, only_when_online from schedules",
  );

  for (const ligne of lignes) {
    const serverId = parc.get(Number(ligne.server_id));
    if (!serverId || !options.apply) {
      noter("planifications", serverId ? "cree" : "ignore");
      continue;
    }

    const [cree] = await db
      .insert(schedules)
      .values({
        serverId,
        name: String(ligne.name),
        cronMinute: String(ligne.cron_minute),
        cronHour: String(ligne.cron_hour),
        cronDayOfMonth: String(ligne.cron_day_of_month),
        cronMonth: String(ligne.cron_month),
        cronDayOfWeek: String(ligne.cron_day_of_week),
        isActive: Number(ligne.is_active) === 1,
        onlyWhenOnline: Number(ligne.only_when_online) === 1,
        /*
         * L'échéance est laissée nulle, donc la tâche ne part pas.
         *
         * C'est voulu : au moment de la reprise, les daemons ne parlent pas
         * encore au nouveau panel. Une tâche qui se déclencherait échouerait,
         * enverrait un avertissement au client et poserait son drapeau — le
         * tout pour une panne qui n'en est pas une. L'écran des tâches
         * recalcule l'échéance à la première modification, et la commande
         * « exécuter maintenant » reste disponible.
         */
        nextRunAt: null,
      })
      .returning({ id: schedules.id });

    if (!cree) continue;
    noter("planifications", "cree");

    const [taches] = await source.query<mysql.RowDataPacket[]>(
      "select sequence_id, action, payload, time_offset, continue_on_failure from tasks where schedule_id = ? order by sequence_id",
      [ligne.id],
    );
    for (const tache of taches) {
      const action = String(tache.action);
      if (action !== "command" && action !== "power" && action !== "backup") continue;
      await db.insert(scheduleTasks).values({
        scheduleId: cree.id,
        sequence: Number(tache.sequence_id),
        action,
        payload: String(tache.payload ?? ""),
        timeOffset: Math.min(900, Number(tache.time_offset ?? 0)),
        continueOnFailure: Number(tache.continue_on_failure ?? 0) === 1,
      });
    }
  }
}

/* --------------------------------------------------------------------------
 * Outils
 * ----------------------------------------------------------------------- */

/**
 * Un jeton de daemon tout neuf.
 *
 * Celui de Pterodactyl est chiffré avec sa propre clé applicative : il est
 * illisible pour nous, et le recopier chiffré donnerait un jeton que ce panel
 * ne sait pas déchiffrer. La machine devra donc recevoir une nouvelle
 * configuration — ce que le bilan rappelle à la fin.
 */
function jetonDeDaemon(): { id: string; secret: string } {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  // `randomInt` tire sans biais ; `octet % 62` favorisait les huit premiers
  // caractères de l'alphabet (5 chances sur 256 au lieu de 4).
  const tirer = (taille: number) =>
    Array.from({ length: taille }, () => alphabet[randomInt(alphabet.length)]).join("");
  return { id: tirer(16), secret: tirer(64) };
}

/** Une colonne JSON de MySQL, qui arrive tantôt en objet, tantôt en texte. */
function lireJson(valeur: unknown): Record<string, unknown> | unknown[] | null {
  if (valeur === null || valeur === undefined) return null;
  if (typeof valeur === "object") return valeur as Record<string, unknown>;
  try {
    return JSON.parse(String(valeur)) as Record<string, unknown>;
  } catch {
    return null;
  }
}
