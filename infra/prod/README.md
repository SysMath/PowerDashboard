# Production sous systemd

Modèle de déploiement du panel sur un serveur Linux : deux processus sous
systemd, un vhost nginx, une base dédiée sur un PostgreSQL existant. La seule
installation en service aujourd'hui est la production locale
(`https://gamedashboard.local`, voir [`infra/local`](../local/README.md)). Ce
dossier en est la version pour une vraie machine, et ce qui la distingue du
local y est écrit.

**Première installation** : `curl -fsSL …/releases/latest/download/gamedashboard.sh | sudo bash -s -- install`,
ou depuis un dossier `pnpm app:install && pnpm app:setup` (ou
`sudo bash infra/prod/installer.sh`). L'installation guidée installe
les paquets, obtient le certificat, appelle `deploy.sh` et crée le premier
administrateur. Le pas à pas est dans [docs/installation.md](../../docs/installation.md) ;
`installer-wings.sh` prépare de même une machine de jeu.

`panel.example.fr` est un nom d'exemple, que `deploy.sh` remplace dans
`panel.conf` au moment de l'installer. Le domaine réel se donne une fois par
`GD_DOMAIN=panel.mondomaine.fr` ; les passages suivants le relisent dans
`PANEL_ORIGIN` de `api.env`.

| | |
|---|---|
| Interface | `gamedashboard-web.service`, Next sur `127.0.0.1:3210` |
| API | `gamedashboard-api.service`, Nest sur `127.0.0.1:3211` |
| Code | `/opt/gamedashboard/app` |
| Secrets | `/opt/gamedashboard/env/{api,web}.env`, `root:gamedashboard 640` |
| Base | rôle et base `gamedashboard` sur le PostgreSQL de la machine |
| Certificat | émis et renouvelé par certbot, hors de ce dépôt |
| Certificats des revendeurs | `certificates.sh`, sous `gamedashboard-certificates.timer` |
| TLS nginx | `tls-intermediate.conf`, posé dans `/etc/nginx/snippets/tls/` s'il manque |

**Machine neuve.** Le vhost a d'abord été écrit sur une machine partagée qui
lui fournissait, sans que ce soit écrit, un `map` (`$req_connection`) et le
fichier de réglages TLS. Il apporte désormais les deux lui-même (`$gd_connection`,
`tls-intermediate.conf`), et `deploy.sh` réécrit `http2 on;` en
`listen 443 ssl http2;` pour un nginx antérieur à 1.25.1 (Debian 12,
Ubuntu 22.04 et 24.04). `apps/api/src/common/infra-prod.test.ts` y veille.

## Publier une version

```bash
git tag v1.2.0 && git push origin v1.2.0
```

`.github/workflows/release.yml` rejoue toute la CI (`ci.yml`, appelée telle
quelle), compile, assemble l'archive par `infra/release/assembler.sh`,
atteste sa provenance et la publie dans GitHub Releases avec son empreinte
et `installer-wings.sh`. Un suffixe (`v1.2.0-rc.1`) publie une préversion.

L'archive contient le code de `git archive` et `apps/web/.next` sans son
cache, mais **pas** `node_modules` : argon2 a une partie native, compilée par
`pnpm install` pour la machine qui l'exécute. Son fichier `RELEASE` porte
l'identifiant de la construction ; `deploy.sh` saute la compilation quand il
correspond à `.next/BUILD_ID`. L'API, elle, tourne sous `tsx` depuis ses
sources : elle n'a pas d'étape de compilation (voir « Points ouverts »).

`pnpm app:release v0.0.0-essai` reproduit une archive en local, après
`pnpm build`.

## Commandes d'exploitation

Toutes servies par `app.sh`, qui se suffit à lui-même. Il est publié à chaque
version sous le nom `gamedashboard.sh`, installé en `/usr/local/bin/gamedashboard`,
et appelé par les scripts `app:` du package.json. Hors de tout dossier (lu
par `curl | bash`, ou depuis `/usr/local/bin`), il télécharge ce qui lui
manque dans GitHub Releases, **empreinte vérifiée** : `install` pose la
dernière version dans `/opt/gamedashboard/releases/` puis lance
`installer.sh` ; `update` sauvegarde, pose la nouvelle version et relance
`installer.sh --oui` ; `wings` télécharge `installer-wings.sh`. Lu par un
tuyau, son entrée standard est le script lui-même : les étapes
interactives lisent donc `/dev/tty`.

`backup` écrit un seul fichier, base (`pg_dump -Fc`) **et** `env/` : l'un sans
l'autre ne restaure rien. Il contient donc `APP_SECRET_KEY`, et s'écrit
chiffré (`openssl enc`, AES-256) par la clé des sauvegardes,
`/opt/gamedashboard/backup.key` : tirée à la première sauvegarde, jamais
remplacée, hors de l'archive, à garder hors de la machine. Rien n'est
demandé au clavier, `update` sauvegarde sans terminal. Sept sont gardés
(`GD_GARDER`). Relire : [restauration de la base](../../docs/runbooks/restauration-base.md).

Côté pnpm, les commandes sont sous `app:`.
Le préfixe n'est pas décoratif. pnpm fait passer ses propres commandes avant
les scripts du projet : `pnpm setup` règle le dossier global de pnpm et
modifie le `.bashrc` sans lancer l'installation, et `pnpm restart` enchaîne
d'autres scripts au lieu d'en lancer un. Un script sans préfixe portant l'un
de ces noms ne s'exécuterait jamais ; `infra-prod.test.ts` le refuse.

## Livrer une nouvelle version à la main

Depuis le poste de développement :

```bash
rsync -az --delete \
  --exclude node_modules --exclude .next --exclude .turbo \
  --exclude .env --exclude .env.local \
  ./ prod:/opt/gamedashboard/app/
ssh prod bash /opt/gamedashboard/app/infra/prod/deploy.sh
```

`deploy.sh` est rejouable : il installe, construit, migre, réinstalle les
unités et recharge nginx, puis contrôle que les pages répondent vraiment. Il
ne régénère **jamais** un secret existant : un `APP_SECRET_KEY` régénéré rendrait
illisibles tous les secrets chiffrés en base (voir le runbook
[clé maître des secrets](../../docs/runbooks/cle-maitre-secrets.md)).

## Ce que la machine expose, et ce qu'elle n'expose pas

Trois règles ont guidé l'installation. Elles valent d'autant plus que la
machine sert d'autres sites.

**Les deux processus n'écoutent que la boucle locale.** `HOST=127.0.0.1` pour
l'API, `--hostname 127.0.0.1` pour Next. Le défaut de l'API est `0.0.0.0`,
correct en conteneur et faux sur un hôte public : les routes d'administration
seraient joignables sur l'adresse publique, sans passer par le proxy, pare-feu
actif ou non.

**nginx ne relaie vers l'API que ce qui doit sortir** : `/api/v1/application/`
pour le système de facturation tiers, `/api/remote/` pour les daemons Wings,
`/api/node-agent/` pour l'agent de node facultatif, et `/api/v1/status` pour une supervision. Tout le reste de l'API — client,
revendeur, administration — n'est appelé que par l'interface, depuis la
machine. Demandé de l'extérieur, `/api/v1/admin/...` tombe sur Next, qui
répond 404.

**L'interface n'a ni `DATABASE_URL` ni `APP_SECRET_KEY`.** Son fichier
d'environnement ne les contient pas : elle lit tout par l'API avec le cookie de
l'utilisateur. Une faille de rendu ne donne pas la base.

**Tout est additif.** Un utilisateur système, une base, deux unités, un vhost :
rien d'existant n'est modifié, et `nginx -t` précède chaque rechargement. Le
code de refus des limitations (`limit_req_status`) est posé dans le bloc
`server` et non au niveau `http`, où il entrerait en conflit avec un autre
vhost qui le déclarerait déjà. `/api/remote/` et `/api/node-agent/` le
remplacent par 503 : Wings
abandonne sur un 4xx, 429 compris, et ne rejoue que les 5xx.

## Premier administrateur

```bash
pnpm app:admin <email> <prénom> <nom>
```

Depuis n'importe quel dossier du panel. Seule `DATABASE_URL` est transmise au
script, pas la clé de chiffrement. `pnpm app:password <email>` tire de même un
nouveau mot de passe pour un compte existant.

Le mot de passe est tiré au sort et affiché une seule fois. Le script ne touche
à rien si l'adresse existe déjà.

## Certificats des domaines de revendeurs

Le panel vérifie qu'un revendeur possède son domaine, mais ne peut pas lui
délivrer de TLS : il faut le serveur web et les droits de root.
`certificates.sh` fait le pont. Il demande au panel quels domaines attendent
un certificat, les obtient par certbot et rend compte de chaque tentative.
`deploy.sh` ne l'installe pas, parce qu'il demande une clé qu'un humain doit
émettre :

1. émettre depuis `/admin/api` une clé applicative portant la **seule** portée
   `domains.certificates` ;
2. la déposer dans `/opt/gamedashboard/env/.certificates-key`, `root:root 600` ;
3. installer et activer le minuteur :
   ```bash
   install -m 644 infra/prod/gamedashboard-certificates.{service,timer} /etc/systemd/system/
   systemctl daemon-reload
   systemctl enable --now gamedashboard-certificates.timer
   ```

Le premier essai se fait avec `certificates.sh --staging --dry-run`.

## Journaux

```bash
journalctl -u gamedashboard-api -f
journalctl -u gamedashboard-web -f
journalctl -u gamedashboard-certificates
```

## Exploitation

Les procédures d'incident sont dans [`docs/runbooks`](../../docs/runbooks/README.md) :
rotation du jeton d'un node, machine injoignable, clé maître des secrets.

## Points ouverts

- **L'API tourne sous `tsx`**, sans étape de compilation : ce dépôt n'en a pas.
  Une sortie compilée démarrerait plus vite et n'embarquerait pas le
  compilateur en production.
- **`CURSEFORGE_API_KEY` est vide** dans `api.env` à la création : la recherche
  CurseForge du catalogue répond 403 tant qu'une clé n'y est pas mise. Modrinth
  fonctionne sans clé.
- **Le relais `pnpm`** (`/opt/gamedashboard/bin/pnpm`) existe parce que turbo
  relance `pnpm` dans chaque paquet et trouverait sinon le pnpm global de la
  machine, qui refuse de tourner sur un projet épinglé à une autre version.
