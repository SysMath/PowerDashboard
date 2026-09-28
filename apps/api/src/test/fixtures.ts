import { randomBytes, randomUUID } from "node:crypto";
import {
  allocations,
  applicationKeys,
  applicationWebhooks,
  type Database,
  eggs,
  locations,
  nests,
  nodes,
  servers,
  users,
} from "@gamedashboard/db";

/**
 * Jeu de données minimal pour les tests d'intégration.
 *
 * Écrit à la main plutôt que copié d'une base de développement : un test doit
 * énoncer ses hypothèses. Une donnée venue d'ailleurs rend un échec
 * indéchiffrable — on ne sait plus si c'est le code ou la fixture qui a changé.
 *
 * Chaque fonction ne pose que ce dont elle a besoin et rend l'identifiant créé.
 * Les champs sans rapport avec ce qu'on teste reçoivent une valeur plausible,
 * jamais une valeur « magique » qui ferait croire à une signification.
 */

export async function seedUser(db: Database): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({
      email: `client-${randomBytes(4).toString("hex")}@gamedashboard.test`,
      nameFirst: "Client",
      nameLast: "Exemple",
      passwordHash: null,
    })
    .returning({ id: users.id });

  if (!row) throw new Error("compte non créé");
  return row.id;
}

export async function seedLocation(db: Database): Promise<string> {
  const short = `t${randomBytes(3).toString("hex")}`;
  const [row] = await db
    .insert(locations)
    .values({ short, long: "Localisation de test", countryCode: "FR" })
    .returning({ id: locations.id });

  if (!row) throw new Error("localisation non créée");
  return row.id;
}

export async function seedNode(
  db: Database,
  input: {
    locationId: string;
    name?: string;
    /** `undefined` pose la valeur par défaut ; `null` signifie « jamais joint ». */
    lastHeartbeatAt?: string | null;
    unreachableSince?: string | null;
    maintenance?: boolean;
    ownerId?: string | null;
  },
): Promise<string> {
  const [row] = await db
    .insert(nodes)
    .values({
      name: input.name ?? `NODE-${randomBytes(3).toString("hex")}`,
      locationId: input.locationId,
      ownerId: input.ownerId ?? null,
      fqdn: "node.test",
      memoryMb: 65_536,
      diskMb: 1_048_576,
      cpuCores: 16,
      maintenanceMode: input.maintenance ?? false,
      // Le jeton du daemon n'a aucun rôle ici, mais la colonne est obligatoire :
      // une valeur factice explicite vaut mieux qu'un secret d'apparence vraie.
      daemonTokenId: randomBytes(8).toString("hex"),
      daemonTokenEnc: "test",
      daemonTokenRotatedAt: new Date().toISOString(),
      lastHeartbeatAt: input.lastHeartbeatAt ?? null,
      unreachableSince: input.unreachableSince ?? null,
    })
    .returning({ id: nodes.id });

  if (!row) throw new Error("node non créé");
  return row.id;
}

/**
 * Prochain port des serveurs de test. Tiré au hasard pour chacun, deux
 * serveurs d'un même fichier finissaient par tomber sur le même
 * (`allocation_node_ip_port_unique`) : une chance sur trois pour soixante
 * serveurs. Le départ reste tiré au hasard, la suite ne se répète plus.
 */
let nextPort = Math.floor(Math.random() * 5000);

/** Un serveur complet, avec l'egg et le port que le schéma exige. */
export async function seedServer(
  db: Database,
  input: { nodeId: string; ownerId: string },
): Promise<string> {
  const [nest] = await db
    .insert(nests)
    .values({ name: `Famille ${randomBytes(3).toString("hex")}` })
    .returning({ id: nests.id });
  if (!nest) throw new Error("famille non créée");

  const [egg] = await db
    .insert(eggs)
    .values({
      nestId: nest.id,
      name: "Jeu de test",
      startup: "./start",
      installContainer: "debian:bookworm-slim",
      enabled: true,
    })
    .returning({ id: eggs.id });
  if (!egg) throw new Error("egg non créé");

  const [allocation] = await db
    .insert(allocations)
    .values({
      nodeId: input.nodeId,
      ip: "127.0.0.1",
      port: 25_000 + (nextPort++ % 5000),
    })
    .returning({ id: allocations.id });
  if (!allocation) throw new Error("port non créé");

  const serverId = randomUUID();
  await db.insert(servers).values({
    id: serverId,
    uuidShort: serverId.slice(0, 8),
    name: "Serveur de test",
    ownerId: input.ownerId,
    nodeId: input.nodeId,
    eggId: egg.id,
    allocationId: allocation.id,
    dockerImage: "debian:bookworm-slim",
    startup: "./start",
    memoryMb: 2048,
    diskMb: 10_240,
  });

  return serverId;
}

/**
 * Un point d'entrée de rappel abonné à des événements.
 *
 * Le secret n'est pas chiffré ici : ces tests n'envoient rien sur le réseau et
 * ne signent donc rien. Poser une valeur lisible dit à qui relit le test que
 * la signature n'est pas le sujet — la déchiffrer le serait.
 */
export async function seedWebhook(
  db: Database,
  input: { events: string[]; isActive?: boolean },
): Promise<string> {
  const [key] = await db
    .insert(applicationKeys)
    .values({
      name: "Intégration de test",
      prefix: `gd_app_${randomBytes(4).toString("hex")}`,
      keyHash: "test",
      scopes: ["infrastructure.read"],
    })
    .returning({ id: applicationKeys.id });
  if (!key) throw new Error("clé applicative non créée");

  const [hook] = await db
    .insert(applicationWebhooks)
    .values({
      applicationKeyId: key.id,
      url: "https://boutique.test/hook",
      secretEnc: "secret-de-test-non-chiffre",
      events: input.events,
      isActive: input.isActive ?? true,
    })
    .returning({ id: applicationWebhooks.id });
  if (!hook) throw new Error("point d'entrée non créé");

  return hook.id;
}
