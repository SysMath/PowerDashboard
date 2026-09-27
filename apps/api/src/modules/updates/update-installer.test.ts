import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "tar";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { archiveName, fetchLatestRelease, REPOSITORY_PATTERN } from "./github-releases";
import {
  cleanupVersions,
  downloadRelease,
  extractRelease,
  isReleaseFile,
  rehearse,
} from "./update-installer";
import { compareReleaseVersions } from "./update-state";

/**
 * Les gestes de la mise à jour autonome, contre un faux GitHub local et de
 * fausses versions : rien ne sort de la machine.
 */

let travail: string;
beforeEach(() => {
  travail = mkdtempSync(join(tmpdir(), "gd-maj-"));
});
afterEach(() => {
  rmSync(travail, { recursive: true, force: true });
});

/** Un faux GitHub : chaque chemin répond ce qu'on lui a confié. */
let github: Server;
let base: string;
const reponses = new Map<
  string,
  { status: number; body: string | Buffer; headers?: Record<string, string> }
>();
const requetes: { url: string; headers: Record<string, string | string[] | undefined> }[] = [];

beforeAll(async () => {
  github = createServer((requete, reponse) => {
    requetes.push({ url: requete.url ?? "", headers: requete.headers });
    const prevue = reponses.get(requete.url ?? "");
    reponse.writeHead(prevue?.status ?? 404, prevue?.headers);
    reponse.end(prevue?.body ?? "");
  });
  await new Promise<void>((pret) => github.listen(0, "127.0.0.1", pret));
  const adresse = github.address();
  base = `http://127.0.0.1:${typeof adresse === "object" && adresse ? adresse.port : 0}`;
});
afterAll(() => github.close());
afterEach(() => {
  reponses.clear();
  requetes.length = 0;
});

/** Une archive autonome réduite : lanceur, racines Passenger et une version. */
async function archive(version: string): Promise<Buffer> {
  const source = join(travail, "source");
  const dossier = join(source, "gamedashboard", "versions", version);
  mkdirSync(join(dossier, "demarrage"), { recursive: true });
  mkdirSync(join(source, "gamedashboard", "passenger", "api"), { recursive: true });
  writeFileSync(join(dossier, "RELEASE"), `version=${version}\n`);
  writeFileSync(join(dossier, "demarrage", "api.cjs"), "// api\n");
  writeFileSync(join(source, "gamedashboard", "passenger", "lanceur.cjs"), "// lanceur\n");
  writeFileSync(join(source, "gamedashboard", "passenger", "api", "app.cjs"), "// app\n");
  const fichier = join(travail, "archive.tar.gz");
  await create({ gzip: true, file: fichier, cwd: source }, ["gamedashboard"]);
  rmSync(source, { recursive: true, force: true });
  return readFileSync(fichier);
}

describe("compareReleaseVersions", () => {
  it("ordonne comme semver, préversions avant leur version", () => {
    const tri = ["v1.10.0", "v1.2.0", "v1.10.0-rc.1", "v0.9.9"].sort(compareReleaseVersions);
    expect(tri).toEqual(["v0.9.9", "v1.2.0", "v1.10.0-rc.1", "v1.10.0"]);
  });
});

describe("fetchLatestRelease", () => {
  const options = () => ({ apiBase: base, userAgent: "GameDashboard essai" });
  const chemin = "/repos/org/panel/releases/latest";

  it("trouve l'archive autonome et son empreinte parmi les fichiers de la release", async () => {
    reponses.set(chemin, {
      status: 200,
      headers: { etag: '"e1"', "content-type": "application/json" },
      body: JSON.stringify({
        tag_name: "v1.2.0",
        published_at: "2026-09-01T10:00:00Z",
        assets: [
          { name: "gamedashboard-v1.2.0.tar.gz", browser_download_url: "https://x/ordinaire" },
          { name: archiveName("v1.2.0"), browser_download_url: "https://x/autonome" },
          { name: `${archiveName("v1.2.0")}.sha256`, browser_download_url: "https://x/empreinte" },
        ],
      }),
    });
    expect(await fetchLatestRelease("org/panel", options())).toEqual({
      kind: "found",
      etag: '"e1"',
      release: {
        version: "v1.2.0",
        archiveUrl: "https://x/autonome",
        checksumUrl: "https://x/empreinte",
        publishedAt: "2026-09-01T10:00:00Z",
        repository: "org/panel",
      },
    });
  });

  describe("dépôt renommé ou transféré", () => {
    // GitHub mène l'ancien nom à l'identifiant du dépôt ; les fichiers de la
    // release portent le nom actuel.
    const redirection = () => {
      reponses.set("/repos/ancien/panel/releases/latest", {
        status: 301,
        headers: { location: `${base}/repositories/42/releases/latest` },
        body: "",
      });
      reponses.set("/repositories/42/releases/latest", {
        status: 200,
        headers: { etag: '"e2"' },
        body: JSON.stringify({
          tag_name: "v1.2.0",
          assets: [
            { name: archiveName("v1.2.0"), browser_download_url: "https://x/autonome" },
            {
              name: `${archiveName("v1.2.0")}.sha256`,
              browser_download_url: "https://x/empreinte",
            },
          ],
        }),
      });
    };

    it("suit la redirection et lit le nom actuel du dépôt par son identifiant", async () => {
      redirection();
      reponses.set("/repositories/42", {
        status: 200,
        body: JSON.stringify({ id: 42, full_name: "org/panel" }),
      });
      const lue = await fetchLatestRelease("ancien/panel", { ...options(), etag: '"e1"' });
      expect(lue).toMatchObject({
        kind: "found",
        etag: '"e2"',
        release: { repository: "org/panel" },
      });
      // L'étiquette suit la redirection : une release inchangée reste gratuite.
      expect(requetes[1]).toMatchObject({
        url: "/repositories/42/releases/latest",
        headers: { "if-none-match": '"e1"' },
      });
    });

    it("refuse un nom actuel qui ne vient pas du dépôt où mène l'ancien nom", async () => {
      redirection();
      for (const corps of [
        { id: 43, full_name: "org/panel" },
        { id: 42, full_name: "https://ailleurs/org/panel" },
        { id: 42 },
      ]) {
        reponses.set("/repositories/42", { status: 200, body: JSON.stringify(corps) });
        await expect(fetchLatestRelease("ancien/panel", options())).rejects.toThrow(
          "Nom actuel du dépôt ancien/panel illisible",
        );
      }
    });

    it("refuse une redirection vers une autre origine que l'API", async () => {
      const ailleurs = createServer((_requete, reponse) => {
        reponse.writeHead(200, { "content-type": "application/json" });
        reponse.end(
          JSON.stringify({
            tag_name: "v1.2.0",
            assets: [
              { name: archiveName("v1.2.0"), browser_download_url: "https://x/autonome" },
              {
                name: `${archiveName("v1.2.0")}.sha256`,
                browser_download_url: "https://x/empreinte",
              },
            ],
          }),
        );
      });
      await new Promise<void>((pret) => ailleurs.listen(0, "127.0.0.1", pret));
      const port = (ailleurs.address() as { port: number }).port;
      try {
        reponses.set("/repos/ancien/panel/releases/latest", {
          status: 301,
          headers: { location: `http://127.0.0.1:${port}/repositories/42/releases/latest` },
          body: "",
        });
        reponses.set("/repositories/42", {
          status: 200,
          body: JSON.stringify({ id: 42, full_name: "org/panel" }),
        });
        await expect(fetchLatestRelease("ancien/panel", options())).rejects.toThrow(
          "adresse inattendue",
        );
        // L'identifiant n'a pas été demandé à l'API.
        expect(requetes.map((r) => r.url)).not.toContain("/repositories/42");
      } finally {
        ailleurs.close();
      }
    });

    it("refuse une redirection vers autre chose qu'un dépôt", async () => {
      reponses.set("/repos/ancien/panel/releases/latest", {
        status: 302,
        headers: { location: `${base}/ailleurs/releases/latest` },
        body: "",
      });
      reponses.set("/ailleurs/releases/latest", { status: 200, body: "{}" });
      // Sans archive, la release n'est pas retenue : aucune question sur le nom.
      expect((await fetchLatestRelease("ancien/panel", options())).kind).toBe("none");

      reponses.set("/ailleurs/releases/latest", {
        status: 200,
        body: JSON.stringify({
          tag_name: "v1.2.0",
          assets: [
            { name: archiveName("v1.2.0"), browser_download_url: "https://x/autonome" },
            {
              name: `${archiveName("v1.2.0")}.sha256`,
              browser_download_url: "https://x/empreinte",
            },
          ],
        }),
      });
      await expect(fetchLatestRelease("ancien/panel", options())).rejects.toThrow(
        "adresse inattendue",
      );
    });
  });

  it("repose l'étiquette : une release inchangée ne coûte rien à la limite de GitHub", async () => {
    reponses.set(chemin, { status: 304, body: "" });
    expect(await fetchLatestRelease("org/panel", { ...options(), etag: '"e1"' })).toEqual({
      kind: "unchanged",
    });
    expect(requetes[0]?.headers["if-none-match"]).toBe('"e1"');
  });

  it("ignore une release sans archive autonome, et un dépôt sans release", async () => {
    reponses.set(chemin, {
      status: 200,
      body: JSON.stringify({ tag_name: "v1.0.0", assets: [] }),
    });
    expect((await fetchLatestRelease("org/panel", options())).kind).toBe("none");
    reponses.set(chemin, { status: 404, body: "" });
    expect((await fetchLatestRelease("org/panel", options())).kind).toBe("none");
  });
});

describe("downloadRelease", () => {
  const release = (version = "v1.2.0", depot = "org/panel") => ({
    version,
    archiveUrl: `${base}/${depot}/releases/download/${version}/${archiveName(version)}`,
    checksumUrl: `${base}/${depot}/releases/download/${version}/${archiveName(version)}.sha256`,
    publishedAt: null,
  });

  it("télécharge l'archive et la vérifie contre son empreinte", async () => {
    const contenu = await archive("v1.2.0");
    const empreinte = createHash("sha256").update(contenu).digest("hex");
    reponses.set(`/org/panel/releases/download/v1.2.0/${archiveName("v1.2.0")}`, {
      status: 200,
      body: contenu,
    });
    reponses.set(`/org/panel/releases/download/v1.2.0/${archiveName("v1.2.0")}.sha256`, {
      status: 200,
      body: `${empreinte}  ${archiveName("v1.2.0")}\n`,
    });

    const fichier = await downloadRelease(release(), join(travail, "dl"), "org/panel", base);
    expect(readFileSync(fichier)).toEqual(contenu);
  });

  it("refuse une archive qui ne correspond pas à son empreinte, et l'efface", async () => {
    reponses.set(`/org/panel/releases/download/v1.2.0/${archiveName("v1.2.0")}`, {
      status: 200,
      body: "altérée",
    });
    reponses.set(`/org/panel/releases/download/v1.2.0/${archiveName("v1.2.0")}.sha256`, {
      status: 200,
      body: `${"0".repeat(64)}  ${archiveName("v1.2.0")}\n`,
    });

    await expect(
      downloadRelease(release(), join(travail, "dl"), "org/panel", base),
    ).rejects.toThrow("ne correspond pas");
    expect(existsSync(join(travail, "dl", archiveName("v1.2.0")))).toBe(false);
  });

  it("ne télécharge rien hors des fichiers de release du dépôt configuré", async () => {
    await expect(downloadRelease(release(), join(travail, "dl"), "org/panel")).rejects.toThrow(
      "Adresse de téléchargement refusée",
    );
    // Même site, autre dépôt : refusé aussi.
    await expect(
      downloadRelease(release("v1.2.0", "autre/panel"), join(travail, "dl"), "org/panel", base),
    ).rejects.toThrow("Adresse de téléchargement refusée");
    expect(requetes).toEqual([]);
  });
});

describe("isReleaseFile", () => {
  const site = "https://github.com";
  const fichier = "releases/download/v1.2.0/gamedashboard-v1.2.0-autonome.tar.gz";

  it("accepte les fichiers de release du dépôt, quelle que soit la casse du nom", () => {
    expect(isReleaseFile(`${site}/org/panel/${fichier}`, "org/panel", site)).toBe(true);
    // GitHub ignore la casse ; GAMEDASHBOARD_DEPOT se tape à la main.
    expect(isReleaseFile(`${site}/Org/Panel/${fichier}`, "org/panel", site)).toBe(true);
    expect(isReleaseFile(`${site}/org/panel/${fichier}`, "ORG/Panel", site)).toBe(true);
  });

  it("refuse ce qui se résoudrait vers un autre dépôt", () => {
    for (const url of [
      `${site}/org/panel/releases/download/../../../autre/panel/${fichier}`,
      `${site}/org/panel/releases/download/%2e%2e/%2e%2e/%2e%2e/autre/panel/${fichier}`,
      `${site}/org/panel/releases/download/%2E%2e/%2e%2E/%2e%2e/autre/panel/${fichier}`,
      `${site}/org/panel/releases/download\\..\\..\\..\\autre/panel/${fichier}`,
      `${site}/org/panel/releases/download/v1%2f..%2f..%2f..%2fautre/x.tar.gz`,
      `${site}/org/panel-autre/${fichier}`,
      `${site}/org/panel/releases/download/`,
    ]) {
      expect(isReleaseFile(url, "org/panel", site), url).toBe(false);
    }
  });

  it("refuse une autre origine, des identifiants, une requête ou une adresse illisible", () => {
    for (const url of [
      `https://github.com.example/org/panel/${fichier}`,
      `http://github.com/org/panel/${fichier}`,
      `https://github.com:8443/org/panel/${fichier}`,
      `https://org@github.com/org/panel/${fichier}`,
      `${site}/org/panel/${fichier}?x=1`,
      `${site}/org/panel/${fichier}#x`,
      "pas une adresse",
    ]) {
      expect(isReleaseFile(url, "org/panel", site), url).toBe(false);
    }
  });

  it("n'admet ni . ni .. comme nom de dépôt", () => {
    expect(REPOSITORY_PATTERN.test("org/panel")).toBe(true);
    expect(REPOSITORY_PATTERN.test("org/.panel")).toBe(true);
    for (const nom of ["org/.", "org/..", "org", "org/panel/x", "-org/panel"]) {
      expect(REPOSITORY_PATTERN.test(nom), nom).toBe(false);
    }
  });
});

describe("extractRelease", () => {
  it("n'extrait que la version, sous son nom, sans toucher au lanceur en place", async () => {
    const fichier = join(travail, "a.tar.gz");
    writeFileSync(fichier, await archive("v1.2.0"));
    const racine = join(travail, "racine");
    mkdirSync(join(racine, "passenger"), { recursive: true });
    writeFileSync(join(racine, "passenger", "lanceur.cjs"), "// en place\n");

    const dossier = await extractRelease(fichier, racine, "v1.2.0");
    expect(dossier).toBe(join(racine, "versions", "v1.2.0"));
    expect(readFileSync(join(dossier, "RELEASE"), "utf8")).toBe("version=v1.2.0\n");
    expect(readFileSync(join(racine, "passenger", "lanceur.cjs"), "utf8")).toBe("// en place\n");
    expect(existsSync(join(racine, "versions", ".v1.2.0.partiel"))).toBe(false);
  });

  it("refuse une archive qui ne porte pas la version annoncée", async () => {
    const fichier = join(travail, "a.tar.gz");
    writeFileSync(fichier, await archive("v1.2.0"));
    const racine = join(travail, "racine");
    await expect(extractRelease(fichier, racine, "v9.9.9")).rejects.toThrow("ne contient pas");
    expect(existsSync(join(racine, "versions", "v9.9.9"))).toBe(false);
  });
});

describe("rehearse", () => {
  /**
   * Une fausse version : l'API répond sur son port si elle est bien en
   * répétition, l'interface vérifie qu'on lui a donné l'API répétée.
   */
  function version(racine: string, nom: string, { apiCassee = false } = {}) {
    const dossier = join(racine, "versions", nom, "demarrage");
    mkdirSync(dossier, { recursive: true });
    writeFileSync(
      join(dossier, "api.cjs"),
      apiCassee
        ? 'console.error("migration 0042 en échec"); process.exit(1);\n'
        : `if (process.env.GAMEDASHBOARD_ESSAI !== "1") process.exit(3);
require("node:http").createServer((q, r) => r.end(JSON.stringify({ status: "ok", database: true })))
  .listen(Number(process.env.PORT), "127.0.0.1");\n`,
    );
    writeFileSync(
      join(dossier, "interface.cjs"),
      `require("node:http").createServer(async (q, r) => {
  if (q.url === "/login") return r.end("connexion");
  const api = await fetch(process.env.API_URL + "/api/health").then((x) => x.json());
  r.end(JSON.stringify({ status: api.status }));
}).listen(Number(process.env.PORT), "127.0.0.1");\n`,
    );
  }

  it("démarre la version à part, sur des ports locaux, puis l'arrête", async () => {
    const racine = join(travail, "racine");
    version(racine, "v1.2.0");
    await expect(rehearse(racine, "v1.2.0", { timeoutMs: 20_000 })).resolves.toBeUndefined();
  });

  it("échoue avec ce que la version a écrit, quand elle ne démarre pas", async () => {
    const racine = join(travail, "racine");
    version(racine, "v1.2.0", { apiCassee: true });
    await expect(rehearse(racine, "v1.2.0", { timeoutMs: 20_000 })).rejects.toThrow(
      /arrêtée au démarrage[\s\S]*migration 0042 en échec/,
    );
  });
});

describe("cleanupVersions", () => {
  it("ne garde que la version en service et la précédente", async () => {
    const racine = join(travail, "racine");
    for (const nom of ["v1.0.0", "v1.1.0", "v1.2.0", ".v1.3.0.partiel"]) {
      mkdirSync(join(racine, "versions", nom), { recursive: true });
    }
    mkdirSync(join(racine, "telechargements"), { recursive: true });

    await cleanupVersions(racine, ["v1.2.0", "v1.1.0"]);
    expect(existsSync(join(racine, "versions", "v1.0.0"))).toBe(false);
    expect(existsSync(join(racine, "versions", ".v1.3.0.partiel"))).toBe(false);
    expect(existsSync(join(racine, "versions", "v1.1.0"))).toBe(true);
    expect(existsSync(join(racine, "versions", "v1.2.0"))).toBe(true);
    expect(existsSync(join(racine, "telechargements"))).toBe(false);
  });
});
