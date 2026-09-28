import { isIPv4, isIPv6 } from "node:net";
import {
  type DesiredRecord,
  type DnsProviderKind,
  desiredRecords,
  domainWithinZone,
  MINECRAFT_SRV_PREFIX,
  normalizeDnsDomain,
  readableDnsProvider,
  reservedLabels,
  SUBDOMAIN_LABEL_MESSAGES,
  type SubdomainState,
  type SubdomainStatus,
  type SubdomainView,
  sameRecord,
  subdomainLabelProblem,
} from "@gamedashboard/contracts";
import {
  allocations,
  type Database,
  eggs,
  nests,
  nodes,
  type PublishedDnsRecord,
  serverSubdomains,
  servers,
  settings,
} from "@gamedashboard/db";
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
  ServiceUnavailableException,
} from "@nestjs/common";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { battre } from "../../common/background-tick";
import { DATABASE } from "../../common/database.provider";
import { isPrivateAddress } from "../../common/public-url";
import { decryptRowSecret } from "../../common/row-secrets";
import { probeHost } from "../scheduler/game-probe.service";
import { probePlan } from "../scheduler/probe-plan";
import { type DnsConnection, type DnsProvider, DnsRefusal, type NamedRecord } from "./dns-provider";

/** Jeton d'injection du registre des fournisseurs, substitué par les tests. */
export const DNS_PROVIDERS = Symbol("DNS_PROVIDERS");

export type DnsProviders = Readonly<Record<DnsProviderKind, DnsProvider>>;

/** Le balayage : rattrape les échecs et ce qui a changé sans passer par le panel. */
const TICK_MS = 5 * 60_000;
/** Lignes traitées au plus par tour : l'API de Cloudflare compte les appels. */
const MAX_PER_TICK = 50;

/**
 * Délai minimal entre deux essais de nom d'un même serveur (et entre deux
 * republications de son adresse), et nombre d'essais admis par minute sur
 * toute la plateforme.
 *
 * Cloudflare admet 1 200 requêtes par 5 minutes **pour tout le compte**. Un
 * changement de nom en coûte jusqu'à huit pour Minecraft (deux lectures de
 * vérification, une lecture et une création par enregistrement, deux retraits
 * de l'ancien nom), cinq sinon ; une première prise, six ou quatre ; un nom
 * refusé parce que la zone le porte déjà, deux. Sans borne, un seul client
 * épuisait ce quota et les noms de tous les autres cessaient d'être suivis.
 * Vingt essais par minute coûtent au plus 800 requêtes par 5 minutes, et
 * laissent sa part au balayage.
 *
 * **Chaque essai compte, réussi ou non** : il est noté avant d'appeler le
 * fournisseur.
 *
 * Tenu en mémoire : l'API tourne en un seul processus (cPanel, production). À
 * plusieurs, chacun aurait sa propre part.
 */
export const SUBDOMAIN_CHANGE_INTERVAL_MS = 60_000;
export const SUBDOMAIN_CHANGES_PER_MINUTE = 20;

export const SUBDOMAIN_NOT_CONFIGURED =
  "Les sous-domaines ne sont pas activés sur cette plateforme.";

/**
 * Ce que le client lit d'un échec. La phrase du fournisseur n'y figure jamais :
 * elle peut nommer la zone, le compte ou un détail de la configuration, et ne
 * lui apprendrait rien qu'il puisse corriger.
 */
export const SUBDOMAIN_ERRORS = {
  conflict: "Ce nom est déjà employé dans la zone DNS : choisissez-en un autre.",
  private:
    "L'adresse de ce serveur n'est pas publique : rien n'est publié tant que la plateforme ne lui en donne pas une.",
  failed:
    "La zone DNS a refusé la publication ou n'a pas répondu. Le panel réessaie toutes les cinq minutes ; si l'échec dure, contactez le support.",
} as const;

/** Un échec dont la phrase peut être montrée au client telle quelle. */
class SubdomainProblem extends Error {}

interface DnsSetup {
  provider: DnsProvider;
  connection: DnsConnection;
  domain: string;
  reserved: ReadonlySet<string>;
}

/** Où joindre un serveur, et s'il lit le SRV. */
interface Target {
  host: string;
  port: number;
  srv: boolean;
}

type SubdomainRow = typeof serverSubdomains.$inferSelect;

/** Issue de l'essai lancé depuis l'administration. */
export interface DnsProbe {
  ok: boolean;
  zone: string | null;
  error: string | null;
}

/**
 * Sous-domaines des serveurs, publiés chez le fournisseur DNS (PLAN §10.3).
 *
 * **La base dit ce qui doit être publié, le balayage s'en assure.** Chaque
 * geste du panel qui change l'adresse d'un serveur (port principal, transfert,
 * suppression) demande une mise à jour immédiate, sans l'attendre : une zone
 * injoignable ne doit pas faire échouer un transfert. Le balayage compare
 * ensuite, toutes les cinq minutes, ce qui est publié à ce qui devrait l'être,
 * et rattrape tout le reste — échecs, adresse changée par l'administration,
 * egg changé, serveur supprimé, zone ou domaine changés.
 *
 * Seuls les enregistrements que le panel a créés sont touchés : il retient
 * leurs identifiants, et refuse de publier à un nom que la zone porte déjà.
 */
@Injectable()
export class SubdomainsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SubdomainsService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** Vrai une fois le module arrêté : plus aucune republication repoussée. */
  private stopped = false;
  /** Dernier changement de nom, par serveur. */
  private readonly lastChange = new Map<string, number>();
  /** Instants des changements de la dernière minute, toute la plateforme. */
  private recentChanges: number[] = [];
  /** Dernière republication immédiate, par serveur. */
  private readonly lastRefresh = new Map<string, number>();
  /** Republications repoussées à la fin du délai, une au plus par serveur. */
  private readonly deferred = new Map<string, NodeJS.Timeout>();
  /** L'horloge des limites de fréquence, remplacée par les tests. */
  clock: () => number = () => Date.now();

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(DNS_PROVIDERS) private readonly providers: DnsProviders,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(
      () => battre(this.logger, "sous-domaines", () => this.reconcile()),
      TICK_MS,
    );
    this.timer.unref();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const pending of this.deferred.values()) clearTimeout(pending);
    this.deferred.clear();
  }

  /** Ce que l'écran réseau montre. */
  async stateFor(serverId: string): Promise<SubdomainState> {
    const setup = await this.configuration();
    const [row] = await this.db
      .select()
      .from(serverSubdomains)
      .where(eq(serverSubdomains.serverId, serverId))
      .limit(1);
    const target = row ? await this.targetOf(serverId) : null;
    return {
      available: setup !== null,
      domain: setup?.domain ?? null,
      subdomain: row ? view(row, target) : null,
    };
  }

  /**
   * Donne ce libellé au serveur, ou le change.
   *
   * Tous les noms que le panel pourrait publier sont vérifiés **chez le
   * fournisseur** avant d'être retenus, SRV compris : un nom que la zone porte
   * déjà (le site de l'hébergeur, le SRV d'un réseau Minecraft) ne doit
   * jamais être doublé.
   */
  async claim(serverId: string, rawLabel: string): Promise<SubdomainView> {
    const setup = await this.configuration();
    if (!setup) throw new ServiceUnavailableException(SUBDOMAIN_NOT_CONFIGURED);

    const label = rawLabel.trim().toLowerCase();
    const problem = subdomainLabelProblem(label, setup.reserved);
    if (problem) throw new BadRequestException(SUBDOMAIN_LABEL_MESSAGES[problem]);
    const fqdn = `${label}.${setup.domain}`;
    if (fqdn.length > 253) throw new BadRequestException(SUBDOMAIN_LABEL_MESSAGES.length);

    const [current] = await this.db
      .select()
      .from(serverSubdomains)
      .where(eq(serverSubdomains.serverId, serverId))
      .limit(1);
    if (current?.fqdn === fqdn) return this.view(serverId);

    const [taken] = await this.db
      .select({ id: serverSubdomains.id })
      .from(serverSubdomains)
      .where(eq(serverSubdomains.fqdn, fqdn))
      .limit(1);
    if (taken) throw new ConflictException("Ce nom est déjà pris.");

    // Compté avant d'appeler le fournisseur : un nom refusé par la zone coûte
    // aussi des requêtes, et se répéterait sinon sans limite.
    await this.throttle(serverId);
    this.noteChange(serverId);

    let existing: { id: string }[];
    try {
      existing = (
        await Promise.all(
          publishableNames(fqdn).map((name) => setup.provider.recordsNamed(setup.connection, name)),
        )
      )
        .flat()
        // Posé par le panel pour ce serveur, dont la réponse s'est perdue : il sera repris.
        .filter((record) => !isOwnRecord(record, serverId));
    } catch (error) {
      this.logger.warn(`Zone DNS injoignable : ${this.describe(error, setup)}.`);
      throw new ServiceUnavailableException(
        "La zone DNS ne répond pas. Réessayez dans quelques minutes.",
      );
    }
    if (existing.length > 0) throw new ConflictException("Ce nom est déjà pris.");

    const row = await this.db.transaction(async (tx) => {
      // L'ancien nom est abandonné : le balayage retire ses enregistrements.
      await tx
        .update(serverSubdomains)
        .set({ serverId: null, abandonedBy: serverId, updatedAt: new Date().toISOString() })
        .where(eq(serverSubdomains.serverId, serverId));
      const [inserted] = await tx
        .insert(serverSubdomains)
        .values({
          serverId,
          label,
          fqdn,
          provider: setup.provider.kind,
          zoneId: setup.connection.zoneId,
        })
        .onConflictDoNothing()
        .returning({ id: serverSubdomains.id });
      // Deux serveurs sur le même nom au même instant : le second arrive ici,
      // et l'abandon de son ancien nom est défait avec la transaction.
      if (!inserted) throw new ConflictException("Ce nom est déjà pris.");
      return inserted;
    });

    // Un échec est inscrit sur la ligne, et l'écran le montre ; le balayage retentera.
    await this.syncRow(row.id).catch(() => undefined);
    if (current) void this.sweepSoon();
    return this.view(serverId);
  }

  /** Retire le sous-domaine du serveur. */
  async release(serverId: string): Promise<void> {
    await this.throttle(serverId);
    this.noteChange(serverId);
    const abandoned = await this.db
      .update(serverSubdomains)
      .set({ serverId: null, abandonedBy: serverId, updatedAt: new Date().toISOString() })
      .where(eq(serverSubdomains.serverId, serverId))
      .returning({ id: serverSubdomains.id });
    for (const row of abandoned) await this.syncRow(row.id).catch(() => undefined);
  }

  /**
   * L'adresse du serveur vient de changer : republier, sans attendre.
   *
   * Ne lève jamais : l'appelant (port principal, transfert) a déjà réussi, et
   * le balayage rattrapera un échec.
   */
  refresh(serverId: string): Promise<void> {
    // Une bascule de port en boucle ne doit pas appeler le fournisseur à
    // chaque fois : au plus une republication par délai, la dernière repoussée
    // à la fin du délai pour que le nom suive quand même.
    const now = this.clock();
    const last = this.lastRefresh.get(serverId);
    if (last !== undefined && now - last < SUBDOMAIN_CHANGE_INTERVAL_MS) {
      if (!this.deferred.has(serverId) && !this.stopped) {
        const later = setTimeout(
          () => {
            this.deferred.delete(serverId);
            void this.refresh(serverId);
          },
          last + SUBDOMAIN_CHANGE_INTERVAL_MS - now,
        );
        later.unref();
        this.deferred.set(serverId, later);
      }
      return Promise.resolve();
    }
    forgetOlder(this.lastRefresh, now);
    this.lastRefresh.set(serverId, now);
    return battre(this.logger, "sous-domaines", async () => {
      const [row] = await this.db
        .select({ id: serverSubdomains.id })
        .from(serverSubdomains)
        .where(eq(serverSubdomains.serverId, serverId))
        .limit(1);
      if (row) await this.syncRow(row.id);
    });
  }

  /**
   * Le serveur va être supprimé, dans la transaction `db` : son nom retient
   * qui l'a publié, pour que le retrait trouve aussi les enregistrements dont
   * le panel a perdu la trace. Sans cela, la clé étrangère (`set null`)
   * effaçait la seule chose qui les désigne : leur note.
   */
  async departing(db: Pick<Database, "update">, serverId: string): Promise<void> {
    await db
      .update(serverSubdomains)
      .set({ abandonedBy: serverId })
      .where(eq(serverSubdomains.serverId, serverId));
  }

  /** Un serveur vient d'être supprimé : retirer tout de suite ses enregistrements. */
  sweepSoon(): Promise<void> {
    return battre(this.logger, "sous-domaines", () => this.reconcile({ orphansOnly: true }));
  }

  /**
   * Un tour du balayage : les noms abandonnés, les échecs, et tout ce qui est
   * publié autrement qu'il devrait l'être.
   */
  async reconcile(options: { orphansOnly?: boolean } = {}): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const setup = await this.configuration();
      if (!setup) return;
      const rows = await this.db
        .select()
        .from(serverSubdomains)
        .where(options.orphansOnly ? isNull(serverSubdomains.serverId) : undefined);
      // Les lignes actives sont comparées ici, sans appel au fournisseur.
      const targets = await this.targetsOf(
        rows.flatMap((row) => (row.serverId ? [row.serverId] : [])),
      );
      const due = rows.filter((row) => {
        if (!row.serverId || isStale(row, setup)) return true;
        const plan = wanted(row.fqdn, targets.get(row.serverId) ?? null);
        if (plan.problem === "private") {
          // Déjà signalée, rien de publié : rien à refaire à chaque tour.
          const settled =
            row.status === "error" &&
            row.error === SUBDOMAIN_ERRORS.private &&
            row.records.length === 0;
          return !settled;
        }
        return row.status !== "active" || !matches(row, plan.records);
      });
      for (const row of due.slice(0, MAX_PER_TICK)) {
        await this.syncRow(row.id).catch(() => undefined);
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * Essai de la zone, pour l'administration : le jeton lit-il la zone, et le
   * domaine des serveurs en fait-il partie ?
   */
  async probe(): Promise<DnsProbe> {
    const setup = await this.configuration();
    if (!setup) {
      return {
        ok: false,
        zone: null,
        error:
          "Choisissez un fournisseur, renseignez le domaine, l'identifiant de zone et le jeton, puis enregistrez.",
      };
    }
    try {
      const zone = await this.verifiedZone(setup);
      // Lire les enregistrements exige le droit DNS, que la lecture de la zone
      // ne prouve pas. L'écriture, elle, ne s'éprouve qu'en publiant.
      await setup.provider.recordsNamed(setup.connection, setup.domain);
      return { ok: true, zone, error: null };
    } catch (error) {
      return { ok: false, zone: null, error: this.describe(error, setup) };
    }
  }

  /**
   * Refuse un changement trop rapproché : un par minute et par serveur, et
   * aucun tant que l'ancien nom du serveur n'est pas retiré de la zone.
   */
  private async throttle(serverId: string): Promise<void> {
    const now = this.clock();
    const last = this.lastChange.get(serverId);
    if (last !== undefined && now - last < SUBDOMAIN_CHANGE_INTERVAL_MS) {
      throw new HttpException(
        "Attendez une minute entre deux changements de sous-domaine.",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    this.recentChanges = this.recentChanges.filter((at) => now - at < 60_000);
    if (this.recentChanges.length >= SUBDOMAIN_CHANGES_PER_MINUTE) {
      throw new HttpException(
        "Trop de changements de sous-domaines en ce moment. Réessayez dans une minute.",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const [pending] = await this.db
      .select({ id: serverSubdomains.id })
      .from(serverSubdomains)
      .where(and(eq(serverSubdomains.abandonedBy, serverId), isNull(serverSubdomains.serverId)))
      .limit(1);
    if (pending) {
      throw new HttpException(
        "L'ancien nom de ce serveur est encore en cours de retrait. Réessayez dans quelques minutes.",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private noteChange(serverId: string): void {
    const now = this.clock();
    forgetOlder(this.lastChange, now);
    this.lastChange.set(serverId, now);
    this.recentChanges.push(now);
  }

  /**
   * Met une ligne en accord avec ce qu'elle doit publier.
   *
   * La ligne est verrouillée le temps des appels : le balayage et une mise à
   * jour immédiate ne doivent pas créer deux fois le même enregistrement. Qui
   * trouve la ligne déjà prise s'en va, l'autre fait le travail.
   *
   * L'ordre des gestes compte. Un enregistrement qui change seulement de cible
   * est **modifié en place**. Un enregistrement qui change de type sous le même
   * nom (A devenu CNAME quand l'adresse devient un nom d'hôte) est **retiré
   * avant** la création de son remplaçant : le fournisseur refuse un CNAME à
   * côté d'un A, et le nom restait sinon bloqué sur l'ancienne adresse — un
   * port rendu au node, qu'un autre client peut recevoir. Ce qui vit sous un
   * autre nom ou dans une autre zone n'est retiré **qu'après** : le nouveau
   * nom répond avant que l'ancien disparaisse.
   */
  private async syncRow(id: string): Promise<void> {
    const setup = await this.configuration();
    if (!setup) return;
    const provider = setup.provider;

    const failure = await this.db.transaction(async (tx): Promise<unknown> => {
      const [locked] = await tx
        .select()
        .from(serverSubdomains)
        .where(eq(serverSubdomains.id, id))
        .for("update", { skipLocked: true });
      if (!locked) return null;
      let row = locked;
      const published = [...row.records];
      // Un nom resté en échec a pu voir une création aboutir sans réponse :
      // ses enregistrements ne sont pas tous dans `published`.
      const unsure = locked.status !== "active";

      const save = async (fields: Partial<SubdomainRow>) => {
        await tx
          .update(serverSubdomains)
          .set({ records: published, updatedAt: new Date().toISOString(), ...fields })
          .where(eq(serverSubdomains.id, row.id));
      };

      try {
        if (row.serverId && isStale(row, setup)) {
          row = await this.move(tx, row, setup);
        }

        if (!row.serverId) {
          await this.removeRecords(provider, setup, published, [...published]);
          if (unsure) await this.removeLost(provider, setup, row);
          await tx.delete(serverSubdomains).where(eq(serverSubdomains.id, row.id));
          return null;
        }

        const plan = wanted(row.fqdn, await this.targetOf(row.serverId));
        await this.publish(provider, setup, row, published, plan.records);
        if (plan.problem) throw new SubdomainProblem(SUBDOMAIN_ERRORS.private);
        await save({ status: "active", error: null, syncedAt: new Date().toISOString() });
        return null;
      } catch (error) {
        this.logger.warn(`Sous-domaine ${row.fqdn} : ${this.describe(error, setup)}.`);
        // Ce qui a été fait est gardé : un enregistrement créé avant l'échec
        // doit pouvoir être retiré ensuite. L'erreur est rendue et non levée :
        // lever défairait la transaction, et avec elle l'échec qu'on inscrit.
        await save({
          status: "error",
          error: error instanceof SubdomainProblem ? error.message : SUBDOMAIN_ERRORS.failed,
        });
        return error;
      }
    });
    if (failure) throw failure;
  }

  /**
   * L'administration a changé de zone ou de domaine : le nom déménage.
   *
   * Seulement vers une zone **vérifiée** : une faute de frappe dans le domaine
   * ou l'identifiant retirait sinon tous les noms publiés, sans pouvoir les
   * recréer. Les anciens enregistrements restent dans la liste, avec leur
   * zone, et partent une fois les nouveaux publiés.
   */
  private async move(
    tx: Pick<Database, "select" | "update">,
    row: SubdomainRow,
    setup: DnsSetup,
  ): Promise<SubdomainRow> {
    await this.verifiedZone(setup);
    const fqdn = `${row.label}.${setup.domain}`;
    const [clash] = await tx
      .select({ id: serverSubdomains.id })
      .from(serverSubdomains)
      .where(and(eq(serverSubdomains.fqdn, fqdn), ne(serverSubdomains.id, row.id)))
      .limit(1);
    const moved = {
      fqdn: clash ? row.fqdn : fqdn,
      zoneId: setup.connection.zoneId,
      provider: setup.provider.kind,
      // Nom déjà pris sous le nouveau domaine : le client en choisira un autre.
      serverId: clash ? null : row.serverId,
      abandonedBy: clash ? row.serverId : row.abandonedBy,
      status: "pending",
    };
    await tx
      .update(serverSubdomains)
      .set({ ...moved, updatedAt: new Date().toISOString() })
      .where(eq(serverSubdomains.id, row.id));
    return { ...row, ...moved };
  }

  /** Publie `desired` sous le nom et dans la zone de la ligne ; retire le reste. */
  private async publish(
    provider: DnsProvider,
    setup: DnsSetup,
    row: SubdomainRow,
    published: PublishedDnsRecord[],
    desired: DesiredRecord[],
  ): Promise<void> {
    const zoneId = row.zoneId;
    const connection = { zoneId, apiToken: setup.connection.apiToken };
    const note = noteFor(row.serverId);
    const here = (p: PublishedDnsRecord) => p.zoneId === zoneId;
    const kept = new Set(published.filter((p) => here(p) && desired.some((d) => sameRecord(p, d))));
    const toCreate: DesiredRecord[] = [];

    for (const record of desired) {
      if ([...kept].some((p) => sameRecord(p, record))) continue;
      const candidate = published.find(
        (p) => here(p) && !kept.has(p) && p.type === record.type && p.name === record.name,
      );
      if (!candidate) {
        toCreate.push(record);
        continue;
      }
      try {
        const updated = {
          ...(await provider.update(connection, candidate.id, record, note)),
          zoneId,
        };
        published[published.indexOf(candidate)] = updated;
        kept.add(updated);
      } catch (error) {
        // Retiré à la main chez le fournisseur : on le recrée.
        if (!(error instanceof DnsRefusal && error.reason === "missing")) throw error;
        published.splice(published.indexOf(candidate), 1);
        toCreate.push(record);
      }
    }

    // Même nom, autre type : à retirer avant de créer, sinon le fournisseur refuse.
    const blocking = published.filter(
      (p) => here(p) && !kept.has(p) && toCreate.some((r) => r.name === p.name),
    );
    await this.removeRecords(provider, setup, published, blocking);

    for (const record of toCreate) {
      const ours = new Set(published.map((p) => p.id));
      const named = (await provider.recordsNamed(connection, record.name)).filter(
        (existing) => !ours.has(existing.id),
      );
      // Créé par le panel pour ce serveur, mais la réponse s'est perdue (délai
      // dépassé, coupure) : il est repris, sinon le nom restait bloqué pour
      // toujours sur un enregistrement que personne ne connaissait.
      if (named.some((existing) => !isOwnRecord(existing, row.serverId))) {
        throw new SubdomainProblem(SUBDOMAIN_ERRORS.conflict);
      }
      const mine = named;
      const lost = mine.find((existing) => existing.type === record.type);
      // Les siens d'un autre type (un A perdu, puis l'adresse devenue un nom
      // d'hôte) bloqueraient la création : retirés, comme ceux de `blocking`.
      for (const stray of mine) {
        if (stray !== lost) await provider.remove(connection, stray.id);
      }
      const saved = lost
        ? await provider.update(connection, lost.id, record, note)
        : await provider.create(connection, record, note);
      const created = { ...saved, zoneId };
      published.push(created);
      kept.add(created);
    }

    await this.removeRecords(
      provider,
      setup,
      published,
      published.filter((p) => !kept.has(p)),
    );
  }

  /**
   * Retire ces enregistrements, chacun dans sa zone, et les ôte de `published`.
   *
   * Dans une zone qui n'est plus celle réglée, un refus du jeton est accepté :
   * l'administration a pu prendre un jeton limité à la nouvelle zone. Ces
   * enregistrements sont oubliés, et le journal le dit, plutôt que de laisser
   * le nom en échec pour toujours.
   */
  private async removeRecords(
    provider: DnsProvider,
    setup: DnsSetup,
    published: PublishedDnsRecord[],
    doomed: PublishedDnsRecord[],
  ): Promise<void> {
    for (const record of doomed) {
      try {
        await provider.remove(
          { zoneId: record.zoneId, apiToken: setup.connection.apiToken },
          record.id,
        );
      } catch (error) {
        const foreignZone = record.zoneId !== setup.connection.zoneId;
        if (!(foreignZone && error instanceof DnsRefusal && error.reason === "forbidden")) {
          throw error;
        }
        this.logger.warn(
          `${record.type} ${record.name} laissé dans l'ancienne zone ${record.zoneId} : le jeton n'y a plus accès.`,
        );
      }
      published.splice(published.indexOf(record), 1);
    }
  }

  /**
   * Retire, sous les noms de la ligne et dans sa zone, les enregistrements qui
   * portent la note de l'ancien serveur : ceux dont la création a abouti sans
   * que la réponse revienne. Laissés là, ils visaient pour toujours l'adresse
   * du serveur — un port qu'un autre client peut recevoir — et le nom était
   * refusé à tout autre serveur.
   *
   * Seulement pour un nom resté en échec : un nom actif n'a rien perdu, et ces
   * deux lectures pèseraient sur chaque changement.
   */
  private async removeLost(
    provider: DnsProvider,
    setup: DnsSetup,
    row: SubdomainRow,
  ): Promise<void> {
    if (!row.abandonedBy) return;
    const connection = { zoneId: row.zoneId, apiToken: setup.connection.apiToken };
    try {
      for (const name of publishableNames(row.fqdn)) {
        for (const record of await provider.recordsNamed(connection, name)) {
          if (isOwnRecord(record, row.abandonedBy)) await provider.remove(connection, record.id);
        }
      }
    } catch (error) {
      // Même règle que `removeRecords` : une ancienne zone que le jeton ne
      // touche plus est laissée, et le journal le dit.
      const foreignZone = row.zoneId !== setup.connection.zoneId;
      if (!(foreignZone && error instanceof DnsRefusal && error.reason === "forbidden")) {
        throw error;
      }
      this.logger.warn(`${row.fqdn} : ancienne zone ${row.zoneId} hors de portée du jeton.`);
    }
  }

  /** Le nom de la zone réglée, si le domaine des serveurs en fait bien partie. */
  private async verifiedZone(setup: DnsSetup): Promise<string> {
    const zone = await setup.provider.zoneName(setup.connection);
    if (!domainWithinZone(setup.domain, zone)) {
      throw new DnsRefusal(
        `Le domaine « ${setup.domain} » n'appartient pas à la zone « ${zone} ».`,
      );
    }
    return zone;
  }

  private async view(serverId: string): Promise<SubdomainView> {
    const state = await this.stateFor(serverId);
    if (!state.subdomain) throw new ConflictException("Le sous-domaine vient d'être retiré.");
    return state.subdomain;
  }

  private async targetOf(serverId: string): Promise<Target | null> {
    return (await this.targetsOf([serverId])).get(serverId) ?? null;
  }

  /** L'adresse publique et le port principal de chaque serveur, et s'il lit le SRV. */
  private async targetsOf(serverIds: string[]): Promise<Map<string, Target>> {
    if (serverIds.length === 0) return new Map();
    const rows = await this.db
      .select({
        id: servers.id,
        image: servers.dockerImage,
        startup: servers.startup,
        eggName: eggs.name,
        declared: eggs.gameQuery,
        nestName: nests.name,
        ip: allocations.ip,
        ipAlias: allocations.ipAlias,
        port: allocations.port,
        fqdn: nodes.fqdn,
      })
      .from(servers)
      .innerJoin(eggs, eq(servers.eggId, eggs.id))
      .innerJoin(nests, eq(eggs.nestId, nests.id))
      .innerJoin(nodes, eq(servers.nodeId, nodes.id))
      .innerJoin(allocations, eq(servers.allocationId, allocations.id))
      .where(inArray(servers.id, serverIds));
    return new Map(
      rows.map((row) => {
        // Même règle que la sonde : un jeu que le panel sonde en Minecraft
        // (Java, proxys compris ; Bedrock exclu) lit le SRV.
        const plan = probePlan({
          eggName: row.eggName,
          nestName: row.nestName,
          image: row.image,
          startup: row.startup,
          declared: row.declared,
          variables: {},
          port: row.port,
          ports: [row.port],
        });
        return [
          row.id,
          { host: probeHost(row), port: row.port, srv: plan?.protocol === "minecraft" },
        ];
      }),
    );
  }

  /**
   * Les réglages `dns.*`, ou `null` dès qu'il en manque un : une configuration
   * à trous appellerait le fournisseur avec un jeton vide à chaque tour.
   */
  private async configuration(): Promise<DnsSetup | null> {
    const rows = await this.db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(
        inArray(settings.key, [
          "dns.provider",
          "dns.domain",
          "dns.zoneId",
          "dns.apiToken",
          "dns.reservedLabels",
        ]),
      );
    const stored = new Map(rows.map((row) => [row.key, row.value]));
    const text = (key: string): string => {
      const raw = stored.get(key);
      return typeof raw === "string" ? raw.trim() : "";
    };

    const kind = readableDnsProvider(text("dns.provider"));
    const domain = normalizeDnsDomain(text("dns.domain"));
    const zoneId = text("dns.zoneId");
    const encrypted = text("dns.apiToken");
    if (!kind || !domain || !zoneId || !encrypted) return null;

    let apiToken: string;
    try {
      apiToken = decryptRowSecret("settings.value", "dns.apiToken", encrypted);
    } catch {
      this.logger.error("Jeton DNS illisible : les sous-domaines restent en l'état.");
      return null;
    }
    return {
      provider: this.providers[kind],
      connection: { zoneId, apiToken },
      domain,
      reserved: reservedLabels(text("dns.reservedLabels")),
    };
  }

  /** La cause d'un échec, pour le journal et l'administration, jeton masqué. */
  private describe(error: unknown, setup: DnsSetup): string {
    const message = error instanceof Error ? error.message : "cause inconnue";
    const token = setup.connection.apiToken;
    // Masqué avant d'être coupé : coupé d'abord, un jeton tronqué en fin de
    // message ne serait plus reconnu.
    return (token.length >= 8 ? message.split(token).join("[jeton]") : message).slice(0, 300);
  }
}

/** Au-delà de 10 000 serveurs suivis, oublie ceux dont le délai est passé. */
function forgetOlder(moments: Map<string, number>, now: number): void {
  if (moments.size <= 10_000) return;
  for (const [id, at] of moments) {
    if (now - at >= SUBDOMAIN_CHANGE_INTERVAL_MS) moments.delete(id);
  }
}

/**
 * La note posée sur chaque enregistrement : elle dit à l'exploitant d'où il
 * vient, et au panel qu'un enregistrement dont il a perdu la trace est le sien.
 */
function noteFor(serverId: string | null): string {
  return `GameDashboard, serveur ${serverId}`;
}

/**
 * Un enregistrement que le panel a pu créer pour ce serveur : sa note, et un
 * type que le panel publie à ce nom (A, AAAA ou CNAME au nom, SRV sous
 * `_minecraft._tcp`). Une note recopiée sur autre chose — un TXT, un MX — ne
 * suffit pas : ce n'est pas le panel qui l'a posé, il ne le reprend ni ne le
 * retire.
 */
function isOwnRecord(record: NamedRecord, serverId: string | null): boolean {
  if (record.note !== noteFor(serverId)) return false;
  const srvName = record.name.startsWith(`${MINECRAFT_SRV_PREFIX}.`);
  return srvName ? record.type === "SRV" : ["A", "AAAA", "CNAME"].includes(record.type);
}

/** Les noms que le panel peut publier pour un nom complet : le nom, et son SRV. */
function publishableNames(fqdn: string): string[] {
  return [fqdn, `${MINECRAFT_SRV_PREFIX}.${fqdn}`];
}

/**
 * Ce qu'il faut publier pour ce serveur. Une adresse non publique (réseau
 * privé, boucle locale, lien local) ne l'est pas : l'adressage interne de
 * l'hébergeur n'a rien à faire dans une zone que tout le monde lit.
 */
function wanted(
  fqdn: string,
  target: Target | null,
): { records: DesiredRecord[]; problem: "private" | null } {
  if (!target) return { records: [], problem: null };
  const hostKind = isIPv4(target.host) ? "ipv4" : isIPv6(target.host) ? "ipv6" : "name";
  if (hostKind !== "name" && isPrivateAddress(target.host)) {
    return { records: [], problem: "private" };
  }
  return {
    records: desiredRecords({
      fqdn,
      host: target.host,
      hostKind,
      port: target.port,
      srv: target.srv,
    }),
    problem: null,
  };
}

/** Tout ce qui est voulu est publié dans la zone de la ligne, et rien d'autre. */
function matches(row: SubdomainRow, desired: DesiredRecord[]): boolean {
  return (
    row.records.length === desired.length &&
    row.records.every((p) => p.zoneId === row.zoneId) &&
    desired.every((record) => row.records.some((p) => sameRecord(p, record)))
  );
}

/** Publiée sous une autre zone ou un autre domaine que ceux réglés aujourd'hui. */
function isStale(row: SubdomainRow, setup: DnsSetup): boolean {
  return (
    row.zoneId !== setup.connection.zoneId ||
    row.provider !== setup.provider.kind ||
    row.fqdn !== `${row.label}.${setup.domain}`
  );
}

function view(row: SubdomainRow, target: Target | null): SubdomainView {
  const srv = target?.srv ?? false;
  return {
    label: row.label,
    fqdn: row.fqdn,
    status: row.status as SubdomainStatus,
    error: row.status === "error" ? row.error : null,
    address: target && !srv ? `${row.fqdn}:${target.port}` : row.fqdn,
    srv,
  };
}
