import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConflictException } from "@nestjs/common";
import { create } from "tar";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityService } from "../activity/activity.service";
import { archiveName } from "./github-releases";
import { UpdateService } from "./update.service";
import { readState, writeState } from "./update-state";

/**
 * La mise à jour autonome de bout en bout, contre un faux GitHub, une fausse
 * adresse publique et de fausses versions qui démarrent pour de vrai.
 */

type Reponse = { status: number; body: string | Buffer; headers?: Record<string, string> };

function fauxServeur() {
  const reponses = new Map<string, Reponse | (() => Reponse)>();
  const requetes: { url: string; headers: Record<string, string | string[] | undefined> }[] = [];
  const serveur: Server = createServer((requete, reponse) => {
    requetes.push({ url: requete.url ?? "", headers: requete.headers });
    const prevue = reponses.get(requete.url ?? "");
    const r = typeof prevue === "function" ? prevue() : prevue;
    reponse.writeHead(r?.status ?? 404, r?.headers);
    reponse.end(r?.body ?? "");
  });
  return {
    reponses,
    requetes,
    serveur,
    async demarrer(): Promise<string> {
      await new Promise<void>((pret) => serveur.listen(0, "127.0.0.1", pret));
      const adresse = serveur.address();
      return `http://127.0.0.1:${typeof adresse === "object" && adresse ? adresse.port : 0}`;
    },
  };
}

const github = fauxServeur();
const publique = fauxServeur();
let baseGithub: string;
let basePublique: string;
let etatPublic: "ok" | "panne" = "ok";

beforeAll(async () => {
  baseGithub = await github.demarrer();
  basePublique = await publique.demarrer();
  publique.reponses.set("/api/health", () =>
    etatPublic === "ok"
      ? { status: 200, body: JSON.stringify({ status: "ok" }) }
      : { status: 502, body: "" },
  );
});
afterAll(() => {
  github.serveur.close();
  publique.serveur.close();
});

let travail: string;
let racine: string;
const activite = { record: vi.fn(async () => {}) };

beforeEach(() => {
  travail = mkdtempSync(join(tmpdir(), "gd-maj-service-"));
  racine = join(travail, "gamedashboard");
  mkdirSync(join(racine, "versions", "v1.0.0", "demarrage"), { recursive: true });
  vi.stubEnv("GAMEDASHBOARD_RACINE", racine);
  vi.stubEnv("GAMEDASHBOARD_VERSION", "v1.0.0");
  vi.stubEnv("GAMEDASHBOARD_DEPOT", "org/panel");
  vi.stubEnv("GAMEDASHBOARD_GITHUB_API", baseGithub);
  vi.stubEnv("GAMEDASHBOARD_TELECHARGEMENTS", baseGithub);
  vi.stubEnv("GAMEDASHBOARD_ESSAI", "");
  vi.stubEnv("PANEL_ORIGIN", basePublique);
  etatPublic = "ok";
});
afterEach(() => {
  vi.unstubAllEnvs();
  activite.record.mockClear();
  github.reponses.clear();
  github.requetes.length = 0;
  rmSync(travail, { recursive: true, force: true });
});

function service(): UpdateService {
  const s = new UpdateService(activite as unknown as ActivityService);
  s.confirmationMs = 2_000;
  s.pauseMs = 100;
  return s;
}

/**
 * Publie une release sur le faux GitHub. La version répète avec succès, ou
 * s'arrête en écrivant une migration en échec.
 */
async function publier(version: string, { casse = false } = {}) {
  const source = join(travail, `source-${version}`);
  const demarrage = join(source, "gamedashboard", "versions", version, "demarrage");
  mkdirSync(demarrage, { recursive: true });
  writeFileSync(
    join(demarrage, "api.cjs"),
    casse
      ? 'console.error("migration 0050 en échec"); process.exit(1);\n'
      : `require("node:http").createServer((q, r) => r.end(JSON.stringify({ status: "ok", database: true })))
  .listen(Number(process.env.PORT), "127.0.0.1");\n`,
  );
  writeFileSync(
    join(demarrage, "interface.cjs"),
    `require("node:http").createServer((q, r) => r.end(q.url === "/login" ? "connexion" : JSON.stringify({ status: "ok" })))
  .listen(Number(process.env.PORT), "127.0.0.1");\n`,
  );
  writeFileSync(join(demarrage, "lanceur.cjs"), `// lanceur de ${version}\n`);
  const fichier = join(travail, archiveName(version));
  await create({ gzip: true, file: fichier, cwd: source }, ["gamedashboard"]);
  const contenu = readFileSync(fichier);
  const empreinte = createHash("sha256").update(contenu).digest("hex");

  const chemin = `/org/panel/releases/download/${version}/${archiveName(version)}`;
  github.reponses.set(chemin, { status: 200, body: contenu });
  github.reponses.set(`${chemin}.sha256`, {
    status: 200,
    body: `${empreinte}  ${archiveName(version)}\n`,
  });
  github.reponses.set("/repos/org/panel/releases/latest", {
    status: 200,
    headers: { etag: `"${version}"` },
    body: JSON.stringify({
      tag_name: version,
      assets: [
        { name: archiveName(version), browser_download_url: `${baseGithub}${chemin}` },
        {
          name: `${archiveName(version)}.sha256`,
          browser_download_url: `${baseGithub}${chemin}.sha256`,
        },
      ],
    }),
  });
}

const telechargements = () => github.requetes.filter((r) => r.url.endsWith(".tar.gz")).length;

describe("UpdateService", () => {
  it("reste inerte hors d'un hébergement autonome", async () => {
    vi.stubEnv("GAMEDASHBOARD_RACINE", "");
    const s = service();
    expect(s.status()).toEqual({ actif: false });
    await s.check();
    expect(github.requetes).toEqual([]);
  });

  it("installe une release plus récente : répétition, bascule, relance demandée", async () => {
    await publier("v1.1.0");
    await service().check();

    const etat = readState(racine);
    expect(etat).toMatchObject({
      enService: "v1.1.0",
      precedente: "v1.0.0",
      bascule: { version: "v1.1.0", confirmee: false },
      operation: null,
    });
    expect(existsSync(join(racine, "versions", "v1.1.0", "demarrage", "api.cjs"))).toBe(true);
    for (const role of ["api", "interface"]) {
      expect(existsSync(join(racine, "passenger", role, "tmp", "restart.txt"))).toBe(true);
    }
  });

  it("met de côté une version qui échoue à la répétition, sans rien basculer", async () => {
    await publier("v1.1.0", { casse: true });
    const s = service();
    await s.check();

    const etat = readState(racine);
    expect(etat.enService).toBe("v1.0.0");
    expect(etat.refusees).toEqual(["v1.1.0"]);
    expect(etat.dernierResultat).toMatchObject({ etat: "refusee", version: "v1.1.0" });
    expect(etat.dernierResultat?.message).toContain("migration 0050 en échec");
    expect(existsSync(join(racine, "versions", "v1.1.0"))).toBe(false);
    expect(activite.record).toHaveBeenCalledWith(
      expect.objectContaining({ event: "admin.update_refused", actorType: "system" }),
    );

    // Mise de côté : jamais retéléchargée.
    await s.check();
    expect(telechargements()).toBe(1);
  });

  /*
   * Les hébergements installés depuis la v1.0.1 portent l'ancien nom du dépôt
   * (depot=PowerNexus/PowerDashboard) : GitHub redirige, mais les fichiers de
   * la release portent le nom actuel, et chaque archive était refusée
   * (« Adresse de téléchargement refusée »), à chaque vérification.
   */
  it("installe depuis un dépôt renommé, sous son nom actuel lu chez GitHub", async () => {
    vi.stubEnv("GAMEDASHBOARD_DEPOT", "ancien/panel");
    await publier("v1.1.0");
    github.reponses.set("/repos/ancien/panel/releases/latest", {
      status: 301,
      headers: { location: `${baseGithub}/repositories/42/releases/latest` },
      body: "",
    });
    const publiee = github.reponses.get("/repos/org/panel/releases/latest");
    if (publiee) github.reponses.set("/repositories/42/releases/latest", publiee);
    github.reponses.set("/repositories/42", {
      status: 200,
      body: JSON.stringify({ id: 42, full_name: "org/panel" }),
    });

    await service().check();
    const etat = readState(racine);
    expect(etat.dernierResultat).toBeUndefined();
    expect(etat).toMatchObject({ enService: "v1.1.0", bascule: { version: "v1.1.0" } });
    expect(telechargements()).toBe(1);
  });

  it("ne cherche rien sans dépôt connu, et le dit à l'administration", async () => {
    for (const depot of ["", "PowerDashboard"]) {
      vi.stubEnv("GAMEDASHBOARD_DEPOT", depot);
      await service().check();
      expect(github.requetes).toEqual([]);
      expect(readState(racine).dernierResultat).toMatchObject({
        etat: "erreur",
        message: expect.stringContaining("Dépôt des releases inconnu"),
      });
    }
  });

  it("ne touche à rien quand la dernière release n'est pas plus récente", async () => {
    await publier("v1.0.0");
    await service().check();
    expect(telechargements()).toBe(0);
    expect(readState(racine).enService).toBe("v1.0.0");
  });

  it("repose l'étiquette de GitHub à la vérification suivante", async () => {
    await publier("v1.0.0");
    const s = service();
    await s.check();
    await s.check();
    const lectures = github.requetes.filter((r) => r.url.endsWith("/releases/latest"));
    expect(lectures.at(-1)?.headers["if-none-match"]).toBe('"v1.0.0"');
  });

  describe("confirmation par la nouvelle version", () => {
    function basculee() {
      mkdirSync(join(racine, "versions", "v1.1.0", "demarrage"), { recursive: true });
      mkdirSync(join(racine, "versions", "v0.9.0"), { recursive: true });
      mkdirSync(join(racine, "passenger"), { recursive: true });
      writeFileSync(join(racine, "versions", "v1.1.0", "demarrage", "lanceur.cjs"), "// neuf\n");
      writeFileSync(join(racine, "passenger", "lanceur.cjs"), "// ancien\n");
      writeState(racine, {
        enService: "v1.1.0",
        precedente: "v1.0.0",
        bascule: { version: "v1.1.0", depuis: new Date().toISOString(), confirmee: false },
      });
      vi.stubEnv("GAMEDASHBOARD_VERSION", "v1.1.0");
    }
    const confirmer = (s: UpdateService) =>
      (s as unknown as { confirmIfPending(): Promise<void> }).confirmIfPending();

    it("confirme quand l'adresse publique répond, et prend son lanceur", async () => {
      basculee();
      await confirmer(service());

      expect(readState(racine)).toMatchObject({
        enService: "v1.1.0",
        precedente: "v1.0.0",
        bascule: null,
        dernierResultat: { etat: "installee", version: "v1.1.0" },
      });
      expect(readFileSync(join(racine, "passenger", "lanceur.cjs"), "utf8")).toBe("// neuf\n");
      expect(existsSync(join(racine, "versions", "v0.9.0"))).toBe(false);
      expect(existsSync(join(racine, "versions", "v1.0.0"))).toBe(true);
    });

    it("revient à la précédente et se met de côté quand elle ne répond pas", async () => {
      basculee();
      etatPublic = "panne";
      await confirmer(service());

      expect(readState(racine)).toMatchObject({
        enService: "v1.0.0",
        precedente: null,
        bascule: null,
        refusees: ["v1.1.0"],
        dernierResultat: { etat: "refusee", version: "v1.1.0" },
      });
      expect(readFileSync(join(racine, "passenger", "lanceur.cjs"), "utf8")).toBe("// ancien\n");
    });
  });

  describe("signal du workflow de release", () => {
    const SECRET = "s".repeat(40);
    const signer = (horodatage: string, version: string, secret = SECRET) =>
      `sha256=${createHmac("sha256", secret).update(`${horodatage}.${version}`).digest("hex")}`;
    const maintenant = () => String(Math.floor(Date.now() / 1000));

    it("accepte un signal signé et récent, qui lance une vérification", async () => {
      vi.stubEnv("GAMEDASHBOARD_SIGNAL_SECRET", SECRET);
      const s = service();
      const verification = vi.spyOn(s, "check").mockResolvedValue();
      const t = maintenant();
      expect(s.signal(t, "v1.1.0", signer(t, "v1.1.0"))).toBe(true);
      expect(verification).toHaveBeenCalledOnce();
    });

    it("refuse une mauvaise signature, un signal ancien, et tout signal sans secret", () => {
      vi.stubEnv("GAMEDASHBOARD_SIGNAL_SECRET", SECRET);
      const s = service();
      const t = maintenant();
      expect(s.signal(t, "v1.1.0", signer(t, "v1.1.0", "x".repeat(40)))).toBe(false);
      expect(s.signal(t, "v1.1.0", signer(t, "v9.9.9"))).toBe(false);
      const ancien = String(Math.floor(Date.now() / 1000) - 3600);
      expect(s.signal(ancien, "v1.1.0", signer(ancien, "v1.1.0"))).toBe(false);

      vi.stubEnv("GAMEDASHBOARD_SIGNAL_SECRET", "");
      expect(s.signal(t, "v1.1.0", signer(t, "v1.1.0"))).toBe(false);
    });
  });

  describe("retour demandé par l'administration", () => {
    it("revient à la précédente et met de côté la version quittée", () => {
      mkdirSync(join(racine, "versions", "v0.9.0"), { recursive: true });
      writeState(racine, { enService: "v1.0.0", precedente: "v0.9.0" });
      const etat = service().rollback();

      expect(etat).toMatchObject({ actif: true, enService: "v0.9.0", precedente: null });
      expect(readState(racine).refusees).toEqual(["v1.0.0"]);
      expect(existsSync(join(racine, "passenger", "api", "tmp", "restart.txt"))).toBe(true);
    });

    it("refuse quand il n'y a pas de version précédente", () => {
      writeState(racine, { enService: "v1.0.0" });
      expect(() => service().rollback()).toThrow(ConflictException);
    });
  });
});
