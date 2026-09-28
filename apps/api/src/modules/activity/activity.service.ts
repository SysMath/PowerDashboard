import type { AuditExportFormat, AuditFilters } from "@gamedashboard/contracts";
import { activityLogs, type Database, servers, users } from "@gamedashboard/db";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, desc, eq, ilike, or, type SQL, sql } from "drizzle-orm";
import { DATABASE } from "../../common/database.provider";
import { type AuditExportFile, auditExportFile } from "./audit-export";

export interface ActivityEntry {
  id: string;
  event: string;
  actorLabel: string;
  actorType: "user" | "api_key" | "system";
  ip: string | null;
  properties: Record<string, unknown>;
  at: string;
}

/**
 * Une ligne du journal, vue depuis l'administration.
 *
 * Elle porte en plus le serveur concerné — nul pour un événement de compte — et
 * l'identifiant de l'acteur, qui permet de filtrer sur une personne sans
 * dépendre de son nom, lequel est figé au moment de l'action.
 */
export interface PlatformActivityEntry extends ActivityEntry {
  actorId: string | null;
  serverId: string | null;
  serverName: string | null;
}

export interface RecordInput {
  event: string;
  serverId: string | null;
  actorId: string | null;
  actorType: "user" | "api_key" | "system";
  actorLabel: string;
  ip?: string | null;
  userAgent?: string | null;
  properties?: Record<string, unknown>;
}

/** Une page de journal. Au-delà, l'écran deviendrait illisible avant d'être utile. */
const PAGE_SIZE = 50;

/**
 * Journal d'audit, en ajout seul.
 *
 * Aucune méthode de modification ni de suppression n'existe, et c'est
 * volontaire : un journal qu'on peut retoucher ne prouve rien. Les lignes
 * disparaissent par la rétention, jamais par une action.
 */
@Injectable()
export class ActivityService {
  /** Publique pour qu'un test puisse la museler sans contourner le type. */
  readonly logger = new Logger(ActivityService.name);

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Consigne un événement.
   *
   * **N'échoue jamais.** Une écriture de journal ratée ne doit pas annuler
   * l'action qu'elle décrit : refuser un redémarrage parce que le journal est
   * plein transformerait un problème d'audit en panne de service. L'échec part
   * dans les journaux du processus, où il sera vu.
   *
   * La conséquence est assumée : le journal peut avoir des trous. C'est le bon
   * compromis pour un panel d'hébergement, ce ne le serait pas pour un registre
   * comptable.
   */
  async record(input: RecordInput): Promise<void> {
    try {
      await this.insert(input);
    } catch (error) {
      this.logger.error(
        `Journal : « ${input.event} » non consigné — ${
          error instanceof Error ? error.message : "erreur inconnue"
        }`,
      );
    }
  }

  /**
   * Consigne un événement **dont l'action dépend** : si l'écriture échoue,
   * l'erreur remonte et l'action n'a pas lieu.
   *
   * Réservé aux sorties de données personnelles en masse — l'export du
   * journal ci-dessous, celui de la consommation — pour la même raison :
   * « qui a emporté quoi » est la question qu'un trou dans l'audit rendrait
   * sans réponse (ASVS 8.3.5).
   */
  async recordRequired(input: RecordInput): Promise<void> {
    await this.insert(input);
  }

  /**
   * Exporte le journal de la plateforme, après avoir consigné l'export.
   *
   * **La seule écriture de journal qui peut faire échouer son action**, à
   * rebours de `record()`. Refuser un redémarrage faute de journal serait une
   * panne de service ; laisser sortir le journal entier sans trace serait un
   * trou dans l'audit à l'endroit précis où il compte — qui a emporté quoi.
   * Si la trace ne s'écrit pas, rien ne part.
   *
   * La trace dit qui, sous quel format, et **avec quels filtres** : « tout le
   * journal » et « les connexions d'un compte » ne sont pas le même geste.
   */
  async exportPlatform(input: {
    filters: AuditFilters;
    format: AuditExportFormat;
    actor: { id: string; label: string; ip?: string | null; userAgent?: string | null };
  }): Promise<AuditExportFile> {
    // Seuls les filtres posés : un `undefined` disparaîtrait de toute façon
    // à la sérialisation JSON, autant que la trace le dise franchement.
    const filters = Object.fromEntries(
      Object.entries(input.filters).filter(([, value]) => value !== undefined),
    );

    await this.insert({
      event: "admin.audit_exported",
      serverId: null,
      actorId: input.actor.id,
      actorType: "user",
      actorLabel: input.actor.label,
      ip: input.actor.ip ?? null,
      userAgent: input.actor.userAgent ?? null,
      properties: { format: input.format, filters },
    });

    return auditExportFile(input.format, this.streamPlatform(input.filters));
  }

  private async insert(input: RecordInput): Promise<void> {
    await this.db.insert(activityLogs).values({
      actorId: input.actorId,
      actorType: input.actorType,
      actorLabel: input.actorLabel,
      serverId: input.serverId,
      event: input.event,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      properties: input.properties ?? {},
      at: new Date().toISOString(),
    });
  }

  /**
   * Journal d'un serveur.
   *
   * Le filtrage se fait en base et non après coup : une recherche appliquée en
   * mémoire sur une page déjà tronquée ne trouverait que ce qui figure dans les
   * cinquante dernières lignes, et donnerait « aucun résultat » pour un
   * événement qui existe.
   *
   * `revealIp` : l'adresse des acteurs ne va qu'à qui a tous les droits sur le
   * serveur. `activity.read` est dans le préréglage « lecteur », et un invité
   * voyait l'adresse du propriétaire, de ses autres invités, de l'assistance
   * — une donnée personnelle qui ne l'aide en rien à comprendre ce qui est
   * arrivé au serveur. Masquée, elle ne se cherche pas non plus : voir une
   * ligne apparaître pour « 198.51.100 » la dirait aussi sûrement.
   */
  async forServer(
    serverId: string,
    options: { query?: string; page?: number; revealIp?: boolean } = {},
  ): Promise<{ items: ActivityEntry[]; page: number; hasMore: boolean }> {
    const page = Math.max(1, Math.trunc(options.page ?? 1));
    const search = options.query?.trim();
    // Fermé par défaut : un appelant qui oublie la question ne montre rien.
    const revealIp = options.revealIp === true;

    const conditions = [eq(activityLogs.serverId, serverId)];
    if (search) {
      const pattern = `%${search}%`;
      const ipMatch = or(
        ilike(activityLogs.actorLabel, pattern),
        ilike(activityLogs.event, pattern),
        // `inet` ne se compare pas à un motif texte : la colonne est convertie
        // explicitement, sinon PostgreSQL refuse l'opérateur.
        revealIp ? sql`host(${activityLogs.ip}) ilike ${pattern}` : undefined,
      );
      if (ipMatch) conditions.push(ipMatch);
    }

    const rows = await this.db
      .select({
        id: activityLogs.id,
        event: activityLogs.event,
        actorLabel: activityLogs.actorLabel,
        actorType: activityLogs.actorType,
        ip: activityLogs.ip,
        properties: activityLogs.properties,
        at: activityLogs.at,
      })
      .from(activityLogs)
      .where(and(...conditions))
      .orderBy(desc(activityLogs.at))
      // Une ligne de plus que la page : c'est elle qui dit s'il y a une suite,
      // sans payer un COUNT sur une table qui grossit sans fin.
      .limit(PAGE_SIZE + 1)
      .offset((page - 1) * PAGE_SIZE);

    const hasMore = rows.length > PAGE_SIZE;
    return {
      page,
      hasMore,
      items: rows.slice(0, PAGE_SIZE).map((row) => ({
        id: row.id,
        event: row.event,
        actorLabel: row.actorLabel,
        actorType: row.actorType as ActivityEntry["actorType"],
        ip: revealIp ? row.ip : null,
        properties: (row.properties ?? {}) as Record<string, unknown>,
        at: row.at,
      })),
    };
  }

  /**
   * Le journal de toute la plateforme.
   *
   * **Sans cette lecture, une partie du journal n'avait aucun lecteur.** Les
   * événements de compte — mot de passe changé, adresse confirmée, rôle
   * modifié, session révoquée — portent `server_id = null` : ils étaient écrits
   * avec soin et ne figuraient sur aucun écran. Un journal d'audit que personne
   * ne peut consulter n'est pas un journal d'audit.
   *
   * Les filtres portent sur ce qu'on cherche réellement après coup : un
   * événement précis, une personne, un serveur, une période. Le tout en base,
   * jamais en mémoire — filtrer une page déjà tronquée donnerait « aucun
   * résultat » pour un événement qui existe, au-delà des cinquante dernières
   * lignes.
   */
  async forPlatform(
    options: AuditFilters & { page?: number } = {},
  ): Promise<{ items: PlatformActivityEntry[]; page: number; hasMore: boolean }> {
    const page = Math.max(1, Math.trunc(options.page ?? 1));

    const rows = await this.db
      .select(PLATFORM_COLUMNS)
      .from(activityLogs)
      .leftJoin(servers, eq(activityLogs.serverId, servers.id))
      .where(platformActivityFilter(options))
      .orderBy(...PLATFORM_ORDER)
      .limit(PAGE_SIZE + 1)
      .offset((page - 1) * PAGE_SIZE);

    return {
      page,
      hasMore: rows.length > PAGE_SIZE,
      items: rows.slice(0, PAGE_SIZE).map(toPlatformEntry),
    };
  }

  /**
   * Tout le journal de la plateforme qui répond à ces filtres, **en flux**.
   *
   * Pour l'export. Le journal grossit sans fin : le lire d'un bloc tiendrait en
   * mémoire des centaines de milliers de lignes pour les recracher aussitôt, et
   * c'est l'API entière qui tomberait sur un export trop large.
   *
   * Pagination par curseur (`at`, `id`) et non par décalage : un `OFFSET`
   * relit et jette toutes les lignes qui précèdent, si bien que la dernière
   * page d'un gros export coûterait autant que l'export entier. Le curseur
   * reprend là où la page précédente s'est arrêtée.
   *
   * L'ordre est décroissant, comme à l'écran. Conséquence voulue : une ligne
   * écrite pendant l'export est plus récente que tout ce qui reste à lire, et
   * n'y entre donc pas. L'export décrit le journal tel qu'il était au moment
   * du clic — sa propre trace comprise, puisqu'elle précède la première
   * lecture.
   *
   * Aucune transaction n'est tenue ouverte pendant le transfert : un
   * téléchargement lent ne doit pas retenir une connexion de la base.
   */
  async *streamPlatform(
    filters: AuditFilters,
    batchSize = EXPORT_BATCH,
  ): AsyncGenerator<PlatformActivityEntry> {
    let cursor: { at: string; id: string } | null = null;

    for (;;) {
      const after: SQL | undefined = cursor
        ? sql`(${activityLogs.at}, ${activityLogs.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
        : undefined;

      const rows: PlatformRow[] = await this.db
        .select(PLATFORM_COLUMNS)
        .from(activityLogs)
        .leftJoin(servers, eq(activityLogs.serverId, servers.id))
        // Le même prédicat que l'écran, et non une copie : c'est ce qui
        // garantit que le fichier contient ce que la liste montrait.
        .where(and(platformActivityFilter(filters), after))
        .orderBy(...PLATFORM_ORDER)
        .limit(batchSize);

      for (const row of rows) yield toPlatformEntry(row);

      const last = rows.at(-1);
      if (!last || rows.length < batchSize) return;
      cursor = { at: last.at, id: last.id };
    }
  }

  /**
   * Nom lisible d'un utilisateur, figé au moment de l'action.
   *
   * Recopié dans le journal plutôt que joint à la lecture : un compte supprimé
   * doit rester identifiable, et un compte renommé ne doit pas voir son
   * ancien nom réécrit dans l'historique.
   */
  async labelFor(userId: string): Promise<string> {
    const [row] = await this.db
      .select({ first: users.nameFirst, last: users.nameLast, email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!row) return "Compte inconnu";
    const name = `${row.first} ${row.last}`.trim();
    return name === "" ? row.email : name;
  }
}

/** Lignes lues par bloc pendant un export : assez pour amortir l'aller-retour, assez peu pour la mémoire. */
const EXPORT_BATCH = 500;

/**
 * Colonnes du journal vu depuis l'administration.
 *
 * Le nom du serveur est joint à la lecture, contrairement à celui de l'acteur
 * qui est figé à l'écriture : un serveur renommé doit s'afficher sous son nom
 * actuel, sinon on ne le retrouve pas dans la liste des serveurs.
 */
const PLATFORM_COLUMNS = {
  id: activityLogs.id,
  event: activityLogs.event,
  actorId: activityLogs.actorId,
  actorLabel: activityLogs.actorLabel,
  actorType: activityLogs.actorType,
  ip: activityLogs.ip,
  properties: activityLogs.properties,
  at: activityLogs.at,
  serverId: activityLogs.serverId,
  serverName: servers.name,
};

/**
 * Du plus récent au plus ancien, l'identifiant départageant les ex æquo.
 *
 * Sans ce second critère, deux lignes du même instant — une action et sa
 * conséquence, écrites dans la même milliseconde — pouvaient changer d'ordre
 * d'une page à l'autre, l'une apparaissant deux fois quand l'autre manquait.
 * Le curseur de l'export en a besoin pour être exact.
 */
const PLATFORM_ORDER = [desc(activityLogs.at), desc(activityLogs.id)] as const;

interface PlatformRow {
  id: string;
  event: string;
  actorId: string | null;
  actorLabel: string;
  actorType: string;
  ip: string | null;
  properties: unknown;
  at: string;
  serverId: string | null;
  serverName: string | null;
}

function toPlatformEntry(row: PlatformRow): PlatformActivityEntry {
  return {
    id: row.id,
    event: row.event,
    actorId: row.actorId,
    actorLabel: row.actorLabel,
    actorType: row.actorType as ActivityEntry["actorType"],
    ip: row.ip,
    properties: (row.properties ?? {}) as Record<string, unknown>,
    at: row.at,
    serverId: row.serverId,
    serverName: row.serverName,
  };
}

/**
 * Le prédicat des filtres du journal de la plateforme.
 *
 * **Seule construction de ces filtres**, partagée par l'écran et l'export.
 * Deux copies finiraient par diverger, et l'export livrerait alors autre chose
 * que ce que l'administrateur voyait en cliquant — sans que rien ne le signale.
 *
 * Le tout en base, jamais en mémoire : filtrer une page déjà tronquée
 * donnerait « aucun résultat » pour un événement qui existe, au-delà des
 * cinquante dernières lignes.
 */
export function platformActivityFilter(filters: AuditFilters): SQL | undefined {
  const conditions: SQL[] = [];

  const search = filters.query?.trim();
  if (search) {
    const pattern = `%${search}%`;
    const match = or(
      ilike(activityLogs.actorLabel, pattern),
      ilike(activityLogs.event, pattern),
      // `inet` ne se compare pas à un motif texte : la colonne est convertie
      // explicitement, sinon PostgreSQL refuse l'opérateur.
      sql`host(${activityLogs.ip}) ilike ${pattern}`,
    );
    if (match) conditions.push(match);
  }

  /*
   * Le filtre d'événement accepte un préfixe.
   *
   * « account. » rassemble tout ce qui touche aux comptes, « server.power »
   * les seuls démarrages et arrêts. Chercher un événement exact obligerait à
   * connaître la liste par cœur, et une recherche libre ramènerait les
   * lignes où le mot figure ailleurs.
   */
  const event = filters.event?.trim();
  if (event) conditions.push(ilike(activityLogs.event, `${event}%`));
  if (filters.actorId) conditions.push(eq(activityLogs.actorId, filters.actorId));
  if (filters.serverId) conditions.push(eq(activityLogs.serverId, filters.serverId));
  if (filters.since) {
    conditions.push(
      sql`${activityLogs.at} >= ${new Date(filters.since).toISOString()}::timestamptz`,
    );
  }

  return conditions.length > 0 ? and(...conditions) : undefined;
}
