# GameDashboard — consignes pour Claude Code

Panel de gestion de serveurs de jeu (remplaçant de Pterodactyl, Wings conservé).
Référence complète : [PLAN.md](./PLAN.md). Démarrage et conventions : [README.md](./README.md).
Tout le projet — code, commentaires, documentation — est rédigé **en français**.

## Règles de travail

- **Wings reste strictement non modifié.** Le panel s'adapte à son contrat, jamais l'inverse (PLAN §4.3, §5.5).
- **Dépendances : toujours les dernières versions stables**, pour la sécurité.
- **Ne pas compiler après chaque retouche.** Un `pnpm typecheck && pnpm test` complet se justifie après un changement structurel.
- **Aucun secret dans le dépôt.** Les `.env` sont ignorés à tous les niveaux ; seuls les `.env.example` sont versionnés.
- **Git** : ne commiter ou pousser que sur demande de Matheo. Branche principale `main`.
- **Aucune mention de l'ancien hébergeur de la bêta distante**, résiliée. Deux installations : la production locale `https://gamedashboard.local` et l'hébergement cPanel `https://lema7787.odns.fr` (section plus bas).
- Une page = template + hooks + organismes, moins de 80 lignes. Aucune couleur en dur : tokens de `packages/ui/src/styles/tokens.css`.
- Chaque correction de défaut s'accompagne d'un test de non-régression.

### Sur le poste de Matheo seulement (WSL « Codiax »)

- Le dépôt vit sur ext4 (`/root/workspace/GameDashboard`), pas sur `/mnt/c` : `drvfs` n'émet pas d'`inotify` et le rechargement à chaud cassait sans le dire. Ne pas réintroduire `watchOptions.pollIntervalMs` (mesuré, sans effet).
- **Le serveur de dev appartient à Matheo** : ne jamais le tuer ni le relancer sans qu'il le demande.
- Toute exécution passe par Codiax, jamais par le shell Windows.
- Sans systemd : après un redémarrage de WSL, `sudo service docker start`.

### En session distante (cloud)

L'environnement se prépare avec `.claude/cloud-setup.sh` (Node 24, pnpm épinglé, PostgreSQL local, `cloudflared`, `pnpm install`, migrations). Il n'y a **ni Wings, ni Docker, ni production locale** : les bancs `infra/local/verifier-*.sh` ne tournent pas ici. Sans `DATABASE_URL`, les tests d'intégration se sautent proprement.

**Tunnel Cloudflare autorisé par Matheo.** Pour montrer le panel d'une session distante, enchaîner sans redemander :

1. `bash .claude/cloud-setup.sh` (Node 24 s'installe dans `/usr/bin` ; si `/opt/node22` passe devant, préfixer `PATH=/usr/bin:$PATH`).
2. `.env` de dev tirés des `.env.example` : `APP_SECRET_KEY` d'essai (`openssl rand -base64 48`), jamais commitée ; puis `pnpm dev` (API :3201, interface :3000).
3. `cloudflared tunnel --no-autoupdate --url http://localhost:3000`, donner l'adresse `trycloudflare.com` et la reporter dans `PANEL_ORIGIN` (API et interface), sinon le contrôle d'origine refuse les requêtes.

L'adresse est publique : données de démonstration seulement, tunnel arrêté en fin de session. Il faut une sortie TCP ou UDP sur le port 7844 (`*.v2.argotunnel.com`) : si la politique réseau de l'environnement la ferme, le tunnel échoue — le dire, ne pas contourner.

### Hébergement cPanel (`lema7787.odns.fr`)

Mutualisé, sans nginx, systemd, Docker ni outils : deux applications « Setup Node.js App » (Passenger), l'interface sur `lema7787.odns.fr`, l'API sur `api.lema7787.odns.fr`. **Le panel s'y met à jour de lui-même depuis les releases GitHub**, sans script ni cron. Pas à pas, vérifications et limites : [docs/hebergement-cpanel.md](./docs/hebergement-cpanel.md).

- **Archive autonome** : `release.yml` publie `gamedashboard-vX.Y.Z-autonome.tar.gz` (`infra/release/autonome.mjs`) : API compilée par esbuild (`api/main.cjs`, `migrer.cjs`, `creer-admin.mjs`), `@node-rs/argon2` natif à côté, interface Next standalone construite à part (`GAMEDASHBOARD_AUTONOME=1` → `.next-autonome`, la construction ordinaire n'en est pas touchée), modules `infra/cpanel/*.cjs`. Elle s'extrait telle quelle dans le dossier personnel : `passenger/lanceur.cjs` + racines `passenger/{api,interface}/app.cjs`, `versions/vX.Y.Z/`, `etat.json`, `env/` (secrets, 0600, jamais dans l'écran de cPanel). Jamais « Run NPM Install ». Aucun lien symbolique : le gestionnaire de fichiers de cPanel n'en crée pas.
- **Démarrage** : l'API joue ses migrations avant d'écouter (seule `DATABASE_URL` passe au migrateur). Une variable déjà posée l'emporte sur `env/*.env` (règle de `process.loadEnvFile`).
- **PostgreSQL 9.6 sur l'hébergement** : le migrateur de l'archive et des tests d'intégration (`packages/db/src/migrate.ts`) tient la table de suivi de drizzle à l'identique, joue une transaction par migration, réécrit `EXECUTE FUNCTION` (< 11), joue `ADD VALUE` hors transaction (< 12) et fournit `gen_random_uuid()` (< 13) et `date_bin()` (< 14) quand ils manquent. `migrate.integration.test.ts` le compare à drizzle-orm (même schéma, même suivi). Toute fonction SQL récente employée par l'API doit y avoir son remplaçant : la suite entière passe contre un 9.6 (`DATABASE_URL` vers ce serveur).
- **Mise à jour** (`apps/api/src/modules/updates`, actif seulement avec `GAMEDASHBOARD_RACINE` + `GAMEDASHBOARD_VERSION`, posés par `infra/cpanel/api.cjs`) : `releases/latest` toutes les 30 min (ETag), sur signal HMAC du workflow (`POST /api/v1/updates/signal`, relayé) ou depuis la carte « Mises à jour » de la vue d'ensemble de l'administration ; téléchargement vérifié (SHA-256, URL du seul dépôt), extraction de `versions/<v>/` seulement, **répétition** sur ports locaux (`GAMEDASHBOARD_ESSAI=1` coupe `battre()` et la mise à jour), bascule d'`etat.json` + `tmp/restart.txt`, confirmation par la nouvelle version via l'adresse publique, sinon retour à la précédente. Un commit en échec est **mis de côté** (`refusees`), jamais retenté. Le lanceur revient seul à la précédente après trois démarrages sans confirmation. Les préversions ne s'installent pas. L'API se réveille elle-même chaque minute.
- **Wings et la facturation** appellent `PANEL_ORIGIN`, qui ne sert que Next : `API_RELAY=1` fait relayer à Next exactement les préfixes que `infra/prod/panel.conf` envoie à l'API, plus le signal (`apps/web/src/server/api-relay.ts`, sans cookie ; un test vérifie la concordance). Un préfixe ajouté au vhost l'est aussi au relais.
- **En-têtes** : `infra/cpanel/entetes.cjs` refait l'hygiène de nginx à partir des `!~Passenger-*`, que Passenger seul peut écrire. `TRUSTED_PROXIES` de l'API y contient l'adresse IP du serveur.
- **Limites acceptées** : API joignable sur son sous-domaine (routes toutes authentifiées), pas de `limit_req` en amont, un seul processus par application, empreinte tirée de la release elle-même (protéger les étiquettes `v*`), migrations jamais défaites, HSTS à poser dans le `.htaccess`, sortie vers Wings à ouvrir chez l'hébergeur si elle est filtrée.

## Commandes

```bash
pnpm install --frozen-lockfile
pnpm lint          # Biome
pnpm typecheck
pnpm test          # Vitest
pnpm openapi       # régénère openapi.json depuis packages/contracts/src/api-catalogue.ts
pnpm db:generate   # produit la migration d'un changement de schéma
pnpm db:check      # échoue si schéma et migrations ne sont pas en phase
```

La CI (`.github/workflows/ci.yml`) refuse un schéma sans migration et un catalogue d'API sans `openapi.json` régénéré.

## État de la V1

Fait, avec tests de non-régression :

- **Planificateur** parallélisé avec garde `enVol` (`apps/api/src/modules/scheduler/schedule-runner.service.ts`).
- **Balayages de fond** centralisés dans `battre()` (`apps/api/src/common/background-tick.ts`) : un rejet non rattrapé tuait le processus sous Node 24.
- **Changement d'egg** transactionnel, synchronisé avant réinstallation.
- **Lighthouse et régressions visuelles** (PLAN §12.1, §12.2) : `apps/web/e2e/performance.spec.ts` (profil bureau, seuils 90) et `e2e/visuel.spec.ts` (captures bureau et mobile). Les références ne se prennent **que sur le runner**, par le workflow manuel `captures.yml` ; une référence absente saute son test. Contenu variable : `<time>`/`data-instable` masqués, `data-instable-liste` retiré (`e2e/captures.css`). Voir `docs/contribuer.md`.
- **Scan ZAP en CI** (PLAN §5.4) : `infra/ci/zap-baseline.sh` dans le job e2e, passif, image épinglée ; toute alerte hors de `infra/ci/zap-regles.tsv` (exceptions justifiées) fait échouer le job. `-z -silent` : les règles sont celles de l'image épinglée, sans téléchargement au démarrage.
- **Transferts perdus** : un transfert sans compte rendu depuis `TRANSFER_STALE_MS` est clos par `ServerTransferReaperService` (le serveur restait bloqué « en transfert ») ; bascule et retour en arrière verrouillent la ligne du transfert (`server-transfer.integration.test.ts`).
- **SBOM des releases** (PLAN §5.4) : `release.yml` produit `gamedashboard-vX.Y.Z.cdx.json` (CycloneDX, Trivy, dépendances livrées avec licences), l'atteste contre l'archive (`actions/attest`) et le publie ; vérifié par `infra-prod.test.ts`.
- **CSP à nonce + COOP** (PLAN §5.4) : `apps/web/src/proxy.ts` tire un nonce par requête, `script-src 'nonce-…' 'strict-dynamic'` sans `'unsafe-inline'` (`lib/content-security-policy.ts`) ; balise écrite à la main = `nonce={nonce}` (lu dans `x-nonce`) ; toute page doit être rendue à la demande. `Cross-Origin-Opener-Policy: same-origin` ; pas de COEP, par choix (commentaire de `next.config.ts`). Non-régression : `apps/web/e2e/securite.spec.ts`.
- **Mots de passe** : bcrypt reconnu et réécrit en Argon2id à la première connexion (`packages/auth/src/password.ts`).
- **Reprise Pterodactyl** : `apps/api/scripts/import-pterodactyl.mts`, voir `docs/reprise-pterodactyl.md`.
- **OpenAPI + SDK** : catalogue unique `packages/contracts/src/api-catalogue.ts`, SDK écrit à la main dans `packages/sdk`.
- **Egg Minecraft Java unifié** : `infra/eggs/minecraft-java/`.
- **Machine injoignable** : `nodes.unreachableSince` (seul écrivain : `node-health-watcher.service.ts`) → `nodeOutageBlock()` (`packages/contracts/src/server.ts`) → blocage complet de l'interface serveur.
- **Rechiffrement des secrets** : `rekey-secrets.mts` reprend le format `v3:` (il le sautait, une rotation de la clé maître perdait tout) ; cœur testé dans `apps/api/src/common/rekey.ts`.
- **Documentation** (`docs/`) : sept ADR (`docs/adr/`, dont 0007 secrets et données au repos), modèle de menace (`docs/securite/`), runbooks jeton de node, machine injoignable, clé maître, déplacement de serveur, restauration de la base et incident de sécurité (`docs/runbooks/`), guide du contributeur (`docs/contribuer.md`). README à jour.
- **Schéma et migrations en phase** : instantané `0038`, migration `0038_constraint_names`, `pnpm db:check` (drizzle-kit sort en succès même quand il s'arrête sur une question).
- **Certificats des revendeurs** : un certificat expiré n'est plus « actif » (`certificateStanding`).
- **Traduction complète** : page d'erreur et page introuvable ; routes citées dans les textes vérifiées contre l'API.
- **Sauvegardes S3** (PLAN §12.4, décision 3) : dès qu'un compartiment est réglé, `BackupsService.create` demande l'adaptateur `s3` et fixe `disk` ; restauration par lien signé (`download_url`), suppression sans passer par le daemon, 404 local toléré (serveur déplacé, node réinstallé) ; supprimer un serveur efface ses archives du compartiment (`S3Service.discard`). `S3Service` : dépôt ouvert en `application/x-gzip` (seul type que Wings restaure), une adresse par partie exactement (Wings donne le reste à la dernière), aucune empreinte signée d'office (`requestChecksumCalculation: "WHEN_REQUIRED"` : le CRC d'un corps vide faisait refuser chaque partie par Amazon S3, pas par MinIO). Vérifié contre le code réel de Wings et un MinIO. `backups.bytes` en `bigint` (0041). Un point d'accès privé doit figurer dans `restore_host_allowlist` du `config.yml` de Wings.
- **Se connecter avec Google** (PLAN §12.4, décision 4) : bouton facultatif au-dessus du formulaire, réglé dans Administration › Paramètres › Connexion avec Google. `SsoService` sert les deux cérémonies (`oidc` pour l'annuaire, `google`), avec le même rapprochement ; le bouton ne crée un compte que si les inscriptions sont ouvertes, et disparaît quand l'annuaire est obligatoire. Routes `/auth/google`, `/auth/google/start|callback` (API et interface, logique commune dans `apps/web/src/server/ceremony.ts`) ; session `google`. `google-sign-in.integration.test.ts`.
- **API applicative complète et documentée** : `POST users/sso-link` et `PATCH servers/:id` (redimensionnement) ajoutés au catalogue ; toute route applicative doit y figurer. SDK : `suspendServer`/`unsuspendServer` visaient des routes inexistantes (404), corrigés ; `resizeServer` et `ssoLink` ajoutés ; chaque appel du SDK est vérifié contre le catalogue.
- **Audit OWASP ASVS niveau 2** (`docs/securite/rapport-asvs-l2.md`, état de chaque point au §0) : les 64 non-conformités traitées, chacune avec son commit et son test, sauf NC-35 (inscription sans énumération : décision produit). Arbitrages de Matheo : l'API refuse une écriture par cookie venue d'un autre site (`SessionGuard`, règle unique `contracts/src/browser-provenance.ts`, Next transmet `x-gd-origin`/`x-gd-fetch-site`) ; session close après 30 min d'inactivité, 12 h au plus ; second facteur exigé après le lien de facturation ; 2FA du personnel actif par défaut (la CI le lève sur sa base jetable) ; commandes console consignées sans leurs arguments. Secrets chiffrés liés à leur ligne (`v4:`, contexte `table.colonne:id`, `common/row-secrets.ts`) : ne plus revenir à une version antérieure. `APP_SECRET_KEY` de 32 caractères au moins. Nom du cookie de session : `sessionCookie()`, jamais une constante. La production locale porte les mêmes `limit_req` que `infra/prod/panel.conf`. `apps/web` a ses tests Vitest (`src/**/*.test.ts`). Reste : bancs Codiax, pentest externe (§0.5 du rapport).

**La V1 est terminée** (PLAN §12.4 : toutes les décisions tranchées, et le code les suit). Wings suit la dernière version publiée (décision 6, amendement de l'ADR 0001). Les workflows visent par défaut un runner auto-hébergé **Windows avec Docker** : chaque job exécute ses commandes dans son propre conteneur Linux par `infra/ci/linux.sh`, jamais directement sur Windows (`docs/runner-auto-heberge.md`). Le dépôt étant public, les runners de GitHub (`ubuntu-latest`) servent de relève, avec le même conteneur : variable `CI_RUNNER` à `"ubuntu-latest"`, ou entrée `runner` d'une exécution lancée à la main (Run workflow). Tant qu'aucun n'est enregistré, les vérifications se font en local — `pnpm lint && pnpm typecheck && DATABASE_URL=… pnpm test && pnpm db:check && pnpm build`, puis `pnpm e2e`.

- **`infra/prod`** : modèle de production à adapter (la bêta distante est résiliée), `deploy.sh` corrigé (il cherchait le vhost sous le nom du domaine).
- **Installation guidée** : `infra/prod/installer.sh` (panel) et `installer-wings.sh` (machine de jeu), guide pas à pas `docs/installation.md`. Le vhost démarre sur une machine neuve (map `$gd_connection`, `tls-intermediate.conf` livré, `http2` adapté à nginx < 1.25.1) — `infra-prod.test.ts`.
- **Releases** : `release.yml` (étiquette `v*`) rejoue `ci.yml`, compile, assemble (`infra/release/assembler.sh`) et publie l'archive compilée. Côté serveur, une commande : `curl …/releases/latest/download/gamedashboard.sh | sudo bash -s -- install`. `infra/prod/app.sh` est la CLI complète et autonome (publiée `gamedashboard.sh`, installée `/usr/local/bin/gamedashboard`, appelée par les scripts `app:`) : `install`, `setup`, `update` (sauvegarde puis nouvelle version), `backup` (base + `env/`, archive chiffrée, clé `backup.key` hors de `env/`, à garder ailleurs), `start|stop|restart|status|logs`, `admin`, `password`, `wings`, `release`, `help`. Jamais de script sans préfixe portant le nom d'une commande de pnpm (`setup`, `restart`…) : pnpm lance la sienne. Le contrôle de fin de `deploy.sh` cherche `>Une erreur est survenue<` : le texte seul est dans le catalogue embarqué de chaque page.
- **V1.5, facturation multi-fournisseur** : `apps/api/src/modules/billing`. `BillingService` lit `billing.provider` et délègue à `HostbillProvider`, `WhmcsProvider` ou `ClientxcmsProvider` (lecture seule, toutes pages lues) ; « aucun » et « sur mesure » restent silencieux. Un `externalId` n'est suivi que si la fiche du facturier porte la même adresse (il peut venir d'un autre facturier), et seule l'adresse exacte compte (recherches partielles chez HostBill et ClientXCMS). Essai de liaison : `POST /api/v1/admin/settings/billing/test`. Ancres des réglages : `settingsAnchor()`, jamais en dur.
- **Hébergement cPanel** : section du même nom plus haut. `assembler.sh` exclut aussi `.next/dev`, qu'un assemblage fait depuis un poste de travail embarquait (près de 300 Mo). `biome.json` coupe `noUndeclaredEnvVars` pour `infra/**` : la règle vise le cache de turbo, qui ne lance jamais ces fichiers. `app.module.test.ts` câble l'API entière : un module qui oublie un fournisseur ne passe plus les tests.
