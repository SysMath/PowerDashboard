import { randomBytes, randomUUID } from "node:crypto";
import {
  allocations,
  type Database,
  eggs,
  serverSubdomains,
  servers,
  settings,
} from "@gamedashboard/db";
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptRowSecret } from "../../common/row-secrets";
import { type CloudflareSimule, cloudflareSimule } from "../../test/cloudflare-simule";
import { seedLocation, seedNode, seedServer, seedUser } from "../../test/fixtures";
import {
  createThrowawayDatabase,
  HAS_DATABASE,
  NO_DATABASE_REASON,
  type ThrowawayDatabase,
} from "../../test/throwaway-database";
import { CloudflareProvider } from "./providers/cloudflare.provider";
import {
  SUBDOMAIN_CHANGE_INTERVAL_MS,
  SUBDOMAIN_CHANGES_PER_MINUTE,
  SUBDOMAIN_ERRORS,
  SubdomainsService,
} from "./subdomains.service";

/** Une adresse publique de documentation (RFC 5737) : les adresses privées ne se publient pas. */
const PUBLIQUE = "203.0.113.10";

// Le jeton se range chiffré : il faut une clé maître, même d'essai.
process.env.APP_SECRET_KEY ??= randomBytes(32).toString("base64");

/**
 * Les sous-domaines, de bout en bout contre une API Cloudflare simulée : ce
 * qui est publié, ce qui suit l'adresse du serveur, et ce qui disparaît avec
 * lui — sans jamais toucher à ce que le panel n'a pas posé.
 */
describe.skipIf(!HAS_DATABASE)("SubdomainsService (intégration)", () => {
  let throwaway: ThrowawayDatabase;
  let db: Database;
  let sim: CloudflareSimule;
  let service: SubdomainsService;
  let nodeId: string;
  let ownerId: string;
  let maintenant: number;

  beforeAll(async () => {
    Logger.overrideLogger(false);
    throwaway = await createThrowawayDatabase();
    db = throwaway.db;
    ownerId = await seedUser(db);
    nodeId = await seedNode(db, { locationId: await seedLocation(db) });
  }, 60_000);

  afterAll(async () => {
    await throwaway?.drop();
  });

  beforeEach(async () => {
    await db.delete(serverSubdomains);
    await db.delete(settings);
    sim = cloudflareSimule("exemple.fr");
    service = servicePour(sim.fetch);
    await configure({
      "dns.provider": "cloudflare",
      "dns.domain": "jeux.exemple.fr",
      "dns.zoneId": sim.zoneId,
      "dns.reservedLabels": "forum",
    });
    await configure({
      "dns.apiToken": encryptRowSecret("settings.value", "dns.apiToken", sim.jeton),
    });
  });

  /** Un service qui passe par ce `fetch`, sur une horloge que le test avance. */
  function servicePour(fetcher: typeof fetch): SubdomainsService {
    const cree = new SubdomainsService(db, { cloudflare: new CloudflareProvider(fetcher) });
    maintenant = 1_000_000;
    cree.clock = () => maintenant;
    return cree;
  }

  /** Assez tard pour qu'un nouveau changement de nom soit admis. */
  function plusTard(): void {
    maintenant += SUBDOMAIN_CHANGE_INTERVAL_MS + 1;
  }

  /** Aiguille chaque requête vers la zone simulée qu'elle vise. */
  function aiguillage(...zones: CloudflareSimule[]): typeof fetch {
    return (input, init) => {
      const zone = zones.find((z) => String(input).includes(`/zones/${z.zoneId}`)) ?? zones[0];
      if (!zone) throw new Error("aucune zone");
      return zone.fetch(input, init);
    };
  }

  /** Un serveur dont le port principal écoute sur une adresse publique. */
  async function serveur(ip = PUBLIQUE): Promise<string> {
    const serverId = await seedServer(db, { nodeId, ownerId });
    await adresse(serverId, ip);
    return serverId;
  }

  async function adresse(serverId: string, ip: string): Promise<void> {
    await db
      .update(allocations)
      .set({ ip })
      .where(inArray(allocations.id, primaire(serverId)));
  }

  async function ligne(serverId: string) {
    const [row] = await db
      .select()
      .from(serverSubdomains)
      .where(eq(serverSubdomains.serverId, serverId));
    return row;
  }

  afterEach(() => {
    // Les republications repoussées ne doivent pas survivre au test.
    service.onModuleDestroy();
    vi.useRealTimers();
  });

  async function configure(values: Record<string, string>): Promise<void> {
    for (const [key, value] of Object.entries(values)) {
      await db
        .insert(settings)
        .values({ key, value, isSecret: key === "dns.apiToken" })
        .onConflictDoUpdate({ target: settings.key, set: { value } });
    }
  }

  async function minecraft(serverId: string): Promise<void> {
    await db
      .update(eggs)
      .set({ gameQuery: { protocol: "minecraft" } })
      .where(
        inArray(
          eggs.id,
          db.select({ id: servers.eggId }).from(servers).where(eq(servers.id, serverId)),
        ),
      );
  }

  function primaire(serverId: string) {
    return db.select({ id: servers.allocationId }).from(servers).where(eq(servers.id, serverId));
  }

  function publies(zone: CloudflareSimule = sim) {
    return [...zone.enregistrements.values()].map((r) => ({
      type: r.type,
      name: r.name,
      cible: r.content ?? `${r.data?.target}:${r.data?.port}`,
    }));
  }

  it("se tait tant que la zone n'est pas réglée", async () => {
    await db.delete(settings).where(eq(settings.key, "dns.apiToken"));
    const serverId = await serveur();
    await expect(service.stateFor(serverId)).resolves.toMatchObject({ available: false });
    await expect(service.claim(serverId, "survie")).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(sim.appels).toHaveLength(0);
  });

  it("publie un A pour un jeu sans SRV, et donne l'adresse avec son port", async () => {
    const serverId = await serveur();
    const view = await service.claim(serverId, "  Survie ");

    const [allocation] = await db
      .select({ port: allocations.port })
      .from(servers)
      .innerJoin(allocations, eq(servers.allocationId, allocations.id))
      .where(eq(servers.id, serverId));
    expect(view).toMatchObject({
      label: "survie",
      fqdn: "survie.jeux.exemple.fr",
      status: "active",
      srv: false,
      address: `survie.jeux.exemple.fr:${allocation?.port}`,
    });
    expect(publies()).toEqual([{ type: "A", name: "survie.jeux.exemple.fr", cible: PUBLIQUE }]);
  });

  it("ajoute le SRV de Minecraft, et le fait suivre le port principal", async () => {
    const serverId = await serveur();
    await minecraft(serverId);
    const view = await service.claim(serverId, "creatif");
    expect(view).toMatchObject({ srv: true, address: "creatif.jeux.exemple.fr" });
    const srvId = [...sim.enregistrements.values()].find((r) => r.type === "SRV")?.id;

    const [autre] = await db
      .insert(allocations)
      .values({ nodeId, ip: PUBLIQUE, port: 31_111, serverId })
      .returning({ id: allocations.id });
    if (!autre) throw new Error("port non créé");
    await db.update(servers).set({ allocationId: autre.id }).where(eq(servers.id, serverId));
    await service.refresh(serverId);

    const srv = [...sim.enregistrements.values()].find((r) => r.type === "SRV");
    // Remplacé en place : le même enregistrement, un autre port.
    expect(srv?.id).toBe(srvId);
    expect(srv?.data).toMatchObject({ port: 31_111, target: "creatif.jeux.exemple.fr" });
    expect(sim.enregistrements.size).toBe(2);
  });

  it("publie un CNAME vers la machine quand le port écoute sur toutes les interfaces", async () => {
    const serverId = await serveur();
    await adresse(serverId, "0.0.0.0");
    await service.claim(serverId, "machine");
    expect(publies()).toEqual([
      { type: "CNAME", name: "machine.jeux.exemple.fr", cible: "node.test" },
    ]);
  });

  it("refuse un nom réservé, invalide, déjà pris par un autre serveur ou déjà dans la zone", async () => {
    const serverId = await serveur();
    const autre = await serveur();
    await service.claim(autre, "pris");
    sim.poser({ type: "A", name: "site.jeux.exemple.fr", content: "198.51.100.1" });

    await expect(service.claim(serverId, "forum")).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.claim(serverId, "www")).rejects.toThrow("réservé");
    await expect(service.claim(serverId, "a.b")).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.claim(serverId, "pris")).rejects.toBeInstanceOf(ConflictException);
    await expect(service.claim(serverId, "site")).rejects.toBeInstanceOf(ConflictException);
    // L'enregistrement posé à la main n'a pas bougé.
    expect(publies()).toContainEqual({
      type: "A",
      name: "site.jeux.exemple.fr",
      cible: "198.51.100.1",
    });
  });

  it("retire l'ancien nom quand le client en choisit un autre", async () => {
    const serverId = await serveur();
    await service.claim(serverId, "ancien");
    plusTard();
    await service.claim(serverId, "nouveau");
    await vi.waitFor(() => {
      expect(publies().map((r) => r.name)).toEqual(["nouveau.jeux.exemple.fr"]);
    });
    await vi.waitFor(async () => {
      expect(await db.select().from(serverSubdomains)).toHaveLength(1);
    });
  });

  it("retire les enregistrements quand le client abandonne son nom", async () => {
    const serverId = await serveur();
    const garde = sim.poser({ type: "TXT", name: "jeux.exemple.fr", content: "v=spf1 -all" });
    await service.claim(serverId, "court");
    plusTard();
    await service.release(serverId);
    expect([...sim.enregistrements.keys()]).toEqual([garde]);
    await expect(service.stateFor(serverId)).resolves.toMatchObject({ subdomain: null });
  });

  it("fait disparaître le nom avec le serveur, même si la zone était en panne", async () => {
    const serverId = await serveur();
    await service.claim(serverId, "ephemere");
    sim.panne = true;
    await db.delete(servers).where(eq(servers.id, serverId));
    await service.sweepSoon();
    // La ligne survit à la panne : c'est elle qui sait quoi retirer.
    expect(await db.select().from(serverSubdomains)).toHaveLength(1);

    sim.panne = false;
    await service.reconcile();
    expect(sim.enregistrements.size).toBe(0);
    expect(await db.select().from(serverSubdomains)).toHaveLength(0);
  });

  it("inscrit l'échec quand la zone ne répond pas, puis rattrape au balayage", async () => {
    const serverId = await serveur();
    await service.claim(serverId, "reprise");

    sim.panne = true;
    // L'adresse change hors du panel (l'administration modifie le port).
    await adresse(serverId, "203.0.113.50");
    await service.reconcile();
    const echec = await service.stateFor(serverId);
    // Le client lit une phrase à lui, jamais celle du fournisseur.
    expect(echec.subdomain).toMatchObject({ status: "error", error: SUBDOMAIN_ERRORS.failed });
    expect(echec.subdomain?.error).not.toContain("503");

    sim.panne = false;
    await service.reconcile();
    await expect(service.stateFor(serverId)).resolves.toMatchObject({
      subdomain: { status: "active", error: null },
    });
    expect(publies()).toEqual([
      { type: "A", name: "reprise.jeux.exemple.fr", cible: "203.0.113.50" },
    ]);
  });

  it("déménage les noms quand l'administration change de domaine", async () => {
    const serverId = await serveur();
    await service.claim(serverId, "demenage");
    await configure({ "dns.domain": "play.exemple.fr" });
    await service.reconcile();
    await service.reconcile();
    expect(publies()).toEqual([{ type: "A", name: "demenage.play.exemple.fr", cible: PUBLIQUE }]);
    await expect(service.stateFor(serverId)).resolves.toMatchObject({
      subdomain: { fqdn: "demenage.play.exemple.fr", status: "active" },
    });
  });

  it("n'appelle pas Cloudflare quand tout est déjà publié comme il faut", async () => {
    const serverId = await serveur();
    await service.claim(serverId, "calme");
    const avant = sim.appels.length;
    await service.reconcile();
    expect(sim.appels).toHaveLength(avant);
  });

  it("vérifie la zone et le domaine pour l'essai de l'administration", async () => {
    await expect(service.probe()).resolves.toEqual({ ok: true, zone: "exemple.fr", error: null });
    await configure({ "dns.domain": "jeux.ailleurs.fr" });
    await expect(service.probe()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("n'appartient pas"),
    });
  });
  /** Le statut HTTP d'un refus. */
  async function statut(promise: Promise<unknown>): Promise<number | null> {
    try {
      await promise;
      return null;
    } catch (error) {
      return error instanceof HttpException ? error.getStatus() : -1;
    }
  }

  function trie(liste: { type: string; name: string; cible: string }[]) {
    return liste.map((r) => `${r.type} ${r.name} ${r.cible}`).sort();
  }

  async function portPrincipal(serverId: string): Promise<number> {
    const [row] = await db
      .select({ port: allocations.port })
      .from(servers)
      .innerJoin(allocations, eq(servers.allocationId, allocations.id))
      .where(eq(servers.id, serverId));
    if (!row) throw new Error("port absent");
    return row.port;
  }

  it("garde les noms quand l'administration ne change que l'identifiant de zone", async () => {
    // Revue B1 : la ligne se trouvait elle-même sous son propre nom, se
    // croyait doublée, et tous les noms étaient retirés.
    const neuve = cloudflareSimule("exemple.fr");
    neuve.jeton = sim.jeton;
    service = servicePour(aiguillage(sim, neuve));
    const serverId = await serveur();
    await service.claim(serverId, "garde");

    await configure({ "dns.zoneId": neuve.zoneId });
    await service.reconcile();

    expect(publies(neuve)).toEqual([{ type: "A", name: "garde.jeux.exemple.fr", cible: PUBLIQUE }]);
    expect(sim.enregistrements.size).toBe(0);
    expect(await ligne(serverId)).toMatchObject({
      fqdn: "garde.jeux.exemple.fr",
      zoneId: neuve.zoneId,
      status: "active",
    });
  });

  it("passe d'une adresse IP à un nom d'hôte, et retour, sans rester bloqué", async () => {
    // Revue B2 : le CNAME était créé avant le retrait du A, que Cloudflare
    // refuse ; le nom restait pour toujours sur l'ancienne adresse.
    const serverId = await serveur();
    await minecraft(serverId);
    const port = await portPrincipal(serverId);
    await service.claim(serverId, "bascule");

    await adresse(serverId, "0.0.0.0");
    await service.refresh(serverId);
    expect(trie(publies())).toEqual([
      "CNAME bascule.jeux.exemple.fr node.test",
      `SRV _minecraft._tcp.bascule.jeux.exemple.fr node.test:${port}`,
    ]);
    expect(await ligne(serverId)).toMatchObject({ status: "active" });

    plusTard();
    await adresse(serverId, PUBLIQUE);
    await service.refresh(serverId);
    expect(trie(publies())).toEqual([
      `A bascule.jeux.exemple.fr ${PUBLIQUE}`,
      `SRV _minecraft._tcp.bascule.jeux.exemple.fr bascule.jeux.exemple.fr:${port}`,
    ]);
    expect(await ligne(serverId)).toMatchObject({ status: "active" });
  });

  it("refuse un nom dont le SRV existe déjà dans la zone", async () => {
    // Revue B3 : seul le nom lui-même était vérifié.
    const srv = { priority: 0, weight: 5, port: 25_565, target: "mc.ailleurs.fr" };
    sim.poser({ type: "SRV", name: "_minecraft._tcp.reseau.jeux.exemple.fr", data: srv });
    const serverId = await serveur();
    await minecraft(serverId);
    await expect(service.claim(serverId, "reseau")).rejects.toBeInstanceOf(ConflictException);
    expect(sim.enregistrements.size).toBe(1);
  });

  it("ne double jamais un SRV posé à la main après coup", async () => {
    const serverId = await serveur();
    await service.claim(serverId, "tardif");
    const main = sim.poser({
      type: "SRV",
      name: "_minecraft._tcp.tardif.jeux.exemple.fr",
      data: { priority: 0, weight: 5, port: 25_565, target: "mc.ailleurs.fr" },
    });
    // L'egg devient un Minecraft : le panel voudrait publier ce SRV.
    await minecraft(serverId);
    await service.refresh(serverId);

    expect(await ligne(serverId)).toMatchObject({
      status: "error",
      error: SUBDOMAIN_ERRORS.conflict,
    });
    expect(sim.enregistrements.get(main)?.data?.target).toBe("mc.ailleurs.fr");
    expect(publies().filter((r) => r.type === "SRV")).toHaveLength(1);
  });

  it("limite les changements de nom d'un serveur", async () => {
    // Revue B4 : un client qui change de nom en boucle épuisait le quota du
    // compte Cloudflare, et plus aucun nom n'était suivi.
    const serverId = await serveur();
    await service.claim(serverId, "premier");
    expect(await statut(service.claim(serverId, "second"))).toBe(429);
    expect(await statut(service.release(serverId))).toBe(429);
    expect(publies().map((r) => r.name)).toEqual(["premier.jeux.exemple.fr"]);

    plusTard();
    await service.claim(serverId, "second");
    await vi.waitFor(() => {
      expect(publies().map((r) => r.name)).toEqual(["second.jeux.exemple.fr"]);
    });
  });

  it("refuse un nouveau nom tant que l'ancien n'est pas retiré de la zone", async () => {
    const serverId = await serveur();
    await db.insert(serverSubdomains).values({
      serverId: null,
      abandonedBy: serverId,
      label: "partant",
      fqdn: "partant.jeux.exemple.fr",
      provider: "cloudflare",
      zoneId: sim.zoneId,
    });
    expect(await statut(service.claim(serverId, "arrivant"))).toBe(429);
    await service.reconcile();
    await expect(service.claim(serverId, "arrivant")).resolves.toMatchObject({ status: "active" });
  });

  it("borne les changements de toute la plateforme", async () => {
    for (let i = 0; i < SUBDOMAIN_CHANGES_PER_MINUTE; i++) await service.release(randomUUID());
    const serverId = await serveur();
    expect(await statut(service.claim(serverId, "patient"))).toBe(429);
    plusTard();
    await expect(service.claim(serverId, "patient")).resolves.toMatchObject({ status: "active" });
  });

  it("oublie les noms d'une ancienne zone que le nouveau jeton ne peut plus toucher", async () => {
    // Revue N1 : le nom restait en échec pour toujours.
    const neuve = cloudflareSimule("exemple.fr");
    service = servicePour(aiguillage(sim, neuve));
    const serverId = await serveur();
    await service.claim(serverId, "migre");

    await configure({
      "dns.zoneId": neuve.zoneId,
      "dns.apiToken": encryptRowSecret("settings.value", "dns.apiToken", neuve.jeton),
    });
    await service.reconcile();

    expect(publies(neuve)).toEqual([{ type: "A", name: "migre.jeux.exemple.fr", cible: PUBLIQUE }]);
    const row = await ligne(serverId);
    expect(row).toMatchObject({ status: "active", zoneId: neuve.zoneId });
    expect(row?.records.map((r) => r.zoneId)).toEqual([neuve.zoneId]);
  });

  it("ne retire rien quand le nouveau domaine n'appartient pas à la zone", async () => {
    // Revue N2 : une faute de frappe retirait tous les noms publiés.
    const serverId = await serveur();
    await service.claim(serverId, "prudent");
    await configure({ "dns.domain": "jeux.exemple.com" });
    await service.reconcile();

    expect(publies()).toEqual([{ type: "A", name: "prudent.jeux.exemple.fr", cible: PUBLIQUE }]);
    expect(await ligne(serverId)).toMatchObject({
      fqdn: "prudent.jeux.exemple.fr",
      status: "error",
      error: SUBDOMAIN_ERRORS.failed,
    });
  });

  it("ne déménage pas un nom sur un enregistrement posé à la main", async () => {
    // Revue N3 : le nouveau domaine n'était pas vérifié chez le fournisseur.
    const main = sim.poser({ type: "A", name: "voisin.play.exemple.fr", content: "198.51.100.7" });
    const serverId = await serveur();
    await service.claim(serverId, "voisin");
    await configure({ "dns.domain": "play.exemple.fr" });
    await service.reconcile();

    expect(await ligne(serverId)).toMatchObject({
      status: "error",
      error: SUBDOMAIN_ERRORS.conflict,
    });
    expect(sim.enregistrements.get(main)?.content).toBe("198.51.100.7");
    // L'ancien nom répond toujours.
    expect(publies()).toContainEqual({
      type: "A",
      name: "voisin.jeux.exemple.fr",
      cible: PUBLIQUE,
    });
  });

  it("ne publie jamais une adresse privée", async () => {
    // Revue N4 : l'adressage interne de l'hébergeur finissait dans la zone publique.
    const cache = await serveur("10.0.0.5");
    await expect(service.claim(cache, "interne")).resolves.toMatchObject({
      status: "error",
      error: SUBDOMAIN_ERRORS.private,
    });
    expect(sim.enregistrements.size).toBe(0);

    const serverId = await serveur();
    await service.claim(serverId, "devient");
    await adresse(serverId, "192.168.1.4");
    await service.refresh(serverId);
    expect(sim.enregistrements.size).toBe(0);
    expect(await ligne(serverId)).toMatchObject({
      status: "error",
      error: SUBDOMAIN_ERRORS.private,
    });
  });

  it("ne laisse jamais passer le jeton dans ce que l'administration lit", async () => {
    // Revue N5 : un fournisseur qui répète le jeton dans son message.
    const bavard: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          success: false,
          errors: [
            { code: 6003, message: `Invalid request headers: Bearer ${sim.jeton}` },
            { code: 6003, message: "suite" },
          ],
          result: null,
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    service = servicePour(bavard);
    const essai = await service.probe();
    expect(essai.ok).toBe(false);
    expect(essai.error).not.toContain(sim.jeton);
    expect(essai.error).toContain("[jeton]");
  });

  it("garde l'ancien nom quand un autre serveur prend le nouveau au même instant", async () => {
    // Revue N6 : l'ancien nom était abandonné avant que l'insertion échoue.
    const serverId = await serveur();
    const autre = await serveur();
    const course: typeof fetch = async (input, init) => {
      const name = new URL(String(input)).searchParams.get("name");
      if (name === "dispute.jeux.exemple.fr") {
        await db
          .insert(serverSubdomains)
          .values({
            serverId: autre,
            label: "dispute",
            fqdn: name,
            provider: "cloudflare",
            zoneId: sim.zoneId,
          })
          .onConflictDoNothing();
      }
      return sim.fetch(input, init);
    };
    service = servicePour(course);
    await service.claim(serverId, "tenu");
    plusTard();

    await expect(service.claim(serverId, "dispute")).rejects.toBeInstanceOf(ConflictException);
    expect(await ligne(serverId)).toMatchObject({ fqdn: "tenu.jeux.exemple.fr" });
    expect(publies()).toContainEqual({ type: "A", name: "tenu.jeux.exemple.fr", cible: PUBLIQUE });
  });

  it("recrée un enregistrement retiré à la main chez le fournisseur", async () => {
    // Revue N7 : la modification en place tombait sur un 404, pour toujours.
    const serverId = await serveur();
    await service.claim(serverId, "retabli");
    sim.enregistrements.clear();
    await adresse(serverId, "203.0.113.60");
    await service.refresh(serverId);
    expect(publies()).toEqual([
      { type: "A", name: "retabli.jeux.exemple.fr", cible: "203.0.113.60" },
    ]);
    expect(await ligne(serverId)).toMatchObject({ status: "active" });
  });
  it("compte un nom refusé par la zone avant d'appeler Cloudflare", async () => {
    // Revue V2-B1 : seuls les changements réussis comptaient ; un nom que la
    // zone porte déjà coûtait deux requêtes par essai, sans aucune limite.
    sim.poser({ type: "A", name: "hub.jeux.exemple.fr", content: "198.51.100.9" });
    const serverId = await serveur();
    const statuts: (number | null)[] = [];
    for (let i = 0; i < 20; i++) statuts.push(await statut(service.claim(serverId, "hub")));
    expect(statuts[0]).toBe(409);
    expect(statuts.slice(1).every((code) => code === 429)).toBe(true);
    // Le nom et son SRV, une seule fois.
    expect(sim.appels).toHaveLength(2);
  });

  it("ne republie pas à chaque bascule du port principal, mais suit la dernière", async () => {
    // Revue V2-B2 : vingt bascules faisaient vingt appels à Cloudflare.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const serverId = await serveur();
    await minecraft(serverId);
    await service.claim(serverId, "bascules");
    await service.refresh(serverId);
    const avant = sim.appels.length;

    for (const port of [31_201, 31_202, 31_203]) {
      const [autre] = await db
        .insert(allocations)
        .values({ nodeId, ip: PUBLIQUE, port, serverId })
        .returning({ id: allocations.id });
      if (!autre) throw new Error("port non créé");
      await db.update(servers).set({ allocationId: autre.id }).where(eq(servers.id, serverId));
      await service.refresh(serverId);
    }
    expect(sim.appels).toHaveLength(avant);

    // À la fin du délai, une seule republication, vers le dernier port.
    maintenant += SUBDOMAIN_CHANGE_INTERVAL_MS;
    await vi.advanceTimersByTimeAsync(SUBDOMAIN_CHANGE_INTERVAL_MS);
    await vi.waitFor(() => {
      const srv = [...sim.enregistrements.values()].find((r) => r.type === "SRV");
      expect(srv?.data?.port).toBe(31_203);
    });
    expect(sim.appels.filter((a) => a.method === "PUT")).toHaveLength(1);
  });

  it("reprend un enregistrement créé dont la réponse s'est perdue", async () => {
    // Revue V2-C3 : l'enregistrement devenait « étranger », et le nom restait
    // pour toujours en erreur « nom déjà employé ».
    service = servicePerdant();
    const serverId = await serveur();
    await expect(service.claim(serverId, "perdu")).resolves.toMatchObject({ status: "error" });
    expect(sim.enregistrements.size).toBe(1);

    await service.reconcile();
    const row = await ligne(serverId);
    expect(row).toMatchObject({ status: "active", error: null });
    expect(row?.records.map((r) => r.id)).toEqual([...sim.enregistrements.keys()]);
    expect(publies()).toEqual([{ type: "A", name: "perdu.jeux.exemple.fr", cible: PUBLIQUE }]);
  });

  it("reprend les noms du panel copiés dans une zone recréée", async () => {
    // Revue V2-F2 : zone déplacée avec ses enregistrements (import, changement
    // de compte) ; chaque nom tombait en erreur « nom déjà employé ».
    const neuve = cloudflareSimule("exemple.fr");
    neuve.jeton = sim.jeton;
    service = servicePour(aiguillage(sim, neuve));
    const serverId = await serveur();
    await service.claim(serverId, "copie");
    for (const record of sim.enregistrements.values()) {
      const { id: _id, ttl: _ttl, ...copie } = record;
      neuve.poser(copie);
    }

    await configure({ "dns.zoneId": neuve.zoneId });
    await service.reconcile();
    expect(await ligne(serverId)).toMatchObject({ status: "active", zoneId: neuve.zoneId });
    expect(publies(neuve)).toEqual([{ type: "A", name: "copie.jeux.exemple.fr", cible: PUBLIQUE }]);
  });

  it("ne refait rien à chaque tour pour une adresse privée déjà signalée", async () => {
    // Revue V2-F4 : la ligne était reprise, et journalisée, toutes les 5 minutes.
    const serverId = await serveur("10.0.0.8");
    await service.claim(serverId, "prive");
    const avant = await ligne(serverId);
    await service.reconcile();
    expect((await ligne(serverId))?.updatedAt).toBe(avant?.updatedAt);
  });

  it("masque un jeton répété en fin d'un long message", async () => {
    // Revue V2-F5 : coupé avant d'être masqué, le jeton sortait tronqué.
    service = servicePour(
      async () =>
        new Response(
          JSON.stringify({
            success: false,
            errors: [{ code: 6003, message: `${"x".repeat(190)} ${sim.jeton}` }],
            result: null,
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    );
    const essai = await service.probe();
    expect(essai.error).not.toContain(sim.jeton.slice(0, 8));
  });
  /** Un service dont la première création aboutit chez Cloudflare, mais sans réponse. */
  function servicePerdant(): SubdomainsService {
    let perdre = true;
    return servicePour(async (input, init) => {
      const response = await sim.fetch(input, init);
      if (init?.method === "POST" && perdre) {
        perdre = false;
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
      return response;
    });
  }

  it("retire l'enregistrement perdu quand le client abandonne son nom avant le balayage", async () => {
    // Revue V3-C1 : la ligne effacée, l'enregistrement restait pour toujours,
    // vers l'adresse du serveur, et le nom était refusé à tout autre serveur.
    service = servicePerdant();
    const serverId = await serveur();
    await expect(service.claim(serverId, "orphelin")).resolves.toMatchObject({ status: "error" });
    expect(sim.enregistrements.size).toBe(1);

    plusTard();
    await service.release(serverId);
    expect(sim.enregistrements.size).toBe(0);
    expect(await db.select().from(serverSubdomains)).toHaveLength(0);
    const autre = await serveur();
    plusTard();
    await expect(service.claim(autre, "orphelin")).resolves.toMatchObject({ status: "active" });
  });

  it("retire l'enregistrement perdu de l'ancien nom quand le client en change", async () => {
    service = servicePerdant();
    const serverId = await serveur();
    await service.claim(serverId, "premier");
    plusTard();
    await service.claim(serverId, "second");
    await vi.waitFor(() => {
      expect(publies().map((r) => r.name)).toEqual(["second.jeux.exemple.fr"]);
    });
  });

  it("retire l'enregistrement perdu d'un serveur supprimé", async () => {
    service = servicePerdant();
    const serverId = await serveur();
    await service.claim(serverId, "supprime");
    await db.transaction(async (tx) => {
      await service.departing(tx, serverId);
      await tx.delete(servers).where(eq(servers.id, serverId));
    });
    await service.sweepSoon();
    expect(sim.enregistrements.size).toBe(0);
    expect(await db.select().from(serverSubdomains)).toHaveLength(0);
  });

  it("reprend au choix du nom un enregistrement qui porte la note du serveur", async () => {
    // Revue V3-C2 : un enregistrement du panel que la base ne connaît plus
    // (base restaurée d'une sauvegarde, zone recréée avec ses copies) ne doit
    // pas refuser son propre nom au serveur.
    const serverId = await serveur();
    const retrouve = sim.poser({
      type: "A",
      name: "retrouve.jeux.exemple.fr",
      content: "198.51.100.30",
      comment: `GameDashboard, serveur ${serverId}`,
    });
    await expect(service.claim(serverId, "retrouve")).resolves.toMatchObject({ status: "active" });
    expect([...sim.enregistrements.keys()]).toEqual([retrouve]);
    expect(publies()).toEqual([{ type: "A", name: "retrouve.jeux.exemple.fr", cible: PUBLIQUE }]);
    // La note d'un autre serveur, elle, reste un refus.
    const autre = await serveur();
    sim.poser({
      type: "A",
      name: "voisin.jeux.exemple.fr",
      content: "198.51.100.31",
      comment: `GameDashboard, serveur ${autre}`,
    });
    plusTard();
    await expect(service.claim(serverId, "voisin")).rejects.toBeInstanceOf(ConflictException);
  });

  it("retire un enregistrement à lui d'un autre type qui bloquerait le nouveau", async () => {
    // Revue V3-F2 : un A perdu, puis l'adresse devenue un nom d'hôte ; le
    // CNAME voulu restait refusé à côté d'un A qui était pourtant le sien.
    const serverId = await serveur("0.0.0.0");
    sim.poser({
      type: "A",
      name: "mixte.jeux.exemple.fr",
      content: PUBLIQUE,
      comment: `GameDashboard, serveur ${serverId}`,
    });
    await expect(service.claim(serverId, "mixte")).resolves.toMatchObject({ status: "active" });
    expect(publies()).toEqual([
      { type: "CNAME", name: "mixte.jeux.exemple.fr", cible: "node.test" },
    ]);
  });
});

if (!HAS_DATABASE) console.warn(NO_DATABASE_REASON);
