import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Le vhost de production doit démarrer sur une machine **neuve**.
 *
 * `panel.conf` a été écrit sur une machine partagée qui déclarait déjà, pour
 * d'autres sites, un `map $http_upgrade $req_connection` et un fichier
 * `snippets/tls/tls-intermediate.conf`. Il s'en servait sans les apporter :
 * sur toute autre machine, `nginx -t` refusait la configuration et
 * `deploy.sh` s'arrêtait à l'étape nginx — c'est-à-dire à la dernière, après
 * dix minutes de construction.
 *
 * Ce contrôle refuse une variable nginx qui ne soit ni native ni déclarée
 * dans le fichier, et un `include` que le dépôt ne livre pas.
 */

const RACINE = join(import.meta.dirname, "..", "..", "..", "..");
const PROD = join(RACINE, "infra", "prod");
const vhost = readFileSync(join(PROD, "panel.conf"), "utf8");
const deploy = readFileSync(join(PROD, "deploy.sh"), "utf8");

/** Sans les commentaires : ils citent l'ancien nom de variable, à dessein. */
const directives = vhost
  .split("\n")
  .map((ligne) => ligne.replace(/#.*$/, ""))
  .join("\n");

/** Les variables que nginx fournit lui-même, parmi celles que ce vhost lit. */
const NATIVES = new Set([
  "server_name",
  "request_uri",
  "remote_addr",
  "binary_remote_addr",
  "proxy_add_x_forwarded_for",
  "scheme",
  "http_upgrade",
]);

describe("infra/prod/panel.conf", () => {
  it("ne lit aucune variable déclarée ailleurs sur la machine", () => {
    const declarees = new Set(
      [...directives.matchAll(/^\s*map\s+\$\w+\s+\$(\w+)/gm)].map((m) => m[1] ?? ""),
    );
    const lues = new Set([...directives.matchAll(/\$(\w+)/g)].map((m) => m[1] ?? ""));
    const inconnues = [...lues].filter((v) => !NATIVES.has(v) && !declarees.has(v));
    expect(inconnues).toEqual([]);
  });

  // Régression (Semgrep) : `$host` est l'en-tête Host du client, et relayer
  // tout `Upgrade` ouvre la contrebande h2c. Même règle pour la production
  // locale.
  it("ne relaie ni le Host du client ni un Upgrade autre que websocket", () => {
    const local = readFileSync(
      join(RACINE, "infra", "local", "gamedashboard.local.conf"),
      "utf8",
    ).replace(/#.*$/gm, "");
    for (const texte of [directives, local]) {
      expect(texte).not.toMatch(/\$(http_)?host\b/);
      expect(texte).not.toMatch(/proxy_set_header\s+Upgrade\s+\$http_upgrade/);
      expect(texte).toMatch(/~\*\^websocket\$\s+websocket;/);
    }
  });

  it("ne déclare que des variables à son préfixe, pour ne heurter aucun autre vhost", () => {
    const declarees = [...directives.matchAll(/^\s*map\s+\$\w+\s+\$(\w+)/gm)].map(
      (m) => m[1] ?? "",
    );
    expect(declarees.length).toBeGreaterThan(0);
    for (const nom of declarees) expect(nom).toMatch(/^gd_/);
  });

  it("n'inclut que des fichiers que le dépôt livre et que deploy.sh pose", () => {
    const inclus = [...directives.matchAll(/^\s*include\s+([^;]+);/gm)].map((m) =>
      (m[1] ?? "").trim(),
    );
    expect(inclus.length).toBeGreaterThan(0);
    for (const chemin of inclus) {
      const nom = chemin.split("/").at(-1) ?? chemin;
      expect(existsSync(join(PROD, nom)), `${nom} manque dans infra/prod`).toBe(true);
      expect(deploy, `deploy.sh ne pose pas ${chemin}`).toContain(`/etc/nginx/${chemin}`);
    }
  });

  it("reste accepté par le nginx de Debian 12 et d'Ubuntu 24.04", () => {
    // `http2 on;` date de nginx 1.25.1 ; ces distributions livrent 1.22 et
    // 1.24. deploy.sh doit la réécrire en `listen … http2` pour elles.
    if (/^\s*http2 on;/m.test(directives)) {
      expect(deploy).toContain("1.25.1");
      expect(deploy).toContain("http2 on;");
    }
  });

  /*
   * En-têtes de transport (ASVS 14.4.5, 14.3.3). HSTS couvrait le seul nom du
   * panel : un sous-domaine en HTTP restait une porte vers une page servie en
   * clair sous son nom. `preload`, lui, ne se retire pas en un redéploiement :
   * absent à dessein.
   */
  it("impose HTTPS aux sous-domaines, sans s'inscrire à la liste de préchargement", () => {
    const hsts = /add_header Strict-Transport-Security "([^"]+)" always;/.exec(directives)?.[1];
    expect(hsts).toBeDefined();
    expect(hsts).toMatch(/max-age=31536000/);
    expect(hsts).toContain("includeSubDomains");
    expect(hsts).not.toContain("preload");
  });

  it("ne donne sa version de nginx dans aucune réponse", () => {
    const serveurs = directives.split(/^server \{/m).slice(1);
    expect(serveurs.length).toBe(2);
    for (const bloc of serveurs) expect(bloc).toMatch(/^\s*server_tokens off;/m);
  });

  it("ne pose pas d'agrafage OCSP sans répondeur, et dit pourquoi", () => {
    // Let's Encrypt n'inscrit plus d'adresse OCSP dans ses certificats :
    // `ssl_stapling on` n'y produirait qu'un avertissement au démarrage.
    expect(directives).not.toMatch(/ssl_stapling/);
    expect(vhost).toMatch(/OCSP/);
  });

  it("ne porte que le nom d'exemple, que deploy.sh remplace par le domaine réel", () => {
    const noms = [...directives.matchAll(/server_name\s+([^;]+);/g)].map((m) =>
      (m[1] ?? "").trim(),
    );
    expect(new Set(noms)).toEqual(new Set(["panel.example.fr"]));
    expect(deploy).toContain("EXEMPLE=panel.example.fr");
    expect(deploy).not.toMatch(/^DOMAIN=panel\.example\.fr$/m);
  });
});

/**
 * Le jeton du lien de facturation n'entre dans aucun journal d'accès (NC-57).
 *
 * Il voyage dans le chemin (`/sso/<jeton>`) et ouvre une session : écrit dans
 * le journal d'accès, il se lisait par quiconque lit les journaux, pendant les
 * deux minutes où il vaut une session. Les trois vhosts qui servent
 * l'interface sont concernés : celui de la plateforme, celui de la production
 * locale, et celui des domaines de revendeurs, où atterrissent leurs clients.
 *
 * Un bloc `location` à expression régulière remplace `location /` pour ces
 * chemins : il doit donc relayer les mêmes en-têtes d'identité, faute de quoi
 * la page recevrait l'adresse de nginx et le mauvais domaine.
 */
describe("jeton du lien de facturation", () => {
  const vhosts = {
    "infra/prod/panel.conf": vhost,
    "infra/local/gamedashboard.local.conf": readFileSync(
      join(RACINE, "infra", "local", "gamedashboard.local.conf"),
      "utf8",
    ),
    "infra/prod/certificates.sh (domaine de revendeur)": (() => {
      const agent = readFileSync(join(PROD, "certificates.sh"), "utf8");
      const debut = agent.indexOf("bloc_servi()");
      return agent.slice(debut, agent.indexOf("\nEOF", debut)).replaceAll("\\$", "$");
    })(),
  };

  /**
   * Le corps d'un bloc `location`, sans commentaires ni imbrication.
   *
   * Le dernier du fichier : le serveur HTTPS vient après celui du port 80, dont
   * le `location /` ne fait que rediriger.
   */
  function bloc(conf: string, entete: string): string | null {
    const sansCommentaires = conf.replace(/#.*$/gm, "");
    const debut = sansCommentaires.lastIndexOf(`location ${entete} {`);
    if (debut < 0) return null;
    return sansCommentaires.slice(debut, sansCommentaires.indexOf("}", debut));
  }

  const entetes = (corps: string) =>
    [...corps.matchAll(/proxy_set_header\s+([\w-]+)\s+([^;]+);/g)]
      .map((m) => `${m[1]} ${(m[2] ?? "").trim()}`)
      .filter((ligne) => !/^(Upgrade|Connection) /.test(ligne))
      .sort();

  for (const [chemin, conf] of Object.entries(vhosts)) {
    it(`${chemin} ne journalise pas /sso/<jeton>`, () => {
      const sso = bloc(conf, "~ ^/sso/");
      expect(sso, "aucun bloc location ~ ^/sso/").not.toBeNull();
      expect(sso).toMatch(/^\s*access_log off;/m);
      expect(sso).toMatch(/proxy_pass http:\/\/127\.0\.0\.1:(3210|\$PANEL_WEB_PORT);/);
    });

    it(`${chemin} relaie à /sso/ les mêmes en-têtes que l'interface`, () => {
      expect(entetes(bloc(conf, "~ ^/sso/") ?? "")).toEqual(entetes(bloc(conf, "/") ?? ""));
    });
  }
});

/**
 * La production locale limite comme le modèle (NC-49, ASVS 2.2.1).
 *
 * `infra/local/gamedashboard.local.conf` sert la seule installation réelle
 * (`gamedashboard.local`), et n'avait **aucune** limitation : ni sur les
 * écrans de connexion, ni sur l'API applicative, ni sur les routes du daemon.
 * Les limites posées dans `panel.conf` — le modèle — ne protégeaient donc que
 * les installations à venir. Chaque bloc limité du modèle doit l'être à
 * l'identique ici, avec les mêmes zones.
 *
 * Le HSTS, lui, reste volontairement absent de la production locale : il
 * enfermerait le navigateur sur un certificat de développement (commentaire
 * du fichier).
 */
describe("limites de la production locale", () => {
  const local = readFileSync(join(RACINE, "infra", "local", "gamedashboard.local.conf"), "utf8")
    .split("\n")
    .map((ligne) => ligne.replace(/#.*$/, ""))
    .join("\n");

  /** Les blocs `location` qui portent une limite, et la ligne qui la pose. */
  function limites(conf: string): Map<string, string> {
    const blocs = new Map<string, string>();
    for (const m of conf.matchAll(/location\s+([^{]+?)\s*\{([^}]*)\}/g)) {
      const limite = /limit_req\s+zone=[^;]+;/.exec(m[2] ?? "")?.[0];
      if (limite) blocs.set((m[1] ?? "").trim(), limite.replace(/\s+/g, " "));
    }
    return blocs;
  }

  const zones = (conf: string) =>
    [...conf.matchAll(/^limit_req_zone .+;$/gm)].map((m) => m[0].replace(/\s+/g, " ")).sort();

  it("déclare les mêmes zones que le modèle", () => {
    expect(zones(directives).length).toBeGreaterThan(0);
    expect(zones(local)).toEqual(zones(directives));
  });

  it("limite chaque bloc que le modèle limite, à l'identique", () => {
    const modele = limites(directives);
    expect(modele.size).toBeGreaterThan(0);
    expect(Object.fromEntries(limites(local))).toEqual(Object.fromEntries(modele));
  });

  it("répond 429 aux navigateurs, 503 au daemon, et tait sa version", () => {
    const https = local.slice(local.indexOf("listen 443"));
    expect(https).toMatch(/^\s*limit_req_status 429;/m);
    expect(/location \/api\/remote\/ \{([^}]*)\}/.exec(local)?.[1]).toMatch(
      /^\s*limit_req_status 503;/m,
    );
    expect(local.match(/^\s*server_tokens off;/gm)).toHaveLength(2);
  });
});

/**
 * Les routes du daemon sont limitées, sans gêner Wings (NC-49).
 *
 * `/api/remote/` était le seul préfixe exposé sans `limit_req` : un jeton
 * éprouvé en boucle, ou un node qui s'emballe, payait chaque requête en
 * lecture de base. La limite doit pourtant laisser passer le trafic légitime
 * d'un daemon — l'inventaire paginé en parallèle à son démarrage, une
 * configuration relue par serveur démarré, le journal d'activité par lots —
 * et surtout **ne pas lui répondre 429** : Wings abandonne sur tout 4xx et
 * ne rejoue que les 5xx. Un compte rendu de sauvegarde refusé en 429 lui
 * ferait effacer l'archive ; en 503, il réessaie quelques secondes plus tard.
 */
describe("limitation des routes du daemon", () => {
  const bloc = /location \/api\/remote\/ \{([^}]*)\}/.exec(directives)?.[1] ?? "";

  it("pose une limite par adresse sur /api/remote/", () => {
    expect(bloc).not.toBe("");
    expect(bloc).toMatch(/^\s*limit_req\s+zone=gd_remote\s/m);
    expect(directives).toMatch(/^limit_req_zone \$binary_remote_addr zone=gd_remote:/m);
  });

  it("laisse passer le démarrage d'un node chargé", () => {
    const rate = /zone=gd_remote:\S+\s+rate=(\d+)r\/s;/.exec(directives)?.[1];
    const burst = /limit_req\s+zone=gd_remote\s+burst=(\d+)\s+nodelay;/.exec(bloc)?.[1];
    // Des dizaines de serveurs démarrés d'un coup, plus l'inventaire paginé :
    // plusieurs centaines de requêtes en rafale, puis un débit soutenu.
    expect(Number(rate)).toBeGreaterThanOrEqual(10);
    expect(Number(burst)).toBeGreaterThanOrEqual(200);
  });

  it("refuse en 503, que Wings rejoue, et non en 429, qu'il abandonne", () => {
    expect(bloc).toMatch(/^\s*limit_req_status\s+503;/m);
  });
});

/**
 * Le contrôle de fin de livraison reconnaît l'écran d'erreur à son titre.
 *
 * Chaque page embarque le catalogue de traductions, où ce titre figure en
 * JSON (`"genericTitle":"Une erreur est survenue"`). Cherché seul, il se
 * trouvait donc dans **toutes** les pages : chaque livraison était déclarée
 * en échec à sa dernière étape. Seul le texte rendu, entre deux balises,
 * désigne l'écran d'erreur.
 */
describe("contrôle des pages après livraison", () => {
  const catalogue = JSON.parse(
    readFileSync(join(RACINE, "packages", "i18n", "src", "messages", "fr.json"), "utf8"),
  ) as { errorPage: { genericTitle: string } };
  const titre = catalogue.errorPage.genericTitle;
  const scripts = {
    "infra/prod/deploy.sh": deploy,
    "infra/local/install.sh": readFileSync(join(RACINE, "infra", "local", "install.sh"), "utf8"),
  };

  for (const [chemin, contenu] of Object.entries(scripts)) {
    it(`${chemin} cherche le titre rendu, pas le texte du catalogue`, () => {
      const recherches = [...contenu.matchAll(/grep -q "([^"]*)" "\$corps"/g)].map(
        (m) => m[1] ?? "",
      );
      const surErreur = recherches.filter((motif) => motif.includes(titre));
      expect(surErreur).toEqual([`>${titre}<`]);
    });
  }
});

/**
 * Les commandes d'exploitation vivent sous `app:`.
 *
 * pnpm fait passer ses propres commandes avant les scripts du projet. Un
 * script `setup` n'était donc jamais lancé par `pnpm setup` : pnpm réglait à
 * la place son dossier global et modifiait le `.bashrc`, sans rien dire du
 * panel. `restart` enchaîne de même d'autres scripts au lieu de lancer le
 * sien.
 */
describe("commandes app: du package.json", () => {
  const paquet = JSON.parse(readFileSync(join(RACINE, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const app = readFileSync(join(PROD, "app.sh"), "utf8");

  /** Commandes de pnpm qui l'emportent sur un script du même nom. */
  const INTEGREES = [
    "add",
    "audit",
    "bin",
    "config",
    "create",
    "deploy",
    "dlx",
    "env",
    "exec",
    "fetch",
    "i",
    "import",
    "init",
    "install",
    "link",
    "list",
    "ls",
    "outdated",
    "pack",
    "patch",
    "prune",
    "publish",
    "rebuild",
    "remove",
    "restart",
    "rm",
    "root",
    "setup",
    "store",
    "unlink",
    "update",
    "why",
  ];

  it("aucun script ne porte le nom d'une commande de pnpm", () => {
    const captes = Object.keys(paquet.scripts).filter((nom) => INTEGREES.includes(nom));
    expect(captes).toEqual([]);
  });

  const commandes = Object.entries(paquet.scripts).filter(([nom]) => nom.startsWith("app:"));

  it("les commandes d'installation et de pilotage existent", () => {
    const noms = commandes.map(([nom]) => nom);
    for (const attendu of ["app:install", "app:setup", "app:start", "app:stop", "app:help"]) {
      expect(noms).toContain(attendu);
    }
  });

  for (const [nom, script] of commandes) {
    const action = nom.slice("app:".length);
    it(`${nom} passe par app.sh, qui la traite et la documente`, () => {
      expect(script).toBe(`bash infra/prod/app.sh ${action}`);
      expect(app).toMatch(new RegExp(`^\\s*${action}(\\s*\\|[^)]*)?\\)`, "m"));
      expect(app).toContain(`pnpm ${nom}`);
    });
  }
});

/**
 * La ligne de commande s'exécute sans le dépôt.
 *
 * `curl …/gamedashboard.sh | sudo bash -s -- install` lit app.sh seul, sans
 * dossier autour : tout fichier du dépôt qu'il lirait par un chemin relatif
 * manquerait. Il ne doit donc en atteindre qu'à travers un dossier qu'il a
 * lui-même résolu ou téléchargé — et il doit être publié à chaque version.
 */
describe("CLI autonome (gamedashboard.sh)", () => {
  const app = readFileSync(join(PROD, "app.sh"), "utf8");
  const code = app
    .split("\n")
    .filter((ligne) => !/^\s*#/.test(ligne))
    .join("\n");

  it("n'atteint un fichier du dépôt qu'à travers un dossier résolu", () => {
    const chemins = [...code.matchAll(/(\S*)\/?(infra\/[\w./-]+)/g)];
    expect(chemins.length).toBeGreaterThan(0);
    for (const [, prefixe] of chemins) {
      expect(prefixe).toMatch(/^"?\$(RACINE|DOSSIER|depuis)\/?$/);
    }
    expect(code).not.toMatch(/^\s*(source|\.)\s/m);
  });

  it("est publiée à chaque version, empreinte comprise, et attestée", () => {
    const assembler = readFileSync(join(RACINE, "infra", "release", "assembler.sh"), "utf8");
    expect(assembler).toContain('infra/prod/app.sh "$SORTIE/gamedashboard.sh"');
    expect(assembler).toContain("sha256sum gamedashboard.sh");
    const release = readFileSync(join(RACINE, ".github", "workflows", "release.yml"), "utf8");
    expect(release).toContain("dist/gamedashboard.sh");
  });

  it("vérifie l'empreinte de tout ce qu'elle télécharge", () => {
    // Tout fichier écrit par curl l'est dans telecharger(), qui vérifie
    // ensuite l'un par l'autre : le fichier et son empreinte.
    const ecrits = [...code.matchAll(/curl [^\n]*-o "([^"]+)"/g)].map((m) => m[1]);
    expect(ecrits).toEqual(["$dossier/$nom", "$dossier/$nom.sha256"]);
    expect(code).toContain('sha256sum -c --quiet "$nom.sha256"');
  });
});

/**
 * La sauvegarde d'exploitation contient `env/`, donc `APP_SECRET_KEY` : elle
 * s'écrivait en clair, un `.tar` en 600 que l'on copie ensuite ailleurs (ASVS
 * 8.1, 14.1). Elle se chiffre désormais, sans rien demander — `update` la
 * prend sans terminal — et reste restaurable par la commande du runbook.
 */
describe("sauvegarde d'exploitation (app.sh backup)", () => {
  const app = readFileSync(join(PROD, "app.sh"), "utf8");
  /** Le corps d'une fonction du script ; vide si elle n'existe pas. */
  const fonction = (nom: string) => {
    const debut = app.indexOf(`${nom}() {`);
    return debut < 0 ? "" : app.slice(debut, app.indexOf("\n}\n", debut));
  };
  const sauvegarder = fonction("sauvegarder");
  const cle = fonction("cle_sauvegarde");
  const runbook = readFileSync(join(RACINE, "docs", "runbooks", "restauration-base.md"), "utf8");

  it("n'écrit l'archive qu'à travers le chiffrement", () => {
    expect(sauvegarder).toContain('fichier="$SAUVEGARDES/gamedashboard-$horodatage.tar.enc"');
    expect(sauvegarder).toMatch(/tar -cf - -C "\$temp" \. \| openssl enc -e "\$\{CHIFFRE\[@\]\}"/);
    expect(sauvegarder).not.toMatch(/tar -cf "\$fichier"/);
  });

  it("lit sa clé dans un fichier hors de env/, jamais sur la ligne de commande", () => {
    const chemin = /^CLE_SAUVEGARDE=\$\{GD_CLE_SAUVEGARDE:-([^}]+)\}$/m.exec(app)?.[1];
    expect(chemin).toBeDefined();
    // env/ est dans l'archive : une clé rangée là s'y chiffrerait elle-même.
    expect(chemin).not.toContain("/env");
    expect(sauvegarder).toContain('-pass "file:$CLE_SAUVEGARDE"');
    // `pass:` et `env:` la montreraient à `ps`, ou à l'environnement du processus.
    expect(app).not.toMatch(/-pass "?(pass|env):/);
    expect(app).toMatch(/--preserve-env=\S*GD_CLE_SAUVEGARDE/);
  });

  it("tire la clé sans rien demander, et ne remplace jamais une clé existante", () => {
    expect(sauvegarder).toContain("cle_sauvegarde");
    expect(cle).toMatch(/if \[ ! -s "\$CLE_SAUVEGARDE" \]/);
    expect(cle).toMatch(/umask 077 && openssl rand/);
    expect(cle).toContain('chmod 600 "$CLE_SAUVEGARDE"');
    // Le seul `read` admis lit la liste des anciennes archives, pas le clavier.
    const lectures = `${sauvegarder}\n${cle}`.replace(/\| while read -r \w+; do/g, "");
    expect(lectures).not.toMatch(/\bread\b|\/dev\/tty/);
  });

  it("se déchiffre par la commande du runbook de restauration", () => {
    const chiffre = /^CHIFFRE=\(([^)]+)\)$/m.exec(app)?.[1];
    expect(chiffre).toMatch(/^-aes-256-cbc -pbkdf2 -iter \d{6,} -md sha256$/);
    expect(runbook).toContain(`openssl enc -d ${chiffre} -pass file:`);
  });
});

/**
 * Le 19 mars 2026, 76 des 77 tags de `aquasecurity/trivy-action` ont été
 * réécrits vers un voleur de secrets (GHSA, correctif 0.35.0). Un tag se
 * réécrit, une empreinte de commit non : toute action tierce est épinglée
 * par empreinte, la version lisible reste en commentaire pour Renovate.
 */
describe("actions GitHub des workflows", () => {
  const dossier = join(RACINE, ".github", "workflows");
  const workflows = ["ci.yml", "release.yml", "captures.yml", "codeql.yml"].map((nom) =>
    readFileSync(join(dossier, nom), "utf8"),
  );
  const actions = workflows.flatMap((texte) =>
    [...texte.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map((m) => m[1] as string),
  );

  it("sont toutes épinglées par empreinte de commit", () => {
    const tierces = actions.filter((action) => !action.startsWith("./"));
    expect(tierces.length).toBeGreaterThan(0);
    for (const action of tierces) {
      expect(action).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
    }
  });

  it("prennent n'importe quel runner auto-hébergé, sauf choix contraire dans CI_RUNNER", () => {
    const cibles = workflows.flatMap((texte) =>
      [...texte.matchAll(/^\s*runs-on:\s*(.+)$/gm)].map((m) => m[1]),
    );
    expect(cibles.length).toBe(6);
    for (const cible of cibles) {
      expect(cible).toBe(`\${{ fromJSON(vars.CI_RUNNER || '"self-hosted"') }}`);
    }
    // Git Bash, et non PowerShell, le shell par défaut de Windows.
    for (const texte of workflows) {
      expect(texte).toMatch(/^defaults:\n {2}run:\n {4}shell: bash\n/m);
    }
  });

  /*
   * GitHub Actions ne lance ni `services:` ni action conteneur sur un runner
   * Windows : chaque job travaille dans son conteneur Linux
   * (infra/ci/linux.sh), qu'il ouvre et qu'il rend, même en échec.
   */
  it("travaillent dans un conteneur Linux qu'ils rendent toujours", () => {
    const jobs = workflows.flatMap((texte) =>
      [...texte.matchAll(/^ {2}(\w+):\n(?: {4}.*\n|\n)*/gm)]
        .map(([bloc]) => bloc)
        .filter((bloc) => bloc.includes("runs-on:")),
    );
    expect(jobs.length).toBe(6);
    for (const bloc of jobs) {
      // Régression : le service du runner ne trouvait pas bash (« bash:
      // command not found » dès la première étape). Le bash de Git est posé
      // dans le PATH, en PowerShell, avant toute étape en bash.
      const premiere = bloc.indexOf("    steps:\n") + "    steps:\n".length;
      const chemin = bloc.indexOf("- name: Bash de Git et Docker");
      expect(chemin).toBeGreaterThan(0);
      expect(bloc.slice(premiere, chemin)).not.toMatch(/^ {6}- /m);
      // Régression : la stratégie d'exécution refusait le script (« l'exécution
      // de scripts est désactivée sur ce système »).
      expect(bloc.slice(chemin)).toMatch(
        /^ {8}shell: powershell .*-ExecutionPolicy Bypass .*\{0\}/m,
      );
      expect(bloc).toContain("$env:GITHUB_PATH");
      expect(bloc).toContain("run: git config --global core.autocrlf false");
      expect(bloc).toMatch(/run: bash infra\/ci\/linux\.sh ouvrir/);
      expect(bloc).toMatch(
        /- name: Rendre la machine du runner\n {8}if: always\(\)\n {8}run: bash infra\/ci\/linux\.sh fermer/,
      );
      expect(bloc).not.toMatch(/^ {4}(services|container):/m);
      expect(bloc).not.toContain("actions/setup-node@");
    }
  });

  it("ne tombent pas pour un quota d'artefacts atteint", () => {
    const envois = workflows.flatMap((texte) =>
      [...texte.matchAll(/^( +)- name: .+\n(?:\1 {2}.*\n)*/gm)]
        .map(([etape]) => etape)
        .filter((etape) => etape.includes("actions/upload-artifact@")),
    );
    expect(envois.length).toBe(3);
    for (const etape of envois) {
      expect(etape).toContain("continue-on-error: true");
    }
  });

  it("ne lancent jamais le code d'une PR venue d'un fork", () => {
    const [ci] = workflows as [string];
    const jobs = [...ci.matchAll(/^ {2}(\w+):\n(?: {4}.*\n|\n)*/gm)].filter(([bloc]) =>
      bloc.includes("runs-on:"),
    );
    expect(jobs.length).toBe(3);
    for (const [bloc] of jobs) {
      expect(bloc).toContain(
        "if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository",
      );
    }
  });

  /*
   * Régression : le job de vérification ouvrait son conteneur sans base, et
   * les tests d'intégration (plus de 300) s'y sautaient, la CI restant verte.
   */
  it("jouent les tests d'intégration contre une vraie base", () => {
    const [ci] = workflows as [string];
    const debut = ci.indexOf("  verify:\n");
    const bloc = ci.slice(debut, ci.indexOf("\n  audit:\n", debut));
    const ouverture = bloc.indexOf("run: bash infra/ci/linux.sh ouvrir --postgres");
    const tests = bloc.indexOf("- name: Tests\n");
    expect(ouverture).toBeGreaterThan(0);
    expect(tests).toBeGreaterThan(ouverture);
    const etape = bloc.slice(tests, bloc.indexOf("\n\n", tests));
    expect(etape).toContain('[ -n "$' + '{DATABASE_URL:-}" ] || {');
    expect(etape.indexOf("exit 1")).toBeLessThan(etape.indexOf("pnpm test"));
  });

  it("lèvent la seconde preuve du personnel sur la base d'essai, avant la suite", () => {
    // Exigée par défaut (NC-10), et le compte d'essai est administrateur : sans
    // cette étape, chaque écran d'administration visité par la suite serait
    // l'explication « seconde preuve exigée », captures comprises.
    const [ci, , captures] = workflows as [string, string, string];
    for (const [nom, texte] of [
      ["ci.yml", ci],
      ["captures.yml", captures],
    ] as const) {
      const levee = texte.indexOf("values ('security.staffRequires2fa', 'false'::jsonb)");
      const suite = texte.search(/'pnpm e2e'|playwright test/);
      expect(levee, nom).toBeGreaterThan(0);
      expect(suite, nom).toBeGreaterThan(levee);
    }
  });

  /*
   * Sans `permissions:`, le jeton du workflow reçoit les droits par défaut du
   * dépôt — écriture comprise selon son réglage — et ci.yml le tendait à
   * Semgrep, conteneur root, sur une machine à nous. La lecture seule se pose
   * en tête ; un job qui a besoin de plus le déclare lui-même, avec sa raison.
   */
  it("ne donnent au jeton que la lecture du dépôt, en tête de chaque workflow", () => {
    for (const [nom, texte] of ["ci.yml", "release.yml", "captures.yml", "codeql.yml"].map(
      (fichier, rang) => [fichier, workflows[rang] ?? ""] as const,
    )) {
      expect(texte, nom).toMatch(/^permissions:\n {2}contents: read\n\n/m);
    }
  });

  /*
   * Les outils tournent en conteneur, d'images épinglées par empreinte : un
   * tag se réécrit (trivy-action, mars 2026), une empreinte non.
   */
  it("n'emploient que des images épinglées par empreinte", () => {
    const outils = readFileSync(join(RACINE, "infra", "ci", "outils.env"), "utf8");
    const linux = readFileSync(join(RACINE, "infra", "ci", "linux.sh"), "utf8");
    const images = [...`${outils}\n${linux}`.matchAll(/^IMAGE_\w+=(.+)$/gm)].map((m) => m[1]);
    expect(images.length).toBe(4);
    for (const image of images) {
      expect(image).toMatch(/^[\w./-]+@sha256:[0-9a-f]{64} # \S+$/);
    }
    // Trivy 0.74 et au-delà : bien après le correctif de l'incident (0.35.0).
    expect(outils).toMatch(
      /^IMAGE_TRIVY=aquasec\/trivy@sha256:[0-9a-f]{64} # 0\.(7[4-9]|[89]\d)\./m,
    );
    const texte = workflows.join("\n");
    expect(texte).not.toContain("trivy-action@");
    expect(texte).not.toContain("semgrep-action@");
  });

  // Régression : sans store-dir, pnpm posait son store dans /w/.pnpm-store,
  // perdu à chaque job (tout retéléchargé) et lu par Trivy et Semgrep.
  // Régression (Semgrep) : un nom de branche interpolé dans un script `run:`
  // s'y exécute comme du code.
  it("n'interpolent aucune donnée de branche dans un script", () => {
    const scripts = workflows.flatMap((texte) =>
      [...texte.matchAll(/^( +)run: \|\n((?:\1 {2}.*\n|\n)*)/gm)].map((m) => m[2] ?? ""),
    );
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      expect(script).not.toMatch(/\$\{\{\s*github\.(ref|head_ref|ref_name|event)\b/);
    }
  });

  /*
   * Régression : la « configuration par défaut » de CodeQL réclamait un
   * runner hébergé (`ubuntu-latest`) et n'a jamais tourné ; aucun scanner ne
   * lisait le TypeScript. codeql.yml l'analyse sur notre runner, dans le
   * conteneur du job, avec un CLI épinglé par empreinte.
   */
  it("analysent le TypeScript et les workflows avec CodeQL, sur notre runner", () => {
    const codeql = workflows[3] as string;
    expect(codeql).toContain(
      "if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository",
    );
    expect(codeql).toMatch(/^ {6}security-events: write$/m);
    expect(codeql).toContain(
      "run: bash infra/ci/linux.sh lancer 'bash infra/ci/codeql.sh codeql-resultats'",
    );
    // Un envoi par langage : deux analyses de même catégorie dans un envoi
    // sont refusées.
    for (const langage of ["javascript", "actions"]) {
      expect(codeql).toContain(`sarif_file: codeql-resultats/${langage}.sarif`);
      expect(codeql).toContain(`category: /language:${langage}`);
    }
    // Jamais `init`/`analyze`, qui tourneraient directement sur Windows.
    expect(codeql).not.toMatch(/codeql-action\/(init|analyze|autobuild)@/);

    const outils = readFileSync(join(RACINE, "infra", "ci", "outils.env"), "utf8");
    expect(outils).toMatch(/^CODEQL_VERSION=\d+\.\d+\.\d+$/m);
    expect(outils).toMatch(/^CODEQL_SHA256=[0-9a-f]{64} # codeql-bundle-linux64\.tar\.gz$/m);
    const script = readFileSync(join(RACINE, "infra", "ci", "codeql.sh"), "utf8");
    // L'archive est vérifiée avant d'être extraite.
    expect(script.indexOf("sha256sum -c")).toBeGreaterThan(0);
    expect(script.indexOf("tar -xzf")).toBeGreaterThan(script.indexOf("sha256sum -c"));
    expect(script).toContain("--build-mode=none");
    expect(script).toContain("langages=(javascript-typescript actions)");
  });

  /*
   * Régression (revue de #50) : le cache de CodeQL était monté en écriture
   * dans le conteneur de tous les jobs, y compris ceux qui exécutent le code
   * des dépendances, et le CLI extrait n'était vérifié qu'au téléchargement ;
   * le checkout laissait le jeton du job (security-events: write) dans
   * .git/config, copié dans le conteneur avec le dépôt.
   */
  it("ne laissent au job CodeQL rien qu'un autre job aurait pu changer", () => {
    const codeql = workflows[3] as string;
    const linux = readFileSync(join(RACINE, "infra", "ci", "linux.sh"), "utf8");
    // Le volume n'est monté que sur demande, et seul codeql.yml la fait.
    expect(linux).toContain('if [ "$codeql" = 1 ]; then options+=(-v gd-ci-codeql:/codeql); fi');
    expect(linux.match(/gd-ci-codeql/g)?.length).toBe(1);
    expect(codeql).toContain("run: bash infra/ci/linux.sh ouvrir --codeql\n");
    for (const texte of workflows.slice(0, 3)) {
      expect(texte).not.toContain("--codeql");
    }
    // Aucun CLI gardé tout prêt : l'archive du cache est revérifiée à chaque
    // job, puis extraite hors du cache, dans le conteneur.
    const script = readFileSync(join(RACINE, "infra", "ci", "codeql.sh"), "utf8");
    const code = script.replace(/^\s*#.*$/gm, "");
    expect(code).toMatch(/^if ! verifier "\$archive"; then$/m);
    expect(code).toMatch(/^outils=\$\(mktemp -d\)\ntar -xzf "\$archive" -C "\$outils"$/m);
    expect(code).toContain("codeql=$outils/codeql/codeql");
    expect(code).not.toMatch(/-x "\$racine|mv [^\n]*\/codeql\/[0-9]/);
    // Pas de jeton dans le dépôt copié.
    expect(codeql).toMatch(
      /- uses: actions\/checkout@[0-9a-f]{40} # v[\d.]+\n {8}with:\n {10}persist-credentials: false\n/,
    );
  });

  /*
   * Régression (#50, runner) : « Query evaluation ran out of Java heap (Java
   * heap (and arrays) maximum: 673 MiB) », code 99. Sans `--ram`, le CLI part
   * du tas par défaut de sa JVM, le quart de la mémoire vue, relevé à 2 Gio :
   * dans la machine virtuelle de Docker Desktop, 1,1 Go de tas pour 24 fils.
   * L'évaluateur reçoit désormais la mémoire du conteneur, moins la réserve
   * de l'action officielle de CodeQL ; le calcul est rendu par bash à partir
   * du script, sur des machines d'essai.
   */
  it("donnent à l'évaluateur de CodeQL la mémoire du conteneur", () => {
    const chemin = join(RACINE, "infra", "ci", "codeql.sh");
    const code = readFileSync(chemin, "utf8").replace(/^\s*#.*$/gm, "");
    expect(code).toMatch(/^ram=\$\(memoire_evaluateur ""\)$/m);
    const analyses = code.match(/database analyze .*$/gm) ?? [];
    expect(analyses.length).toBe(1);
    expect(analyses[0]).toContain('--ram="$ram"');

    const memoire = (meminfoKo: number, cgroup: { v2?: string; v1?: string } = {}) => {
      const racine = mkdtempSync(join(tmpdir(), "gd-memoire-"));
      try {
        const sys = join(racine, "sys", "fs", "cgroup");
        mkdirSync(join(racine, "proc"));
        mkdirSync(join(sys, "memory"), { recursive: true });
        writeFileSync(join(racine, "proc", "meminfo"), `MemTotal:       ${meminfoKo} kB\n`);
        if (cgroup.v2) writeFileSync(join(sys, "memory.max"), `${cgroup.v2}\n`);
        if (cgroup.v1) {
          writeFileSync(join(sys, "memory", "memory.limit_in_bytes"), `${cgroup.v1}\n`);
        }
        const sortie = execFileSync(
          "bash",
          [
            "-c",
            `set -euo pipefail; source <(sed -n '/^memoire_evaluateur()/,/^}$/p' "$1"); memoire_evaluateur "$2"`,
            "rendu",
            chemin,
            racine,
          ],
          { encoding: "utf8" },
        );
        return Number(sortie.trim());
      } finally {
        rmSync(racine, { recursive: true, force: true });
      }
    };
    const gio = 1024 * 1024;
    // Machine virtuelle de 8 Gio sans limite : 1 Gio pour le système, et non
    // plus le plancher de 2 Gio du CLI.
    expect(memoire(8 * gio, { v2: "max" })).toBe(7168);
    // Au-delà de 8 Gio, 5 % de l'excédent en plus.
    expect(memoire(16 * gio, { v2: "max" })).toBe(16384 - 1024 - 409);
    // La limite du conteneur l'emporte sur la machine (cgroup v2, puis v1).
    expect(memoire(16 * gio, { v2: String(4 * 1024 ** 3) })).toBe(3072);
    expect(memoire(16 * gio, { v1: String(6 * 1024 ** 3) })).toBe(5120);
    // « Pas de limite » en v1 est un nombre géant : la machine compte.
    expect(memoire(8 * gio, { v1: "9223372036854771712" })).toBe(7168);
  });

  // Un conteneur laissé par un job tué empêchait Docker de se mettre en veille.
  it("marquent leurs conteneurs et retirent ceux qu'un job tué a laissés", () => {
    const linux = readFileSync(join(RACINE, "infra", "ci", "linux.sh"), "utf8");
    expect(linux).toMatch(/^ {2}balayer$/m);
    expect(linux).toContain('ETIQUETTES=(--label gd-ci --label "gd-ci.job=$NOM")');
    expect(linux).toContain(`--name "$NOM" "\${ETIQUETTES[@]}"`);
    expect(linux).toContain(`--name "$BASE" "\${ETIQUETTES[@]}"`);
    expect(linux).toContain("docker ps -aq --filter label=gd-ci");
    // Régression : des dizaines de conteneurs restaient sur le runner. Les
    // outils lancés avec --rm survivent à un job annulé : étiquetés, et
    // retirés par `fermer` ; les conteneurs arrêtés, balayés tout de suite.
    expect(linux).toContain(`docker run --rm "\${ETIQUETTES[@]}"`);
    expect(linux).toContain('docker ps -aq --filter "label=gd-ci.job=$NOM"');
    expect(linux).toContain("--filter status=exited");
    const zap = readFileSync(join(RACINE, "infra", "ci", "zap-baseline.sh"), "utf8");
    expect(zap).toContain('ETIQUETTES=(--label gd-ci --label "gd-ci.job=$CONTENEUR")');
    // Les caches ne sont jamais balayés.
    expect(linux).not.toMatch(/volume prune/);
  });

  // « No build cache found » : Next recompilait tout à chaque job.
  it("gardent le cache de build de Next d'un job à l'autre", () => {
    const linux = readFileSync(join(RACINE, "infra", "ci", "linux.sh"), "utf8");
    expect(linux).toContain("-v gd-ci-next-cache:/w/apps/web/.next/cache");
    expect(linux).toContain("-v gd-ci-next-autonome-cache:/w/apps/web/.next-autonome/cache");
    // Jamais dans l'archive publiée.
    const assembler = readFileSync(join(RACINE, "infra", "release", "assembler.sh"), "utf8");
    expect(assembler).toContain("--exclude=.next/cache");
  });

  it("gardent le store pnpm sur le volume de cache, hors du dépôt", () => {
    const linux = readFileSync(join(RACINE, "infra", "ci", "linux.sh"), "utf8");
    expect(linux).toContain("-v gd-ci-pnpm-store:/pnpm-store");
    expect(linux).toContain("-e pnpm_config_store_dir=/pnpm-store");
    // `pnpm config set --global` échoue sans dossier bin global dans le PATH.
    expect(linux).not.toContain("pnpm config set --global");
  });
});

/**
 * Chaque release publie l'inventaire de ce qu'elle livre (PLAN §5.4), signé et
 * rattaché à l'archive.
 */
describe("inventaire des dépendances des releases", () => {
  const release = readFileSync(join(RACINE, ".github", "workflows", "release.yml"), "utf8");
  const inventaire = `dist/gamedashboard-\${{ env.VERSION }}.cdx.json`;
  const etape = (nom: string) => {
    const debut = release.indexOf(`- name: ${nom}`);
    expect(debut, nom).toBeGreaterThan(0);
    return { debut, texte: release.slice(debut, release.indexOf("\n\n", debut)) };
  };

  it("est produit au format CycloneDX, dans les fichiers publiés", () => {
    const { texte } = etape("Inventaire des dépendances (SBOM)");
    expect(texte).toContain('linux.sh outil "$IMAGE_TRIVY" fs --format cyclonedx');
    expect(texte).toContain('--output "dist/gamedashboard-$VERSION.cdx.json"');
    expect(release.indexOf("- name: Rapatrier l'archive")).toBeGreaterThan(
      release.indexOf("- name: Inventaire des dépendances (SBOM)"),
    );
    // Les licences se lisent dans node_modules : l'exclure les ferait disparaître.
    expect(texte).not.toMatch(/skip-dirs:.*node_modules/);
  });

  it("est attesté contre l'archive, avant la publication", () => {
    const production = etape("Inventaire des dépendances (SBOM)");
    const attestation = etape("Attester l'inventaire");
    const publication = etape("Publier");
    expect(attestation.texte).toContain("uses: actions/attest@");
    expect(attestation.texte).toContain("subject-path: dist/gamedashboard-*.tar.gz");
    expect(attestation.texte).toContain(`sbom-path: ${inventaire}`);
    expect(attestation.debut).toBeGreaterThan(production.debut);
    expect(publication.debut).toBeGreaterThan(attestation.debut);
  });
});

/**
 * Le scan ZAP (PLAN §5.4) : présent, reproductible, et honnête sur ce qu'il
 * laisse passer.
 */
describe("scan ZAP de la CI", () => {
  const ci = readFileSync(join(RACINE, ".github", "workflows", "ci.yml"), "utf8");
  const script = readFileSync(join(RACINE, "infra", "ci", "zap-baseline.sh"), "utf8");
  const regles = readFileSync(join(RACINE, "infra", "ci", "zap-regles.tsv"), "utf8")
    .split("\n")
    .filter((ligne) => ligne.trim() !== "" && !ligne.startsWith("#"));

  it("tourne après les parcours, sur l'application compilée", () => {
    const parcours = ci.indexOf("name: Parcours et accessibilité");
    const scan = ci.indexOf("name: Scan ZAP");
    expect(parcours).toBeGreaterThan(0);
    expect(scan).toBeGreaterThan(parcours);
    expect(ci.slice(scan, ci.indexOf("\n\n", scan))).toContain(
      'run: ZAP_CONTENEUR="$(bash infra/ci/linux.sh nom)" bash infra/ci/zap-baseline.sh',
    );
  });

  it("épingle l'image de ZAP par empreinte", () => {
    expect(script).toMatch(
      /^IMAGE=ghcr\.io\/zaproxy\/zaproxy@sha256:[0-9a-f]{64} # \d+\.\d+\.\d+$/m,
    );
  });

  it("ne fait jamais taire un avertissement sans le dire", () => {
    // Sans -I, un avertissement rend un code non nul : c'est ce qui fait
    // échouer le job sur une alerte nouvelle.
    expect(script).toMatch(/zap-baseline\.py -t "\$CIBLE" -c regles\.tsv/);
    expect(script).not.toMatch(/zap-baseline\.py[^\n]* -I\b/);
    // Sans -silent, ZAP télécharge ses règles du jour : le verdict ne
    // dépendrait plus seulement de l'image épinglée.
    expect(script).toMatch(/zap-baseline\.py[^\n]* -z -silent/);
  });

  it("ne confond pas un Docker absent avec une alerte", () => {
    const controle = script.indexOf("docker info >/dev/null 2>&1 ||");
    expect(controle).toBeGreaterThan(0);
    expect(controle).toBeLessThan(script.indexOf("docker create"));
    expect(script.slice(controle, script.indexOf("\n", controle))).toContain("exit 3");
  });

  it("n'écrit pas dans l'espace de travail depuis le conteneur", () => {
    // Aucun montage : le dossier de travail est copié dans le conteneur de
    // ZAP, et le rapport recopié. Rien de ce que ZAP écrit ne reste dans _work.
    expect(script).toContain("TRAVAIL=$(mktemp -d)");
    expect(script).toContain('| docker cp - "$ZAP:/zap"');
    expect(script).not.toMatch(/docker (run|create)[^\n]* -v /);
  });

  it("justifie chaque exception", () => {
    expect(regles.length).toBeGreaterThan(0);
    for (const ligne of regles) {
      const [id, niveau, raison] = ligne.split("\t");
      expect(id).toMatch(/^\d+$/);
      expect(["IGNORE", "INFO", "WARN", "FAIL"]).toContain(niveau);
      expect((raison ?? "").length).toBeGreaterThan(40);
    }
  });
});

/**
 * Les captures de référence de la suite visuelle ne se prennent que sur le
 * runner, à la demande : une référence prise ailleurs ferait échouer la CI
 * sur des différences de rendu de polices que personne n'a introduites.
 */
describe("workflow des captures de référence", () => {
  const captures = readFileSync(join(RACINE, ".github", "workflows", "captures.yml"), "utf8");

  it("ne se lance qu'à la main", () => {
    const declencheurs = captures.slice(
      captures.indexOf("\non:"),
      captures.indexOf("\nconcurrency:"),
    );
    expect(declencheurs.trim()).toBe("on:\n  workflow_dispatch:");
  });

  it("reprend toutes les captures de la suite visuelle, et les pousse sur la branche lancée", () => {
    expect(captures).toContain("playwright test e2e/visuel.spec.ts --update-snapshots=all");
    expect(captures).toContain("git add apps/web/e2e/visuel.spec.ts-snapshots");
    expect(captures).toContain(`BRANCHE: \${{ github.ref_name }}`);
    expect(captures).toContain('git push origin "HEAD:$BRANCHE"');
  });
});

/**
 * Domaine de revendeur vérifié, **avant son certificat**.
 *
 * Le bloc de défi (`bloc_acme` de `certificates.sh`) répondait `return 503;` à
 * tout ce qui n'était pas le défi ACME : le client du revendeur qui ouvrait
 * son adresse trop tôt tombait sur la page d'erreur nue de nginx, avec sa
 * version. Il doit recevoir une page d'attente claire, sans marque (ni celle
 * de la plateforme, ni le panel en clair), et le défi doit rester servi.
 *
 * Le bloc est **rendu par bash** à partir du script lui-même : c'est ce texte
 * exact que l'agent pose dans nginx. `domaine` est posé à part : les deux
 * fonctions le lisent dans la portée de `traiter`, qui les appelle.
 */
describe("domaine de revendeur en attente de certificat", () => {
  const script = join(PROD, "certificates.sh");
  const rendre = (fonction: string) =>
    execFileSync(
      "bash",
      [
        "-c",
        `source <(sed -n '/^PAGE_ATTENTE=/p;/^${fonction}()/,/^EOF$/p' "$1"; echo "}"); WEBROOT=/var/www/html; PANEL_WEB_PORT=3210; domaine=panel.revendeur.fr; ${fonction} "$domaine"`,
        "rendu",
        script,
      ],
      { encoding: "utf8" },
    );
  const acme = rendre("bloc_acme");
  const servi = rendre("bloc_servi");

  it("sert le défi ACME depuis le répertoire de certbot", () => {
    expect(acme).toMatch(/server_name panel\.revendeur\.fr;/);
    expect(acme).toMatch(
      /location \/\.well-known\/acme-challenge\/ \{\s*root \/var\/www\/html;\s*\}/,
    );
  });

  it("répond au reste par une page d'attente, pas par l'erreur nue de nginx", () => {
    const racine = acme.slice(acme.indexOf("location / {"));
    expect(racine).toMatch(/return 503 '<!doctype html>.*Mise en service en cours.*<\/html>';/);
    expect(racine).toMatch(/default_type "text\/html; charset=utf-8";/);
    expect(racine).toMatch(/add_header Retry-After \d+ always;/);
    expect(racine).toMatch(/add_header Cache-Control "no-store" always;/);
    expect(racine).toMatch(/add_header X-Content-Type-Options "nosniff" always;/);
    // Le panel n'est jamais servi en clair sur le domaine d'un revendeur.
    expect(acme).not.toMatch(/proxy_pass/);
  });

  it("écrit une page que nginx sert telle quelle, sans marque ni couleur en dur", () => {
    const page = /return 503 '([^']*)';/.exec(acme)?.[1] ?? "";
    expect(page.length).toBeGreaterThan(100);
    // `$` serait lu par nginx comme une variable ; une apostrophe fermerait la chaîne.
    expect(page).not.toMatch(/[$']/);
    expect(page).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
    expect(page).not.toMatch(/GameDashboard/i);
  });

  /**
   * Non-régression : le domaine servi relayait \`Upgrade $http_upgrade\` et
   * \`Connection "upgrade"\` sans le filtre de panel.conf, soit la contrebande
   * h2c que ce vhost-là bloque. Les deux passent par les mêmes \`map\`.
   */
  it("ne relaie sur le domaine servi qu'une mise à niveau websocket", () => {
    const sansCommentaires = servi.replace(/#.*$/gm, "");
    expect(sansCommentaires).not.toMatch(/proxy_set_header\s+Upgrade\s+\$http_upgrade/);
    expect(sansCommentaires).not.toMatch(/proxy_set_header\s+Connection\s+"upgrade"/);
    expect(sansCommentaires).toMatch(/proxy_set_header\s+Upgrade\s+\$gd_upgrade;/);
    expect(sansCommentaires).toMatch(/proxy_set_header\s+Connection\s+\$gd_connection;/);
    // Les variables viennent de panel.conf, posé sur le même nginx.
    expect(vhost).toMatch(/map \$http_upgrade \$gd_upgrade \{/);
    expect(vhost).toMatch(/map \$http_upgrade \$gd_connection \{/);
  });

  it("tait la version de nginx sur le domaine du revendeur, avant comme après", () => {
    for (const bloc of [acme, servi]) {
      const serveurs = bloc.split(/^server \{/m).slice(1);
      expect(serveurs.length).toBeGreaterThan(0);
      for (const serveur of serveurs) expect(serveur).toMatch(/^\s*server_tokens off;/m);
    }
  });
});

/**
 * Domaine de revendeur **déclaré, pas encore vérifié**.
 *
 * Il n'avait aucun bloc : ses requêtes tombaient sur le `default_server` de
 * nginx (page d'erreur nue, ou un autre site de la machine). Il reçoit
 * désormais la même page d'attente que le bloc de défi, par un bloc à son nom
 * exact, port 80 seul — jamais un attrape-tout, qui capterait le trafic des
 * autres sites d'une machine partagée.
 *
 * Rendu par bash à partir du script, comme le bloc de défi ci-dessus.
 */
describe("domaine de revendeur déclaré, pas encore vérifié", () => {
  const script = join(PROD, "certificates.sh");
  const source = readFileSync(script, "utf8");
  const rendre = (fonction: string) =>
    execFileSync(
      "bash",
      [
        "-c",
        `source <(sed -n '/^PAGE_ATTENTE=/p;/^${fonction}()/,/^EOF$/p' "$1"; echo "}"); WEBROOT=/var/www/html; domaine=panel.revendeur.fr; ${fonction} "$domaine"`,
        "rendu",
        script,
      ],
      { encoding: "utf8" },
    );
  const attente = rendre("bloc_attente");
  const acme = rendre("bloc_acme");
  const sansCommentaires = (bloc: string) => bloc.replace(/#.*$/gm, "").trim();

  it("écoute le seul nom déclaré, sur le port 80, sans attrape-tout", () => {
    const utile = sansCommentaires(attente);
    expect(utile).toMatch(/^\s*server_name panel\.revendeur\.fr;$/m);
    expect(utile.match(/server_name/g)).toHaveLength(1);
    expect(utile).not.toMatch(/default_server|server_name\s+_|\*|~/);
    expect(utile).not.toMatch(/listen\s+(\[::\]:)?443|ssl/);
    expect(utile.match(/^\s*listen /gm)).toHaveLength(2);
    expect(utile).toMatch(/^\s*server_tokens off;/m);
    expect(utile).not.toMatch(/proxy_pass/);
  });

  it("sert la même page d'attente, avec les mêmes en-têtes, et le défi ACME", () => {
    // Même bloc que celui du défi, commentaires mis à part : un écart
    // introduit dans l'un et oublié dans l'autre ferait diverger la page.
    expect(sansCommentaires(attente)).toBe(sansCommentaires(acme));
    expect(attente).toMatch(/return 503 '<!doctype html>.*Mise en service en cours.*<\/html>';/);
    expect(attente).toMatch(
      /location \/\.well-known\/acme-challenge\/ \{\s*root \/var\/www\/html;\s*\}/,
    );
  });

  it("ne demande jamais de certificat pour un domaine non vérifié", () => {
    // Seules les lignes vérifiées et `pending` partent vers certbot.
    expect(source).toMatch(
      /if ligne\.get\("pending"\) and ligne\.get\("verified", True\) is True:/,
    );
    expect(source).toMatch(/attendre "\$domaine"/);
    const attendre = source.slice(source.indexOf("attendre() {"), source.indexOf("# ─── Tour"));
    expect(attendre).not.toMatch(/certbot|bloc_acme|bloc_servi/);
    expect(attendre).toMatch(/poser_bloc "\$domaine" "\$contenu" --exclusif/);
  });

  it("refuse un nom qu'un autre site de la machine sert déjà", () => {
    const servi = (nom: string) => {
      try {
        execFileSync(
          "bash",
          [
            "-c",
            `source <(sed -n '/^nom_servi_ailleurs()/,/^}$/p' "$1"); PREFIX=gd-reseller-; CONFIG_NGINX=$2; nom_servi_ailleurs "$3"`,
            "rendu",
            script,
            [
              "# configuration file /etc/nginx/sites-enabled/autre.conf:",
              "server {",
              "    server_name www.autre.fr *.joker.fr;",
              "}",
              "# configuration file /etc/nginx/sites-enabled/regex.conf:",
              '    server_name "~^(?<sous>.+)\\.regex\\.fr$";',
              "# configuration file /etc/nginx/sites-enabled/gd-reseller-a.revendeur.fr.conf:",
              "    server_name a.revendeur.fr;",
            ].join("\n"),
            nom,
          ],
          { stdio: "ignore" },
        );
        return true;
      } catch {
        return false;
      }
    };
    expect(servi("www.autre.fr")).toBe(true);
    expect(servi("x.joker.fr")).toBe(true);
    // Défaut : un `server_name` en expression régulière n'était pas lu, et un
    // nom déclaré non vérifié pouvait prendre le port 80 de ce site.
    expect(servi("jeu.regex.fr")).toBe(true);
    // Nos propres blocs ne comptent pas : ce sont eux qu'on réécrit.
    expect(servi("a.revendeur.fr")).toBe(false);
    expect(servi("libre.revendeur.fr")).toBe(false);
  });
});

/**
 * L'API regroupée de l'archive autonome laisse dehors chaque pair facultatif
 * de Nest absent de l'installation.
 *
 * esbuild ne sait pas qu'un pair est facultatif : un `import()` à la demande
 * vers un paquet absent fait échouer tout le regroupement. NestJS 12.1.0 a
 * ajouté `@fastify/multipart` aux pairs de l'adaptateur Fastify, et
 * `autonome.mjs` échouait (« Could not resolve ») ; la CI ne construit pas
 * cette archive, seule la release l'aurait vu, et l'hébergement cPanel
 * n'aurait plus reçu de version.
 */
describe("archive autonome : externes de l'API", () => {
  const API = join(RACINE, "apps", "api");

  /**
   * Un paquet visible depuis un dossier, comme Node le chercherait : dans les
   * `node_modules` de chaque dossier parent. Par le système de fichiers et non
   * par `require.resolve`, que le champ `exports` de Nest ferme à
   * `package.json`.
   */
  const installe = (depuis: string, paquet: string): boolean => {
    for (let dossier = depuis; ; dossier = dirname(dossier)) {
      if (existsSync(join(dossier, "node_modules", paquet, "package.json"))) return true;
      if (dirname(dossier) === dossier) return false;
    }
  };

  it("nomme chaque pair facultatif de Nest qui n'est pas installé", async () => {
    const { EXTERNES_API } = (await import(
      join(RACINE, "infra", "release", "externes-api.mjs")
    )) as { EXTERNES_API: string[] };
    const manquants: string[] = [];

    for (const paquet of ["@nestjs/core", "@nestjs/common", "@nestjs/platform-fastify"]) {
      // Le vrai dossier du paquet : pnpm range ses pairs à côté de lui.
      const dossier = realpathSync(join(API, "node_modules", paquet));
      const manifeste = JSON.parse(readFileSync(join(dossier, "package.json"), "utf8")) as {
        peerDependenciesMeta?: Record<string, { optional?: boolean }>;
      };
      for (const [pair, meta] of Object.entries(manifeste.peerDependenciesMeta ?? {})) {
        if (meta.optional && !installe(dossier, pair) && !EXTERNES_API.includes(pair)) {
          manquants.push(`${pair} (${paquet})`);
        }
      }
    }

    expect(manquants).toEqual([]);
  });
});
