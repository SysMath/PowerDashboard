# Héberger le panel sur un hébergement cPanel

Pour un hébergement mutualisé sous cPanel qui propose **« Setup Node.js
App »** (CloudLinux et Passenger) et **PostgreSQL**. Sur un serveur à soi,
préférer l'installation guidée ([installation.md](./installation.md)) :
nginx et systemd y font mieux ce que ce guide contourne (voir *Limites*).

Chaque release publie, à côté de l'archive ordinaire, une **archive
autonome** : `gamedashboard-vX.Y.Z-autonome.tar.gz`. Le panel y est prêt à
tourner — API compilée en un fichier, interface Next en mode standalone,
migrations, module natif d'argon2 — sans rien à installer. On l'extrait une
fois ; ensuite, **le panel se met à jour de lui-même** depuis les releases
GitHub, sans script, sans cron, sans terminal.

```
visiteurs, Wings, facturation
        │  https://<domaine>
        ▼
Apache ─► Passenger ─► interface (Next) ──► https://api.<domaine>
                                              │
                               Apache ─► Passenger ─► API (NestJS) ─► PostgreSQL
```

Deux applications Node.js, chacune sur son nom. L'adresse du panel ne sert
que l'interface : les appels de Wings (`/api/remote/…`, `/api/application/…`)
et ceux de la facturation (`/api/v1/application/…`) y sont **relayés** vers
l'API par Next (`apps/web/src/server/api-relay.ts`), exactement pour les
chemins que nginx aiguille en production. Wings reste inchangé.

Tout vit hors de `public_html`, dans `~/gamedashboard/` :

```
passenger/lanceur.cjs       choisit la version à démarrer (etat.json)
passenger/api/app.cjs       racine d'application de l'API
passenger/interface/app.cjs racine d'application de l'interface
passenger/admin.cjs         crée un administrateur
versions/vX.Y.Z/            une version, prête à tourner
env/api.env, env/web.env    réglages et secrets (0600)
etat.json                   version en service, précédente, mises de côté
```

## 1. Base PostgreSQL

cPanel › **Bases de données PostgreSQL** : créer une base, un utilisateur avec
un mot de passe long, et donner à l'utilisateur tous les droits sur la base.
cPanel préfixe les deux noms par celui du compte (`compte_gamedashboard`).

Un PostgreSQL ancien convient, **depuis la version 9.6** : c'est ce que
proposent encore certains hébergeurs, sans extension installable. Le
migrateur de l'archive (`@gamedashboard/db/migrate`) adapte au serveur ce
qu'il ne connaît pas encore et fournit les fonctions qui lui manquent
(`gen_random_uuid()`, `date_bin()`) ; toute la suite de tests de l'API passe
contre un 9.6. La version s'affiche en tête de phpPgAdmin.

## 2. Domaines

- **Le domaine du panel.** Sa racine de documents (souvent `public_html`)
  doit être **vide** : Passenger sert tel quel tout fichier qui s'y trouve,
  avant de passer la main à l'application. Un ancien clone du dépôt, dossier
  `.git` compris, y serait public. L'effacer par le gestionnaire de fichiers
  (fichiers cachés affichés) ; *Supprimer* dans « Git Version Control » ne
  retire que le suivi, pas les fichiers.
- **Un sous-domaine pour l'API**, `api.<domaine>` : cPanel › **Domaines** ›
  Créer.
- **HTTPS pour les deux** : cPanel › **SSL/TLS Status** › AutoSSL, puis
  « Forcer la redirection HTTPS » dans **Domaines**.

## 3. Extraire l'archive

1. Page *Releases* du dépôt, dernière version : télécharger
   `gamedashboard-vX.Y.Z-autonome.tar.gz`.
2. cPanel › **Gestionnaire de fichiers**, dossier personnel : *Téléverser*
   l'archive, puis *Extraire*. Le dossier `gamedashboard/` apparaît.
3. Effacer l'archive.

## 4. Réglages

Dans le gestionnaire de fichiers, créer `gamedashboard/env/` et y poser deux
fichiers, **permissions 0600** :

`api.env`

```bash
DATABASE_URL=postgres://compte_gd:<mot de passe>@localhost:5432/compte_gamedashboard
APP_SECRET_KEY=<voir ci-dessous>
PANEL_ORIGIN=https://<domaine>
# L'adresse IP du serveur : cPanel l'affiche dans la colonne « Informations
# générales » (adresse IP partagée). Voir « Limites ».
TRUSTED_PROXIES=127.0.0.1, ::1, <adresse IP du serveur>
# Facultatif : mise à jour dès la publication d'une release (voir plus bas).
GAMEDASHBOARD_SIGNAL_SECRET=
```

`web.env`

```bash
API_URL=https://api.<domaine>
PANEL_ORIGIN=https://<domaine>
```

`APP_SECRET_KEY` chiffre les secrets rangés en base : la tirer sur son propre
poste (`openssl rand -base64 48`, 32 caractères au moins) et **en garder une
copie hors de l'hébergement**. Sans elle, une sauvegarde de la base ne se
relit pas ([runbook de la clé maître](./runbooks/cle-maitre-secrets.md)). Les
autres variables facultatives sont décrites dans `apps/api/.env.example`.

Les réglages vivent dans ces fichiers, pas dans l'écran « Setup Node.js
App » : cPanel garde ses variables en clair dans ses propres réglages. Une
variable posée dans l'écran l'emporte sur le fichier.

## 5. Applications Node.js

cPanel › **Setup Node.js App** › *Create Application*, deux fois :

| | API | Interface |
|---|---|---|
| Node.js version | 24 | 24 |
| Application mode | Production | Production |
| Application root | `gamedashboard/passenger/api` | `gamedashboard/passenger/interface` |
| Application URL | `api.<domaine>` | `<domaine>` |
| Application startup file | `app.cjs` | `app.cjs` |

Aucune variable d'environnement dans cet écran (étape 4), et **jamais**
« Run NPM Install » : l'archive n'a besoin de rien. Si l'écran propose un
« Passenger log file », y mettre `gamedashboard/api.log` et
`gamedashboard/interface.log` : c'est là que s'écrit une erreur de démarrage.

Ouvrir `https://<domaine>` : la première requête démarre l'interface, qui
appelle l'API ; l'API joue alors les migrations de la base avant de
répondre. Quelques secondes la première fois.

## 6. Premier compte administrateur

La seule commande de l'installation, une fois, dans cPanel › **Terminal** :

```bash
/opt/alt/alt-nodejs24/root/usr/bin/node ~/gamedashboard/passenger/admin.cjs vous@exemple.fr Prénom Nom
```

Le mot de passe provisoire s'affiche, valable vingt-quatre heures. Sans
Terminal : la même commande en tâche cron, le temps d'un passage, avec
`> ~/gamedashboard/admin.txt` à la fin pour lire le mot de passe — puis
effacer la tâche **et** le fichier.

## 7. Machines de jeu

Comme ailleurs ([installation.md](./installation.md)) : Wings s'adresse à
`https://<domaine>`, que l'interface relaie vers l'API.

**Le panel doit pouvoir joindre chaque Wings** (port 8080 par défaut, ou
celui déclaré pour le node). Beaucoup d'hébergements mutualisés filtrent les
connexions sortantes : si les nodes restent « injoignables » alors que Wings
tourne, demander l'ouverture du port à l'hébergeur, ou faire écouter Wings
sur 443.

## Mises à jour

Rien à faire : l'API lit la dernière release du dépôt **toutes les trente
minutes** (`apps/api/src/modules/updates`). Quand une version plus récente
paraît :

1. elle télécharge l'archive autonome et la vérifie contre son empreinte ;
2. elle n'en extrait que la nouvelle version, dans `versions/` ;
3. elle la **répète** : démarrée à part sur des ports locaux, sans tâches de
   fond, la nouvelle version joue ses migrations et doit répondre. Sinon,
   elle est **mise de côté** et ne sera plus essayée — rien n'a bougé pour
   les visiteurs ;
4. elle bascule `etat.json` et demande à Passenger de relancer les deux
   applications (`tmp/restart.txt`) ;
5. la nouvelle version, à son démarrage, vérifie qu'elle répond par
   l'adresse publique et confirme ; sinon elle revient d'elle-même à la
   précédente et se met de côté. Dernier filet : si l'API redémarre plus de
   trois fois sans confirmer, ou si la version ne se charge même pas, le
   lanceur revient à la précédente.

Les deux dernières versions restent sur le disque. Administration › Vue
d'ensemble › **Mises à jour** montre la version en service, la dernière
release, le résultat de la dernière tentative, et offre **Vérifier
maintenant** et **Revenir à la version précédente**. Chaque geste et chaque
installation sont consignés au journal d'audit.

Les **préversions** (`v1.2.0-rc.1`) ne sont jamais installées : GitHub ne les
rend pas comme « dernière release ».

### Le dépôt suivi

Le dépôt dont les releases sont lues est celui qui a publié la version en
service : ligne `depot=` de `versions/<v>/RELEASE`, écrite à la construction
de l'archive. Une ligne `GAMEDASHBOARD_DEPOT=propriétaire/dépôt` dans
`env/api.env` l'emporte, puis relancer l'application de l'API.

Un dépôt **renommé ou transféré** reste suivi : GitHub redirige l'ancien nom,
et l'API lit le nom actuel par l'identifiant du dépôt avant de n'accepter que
les fichiers publiés sous ce nom. Les versions antérieures à ce suivi (v1.0.1
et avant) ne le savent pas : sur elles, la carte affiche « Adresse de
téléchargement refusée » à chaque vérification (ou ne voit plus aucune
release, si l'ancien nom ne mène plus nulle part), et il faut poser une fois
la ligne ci-dessus avec le nom actuel.

**Les migrations ne se défont pas.** Revenir à la version précédente
redémarre l'ancien code sur le schéma déjà migré : sans danger tant que les
migrations ne font qu'ajouter, ce qui est la règle du projet.

### Mise à jour dès la publication (facultatif)

Le workflow de release peut prévenir le panel, qui vérifie alors aussitôt au
lieu d'attendre la demi-heure :

1. tirer un secret : `openssl rand -hex 32` ;
2. le poser dans `api.env` : `GAMEDASHBOARD_SIGNAL_SECRET=<secret>` ;
3. dans le dépôt GitHub, *Settings* › *Secrets and variables* › *Actions* :
   secret `PANEL_SIGNAL_SECRET` (le même), variable `PANEL_URL`
   (`https://<domaine>`).

Le signal est signé (HMAC sur l'horodatage et la version) ; mal signé ou
périmé, il reçoit une page introuvable. Même valide, il ne fait que hâter
une vérification auprès de GitHub : c'est la release qui décide.

### Maintien en éveil

Passenger arrête une application restée quelques minutes sans requête, et
avec l'API s'arrêteraient le planificateur, la surveillance des machines,
les webhooks et les mises à jour. L'API s'interroge donc elle-même par
l'adresse publique chaque minute. Après un redémarrage d'Apache, c'est la
première requête (un visiteur, un Wings) qui la réveille ; pour ne pas en
dépendre, une sonde externe d'`https://<domaine>/api/health` (un service de
supervision, ou une tâche cron `curl`) fait l'affaire.

## Vérifier

```bash
curl -s https://<domaine>/api/health                  # {"status":"ok"}
curl -s https://<domaine>/api/v1/status | head -c 80  # le statut, relayé
curl -s -o /dev/null -w '%{http_code}\n' https://<domaine>/api/remote/servers   # 403 : l'API répond, sans jeton
```

Puis, connecté : Compte › Sécurité › Sessions actives doit montrer **votre**
adresse, pas celle du serveur. Sinon, `TRUSTED_PROXIES` ne contient pas la
bonne adresse, et tous les visiteurs partageraient un seul compteur de
tentatives de connexion.

## Sauvegarder

`gamedashboard backup` n'existe pas ici. Deux choses à mettre à l'abri,
ensemble : la base (cPanel › **Sauvegarde**) et `~/gamedashboard/env/`, qui
porte `APP_SECRET_KEY`.

## Limites

Ce qu'un serveur à soi fait et qu'un hébergement mutualisé ne fait pas :

- **L'API a une adresse publique.** `api.<domaine>` répond à tout Internet ;
  en production, nginx ne laisse sortir que les préfixes publics. Toutes les
  routes restent authentifiées. Pour la fermer, ajouter au `.htaccess` de la
  racine du sous-domaine, hors du bloc que gère CloudLinux :
  `Require ip <adresse IP du serveur>`. Vérifier ensuite qu'un appel depuis
  l'extérieur reçoit 403, et que le panel fonctionne toujours : si la
  machine sort par une autre adresse, l'interface ne joindrait plus l'API.
- **Pas de limitation de débit en amont.** Les zones `limit_req` de
  `infra/prod/panel.conf` n'existent pas ici. Restent celles de l'API :
  tentatives de connexion, réinitialisations, envois de courriel.
- **Les voisins partagent l'adresse du serveur.** Elle figure dans
  `TRUSTED_PROXIES` : un autre compte de la même machine peut appeler l'API
  en se donnant une fausse adresse. Cela fausse un compteur par adresse ou
  une adresse affichée, jamais un droit.
- **Un seul processus par application.** Passenger n'en démarre qu'un pour
  une application Node, qui traite les requêtes en parallèle ; les tâches de
  fond de l'API le supposent. Ne pas régler plusieurs instances.
- **L'empreinte vient de la release.** Elle écarte un téléchargement tronqué
  ou altéré en route ; l'origine, elle, tient au HTTPS vers le seul dépôt
  configuré. Qui peut publier une release sur le dépôt peut donc mettre à
  jour l'hébergement : protéger les étiquettes `v*` en conséquence.
- **Pas d'en-tête HSTS.** nginx le pose en production. L'ajouter au
  `.htaccess` du domaine du panel :
  `Header always set Strict-Transport-Security "max-age=31536000; includeSubDomains"`.
- **Mémoire bornée.** L'hébergement limite la mémoire du compte ; la
  répétition d'une mise à jour fait tourner deux versions quelques instants.
  Un panel qui renvoie des erreurs 503 sous charge s'y heurte peut-être.
