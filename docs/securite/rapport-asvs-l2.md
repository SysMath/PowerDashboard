# Rapport d'audit OWASP ASVS 4.0.3 — niveau 2

Consigne : [`audit-asvs-l2.md`](./audit-asvs-l2.md). Périmètre, méthode et
règles y sont définis ; ce rapport ne les répète pas.

| | |
|---|---|
| Code audité | `main` au commit `12ea870` (24 septembre 2026), branche `securite/asvs-l2` |
| Méthode | Lecture du code par zone (les onze zones de la consigne), suite de tests existante, puis **instance jetable** de l'API attaquée avec `curl` (port 3299, `NODE_ENV=production`, base PostgreSQL jetable, aucune donnée réelle) |
| Référence | `pnpm lint` et `pnpm typecheck` passent ; `pnpm test` : 569 tests sur 570 passent, le seul échec est le délai Argon2 de `security-alert.integration.test.ts` déjà consigné comme piège connu |
| Hors périmètre | Wings lui-même, la production locale, les dépendances tierces (`pnpm audit` en CI) |
| Corrections | Faites après l'arbitrage de Matheo : état de chaque non-conformité, commit et test au §0 |

Lignes citées sous la forme `fichier:ligne`, relatives à la racine du dépôt.
Les chemins `apps/api/src/modules/` sont abrégés en `api/`, `apps/web/src/`
en `web/`, `packages/` en `pkg/`.

---

## 0. Suivi des corrections

Corrections faites après l'arbitrage de Matheo, sur la branche
`claude/happy-goldberg-e5zgl2`. Règle suivie : **un défaut, un commit, un
test de non-régression** qui échoue sans la correction (vérifié pour chacun).
Les empreintes ci-dessous sont celles de cette branche.

**Vérification finale** (24 septembre 2026) : `pnpm lint`, `pnpm typecheck`,
`pnpm db:check` (migrations 0042 à 0044), `pnpm openapi` sans différence,
`pnpm build` ; `pnpm test` avec PostgreSQL entièrement vert (API 1 055 tests
en 111 fichiers, contracts 472, auth 142, web 44, et le reste) ; e2e : 50 parcours verts
(authentification, CSP, accessibilité, installation, bureau et mobile),
Lighthouse 100 / 98 / 96 / 100 ; `nginx -t` sur `panel.conf` et
`gamedashboard.local.conf`. Sondes rejouées sur l'application compilée : écriture
par cookie refusée depuis une autre origine (`Origin`, `Sec-Fetch-Site`,
`x-gd-origin`), pages authentifiées en `private, no-store`, API en `nosniff` et
`no-store`.

### 0.1 Arbitrages

| Point (§2.4) | Décision de Matheo | Mise en œuvre |
|---|---|---|
| CSRF (NC-02) | Contrôle d'origine dans l'API, en défense en profondeur, et textes corrigés | `4c10d27` |
| Sessions (NC-03) | Trente minutes d'inactivité, douze heures au plus | `a407e74` |
| Lien de facturation (NC-05) | Le second facteur du panel est exigé | `57c59fa`, `1cb0d55` |
| 2FA du personnel (NC-10) | Actif par défaut | `89a274d` |
| Commandes console (NC-13) | Premier mot et longueur des arguments seulement | `80cbf92` |
| NC-58 (Google et personnel) | Pris en cours de route, **à confirmer** : comportement conservé, le second facteur du personnel étant désormais exigé par défaut et demandé après Google | `92cda16` (test) |

### 0.2 État de chaque non-conformité

| N° | État | Commit | Test de non-régression | Remarque |
|---|---|---|---|---|
| NC-01 | Corrigée | `910df5e` | `billing-sso.integration.test.ts` | Un serveur hors revendeur compte comme un autre revendeur |
| NC-02 | Corrigée | `4c10d27` | `session.guard.test.ts`, `browser-provenance.test.ts`, tests des relais web | `same-site` refusé aussi ; le relais WebSocket accepte désormais le domaine d'un revendeur |
| NC-03 | Corrigée | `a407e74` | `session.repository.test.ts`, `session.repository.integration.test.ts` | Écart : une page qui se rafraîchit seule (onglet visible) compte comme activité |
| NC-04 | Corrigée | `6d1d977` | `security-alert.messages.test.ts`, `credentials.integration.test.ts`, `admin-users.integration.test.ts` | Courriel et cloche, envoi détaché |
| NC-05 | Corrigée | `57c59fa`, `1cb0d55` | `billing-sign-in.integration.test.ts`, `billing-link.test.ts` | Session ouverte au second facteur, dite venue de la facturation |
| NC-06 | Corrigée | `83f3b6f` | `reseller-impersonation.test.ts` | |
| NC-07 | Corrigée | `ef9b30f` | `server-provisioning.integration.test.ts` | Défaut latent : aucun appelant actuel |
| NC-08 | Corrigée | `5345e4b` | `server-provisioning`, `server-resize`, `backups` (intégration, concurrence) | |
| NC-09 | Corrigée, écart | `ef3b919` | `remote-backup.integration.test.ts` | Second compte rendu : 204 ignoré plutôt que 404 (un refus fait effacer l'archive par Wings) |
| NC-10 | Corrigée | `89a274d` | `platform-settings.test.ts`, `infra-prod.test.ts` | La CI lève le réglage sur sa base jetable seule |
| NC-11 | Corrigée | `9fea1ba` | `admin-activity.test.ts` | 43 routes d'écriture tracées, jamais un secret |
| NC-12 | Corrigée | `86d7219` | `denial-log.test.ts`, tests des quatre gardes | Refus répétés écrits à la 1ʳᵉ, 10ᵉ, 100ᵉ occurrence ; hors du journal du serveur visé |
| NC-13 | Corrigée | `80cbf92` | `server-runtime-console.test.ts`, `console-command.test.ts` | Aussi pour les commandes remontées par Wings. Les lignes déjà écrites restent jusqu'à leur rétention |
| NC-14 | Corrigée | `1436f84` | `wings-token.test.ts` | Plus aucun `control.*` ; la sortie d'installation, avalée par l'ancien `*`, arrive enfin |
| NC-15 | Corrigée | `1ae4166` | `server-features-schedules.test.ts` | La mise en pause reste permise |
| NC-16 | Corrigée | `9644c06` | `server-impersonation.test.ts` | Mot de passe de base refusé en prise en main ; emprunteur au journal |
| NC-17 | Corrigée | `7bd5bda` | `file-upload.test.ts` | Cinq envois ouverts par compte et serveur |
| NC-18 | Corrigée | `2d890aa` | `row-secrets.integration.test.ts`, `rekey-secrets.integration.test.ts` | Format `v4:` ; les valeurs `v3:` restent lisibles jusqu'à l'étape § 4 du runbook de la clé maître. **Ne plus revenir à une version antérieure** |
| NC-19 | Corrigée | `5cd25fd` | `secrets.test.ts`, `secret-key-samples.test.ts` | |
| NC-20 | Corrigée, écart | `43f3868` | `credentials.integration.test.ts` | Un compte sans mot de passe local passe sans confirmation (à décider) |
| NC-21 | Corrigée | `29b7094` | `infra-prod.test.ts` | |
| NC-22 | Corrigée | `b6a0a77` | `content-security-policy.test.ts`, `monaco.test.ts`, `e2e/securite.spec.ts` | Monaco 0.56 servi par le panel ; un seul script de worker (contournement Turbopack commenté) |
| NC-23 | Corrigée | `3cd16ce`, `46a7663`, `002b1b2`, `55c6b87` | `admin-bodies.test.ts`, `server-features-inputs.test.ts`, `files.test.ts`, `application-api.test.ts`, `remote.controller.test.ts` | |
| NC-24 | Corrigée | `d8483ce` | `remote-identifiants.test.ts` | 400 au format lu par Wings |
| NC-25 | Corrigée | `0ec4beb` | `impersonation.test.ts` | |
| NC-26 | Corrigée | `20fdaa1` | `ceremony.test.ts` | |
| NC-27 | Corrigée | `f1468fd` | `sso.test.ts` | |
| NC-28 | Corrigée | `d8be427` | `sso-resolve.integration.test.ts` | Migration 0042 : sur une base qui a déjà des doublons de casse, garde l'ancien index et le dit dans le journal de déploiement |
| NC-29 | Corrigée | `38c9bc5`, `8b626d1` | `throttle.test.ts`, `credentials.integration.test.ts`, `login-challenge.integration.test.ts` | La réussite ne se consigne qu'après toutes les preuves |
| NC-30 | Corrigée | `9fa09cd` | `login-challenge.integration.test.ts` | Consommation en base (`auth_tokens`), sans migration |
| NC-31 | Corrigée | `bba5f23` | `credentials.integration.test.ts` | |
| NC-32 | Corrigée | `fb07359` | `login-challenge.integration.test.ts` | |
| NC-33 | Corrigée | `45255ec` | `provisional.test.ts`, `credentials.integration.test.ts` | Migration 0044 ; mot de passe tiré au sort valable 24 h, à changer ; un mot de passe choisi (`GD_PASSWORD`) n'expire pas |
| NC-34 | Corrigée | `b15b26b` | `password.test.ts` | |
| NC-35 | **Non corrigée** | — | — | L'inscription ouvre la session aussitôt : une réponse identique exige de ne plus en ouvrir avant confirmation de l'adresse (SMTP obligatoire pour s'inscrire). Décision produit, limitée aux panels qui ouvrent l'inscription |
| NC-36 | Corrigée | `0798626` | `api-keys.integration.test.ts` | Les clés existantes sans échéance sont laissées telles quelles |
| NC-37 | Corrigée | `dbdb9cd` | `ip-allowlist.test.ts`, intégrations des deux types de clés | |
| NC-38 | Corrigée | `337ac1b` | `api-keys.integration.test.ts`, `application-keys.integration.test.ts` | |
| NC-39 | Corrigée | `a932846` | `retention.test.ts`, `retention.integration.test.ts` | |
| NC-40 | Corrigée | `82807bb` | `admin-write-routes.test.ts` | |
| NC-41 | Corrigée | `fea08a9` | `server-owner.integration.test.ts` | |
| NC-42 | Corrigée | `2d3d5ee` | `server-activity.integration.test.ts` | |
| NC-43 | Corrigée | `d612e12` | `wings-token.test.ts`, `logout-consoles.test.ts` | Par session plutôt que par compte, pour ne pas couper les autres appareils |
| NC-44 | Corrigée | `66e38a1`, lot `reliquats-asvs` | `sftp-auth.test.ts`, `backups.integration.test.ts`, `remote.controller.test.ts`, `server-blocks.test.ts` | `restoring` posé par la restauration (seulement sur un serveur sans état), levé par le compte rendu de Wings (`SendRestorationStatus`, envoyé réussie ou non, issue consignée au journal du serveur), par un refus du daemon, par son redémarrage, ou au bout de six heures sans nouvelles (`RESTORE_STALE_MS`) ; une suspension décidée entre-temps n'est pas levée. Pendant la restauration, supprimer une sauvegarde est refusé (sinon le compte rendu trouvait un 404, que Wings ne rejoue pas). Mot de passe seul d'un compte 2FA documenté (ADR 0001) |
| NC-45 | Corrigée, écart | `d2d0c05` | `remote-activity.integration.test.ts` | Le revendeur et le personnel du serveur sont aussi des auteurs admis |
| NC-46 | Corrigée | `7d0874e` | `server-runtime-paths.test.ts`, `files.test.ts` | Seul le `..` qui sort du volume est refusé (le renommage vers un dossier parent reste possible) |
| NC-47 | Corrigée | `9669849`, lot `reliquats-asvs` | `marketplace-downloads.test.ts` | Jar de plateforme : hôtes relevés sur les réponses réelles (`fill-data.papermc.io`, `api.purpurmc.org`, `meta.fabricmc.net`, `piston-data.mojang.com`, `launcher.mojang.com`), sans identifiants ni port, nom de fichier simple ; refus avant l'arrêt du serveur (`isTrustedEngineDownload`). L'adresse de version du manifeste de Mojang, suivie par le panel, est bornée à `piston-meta`/`launchermeta.mojang.com` |
| NC-48 | Corrigée | `67a2853` | `server-daemon-errors.test.ts`, `application-daemon-errors.test.ts` | |
| NC-49 | Corrigée | `54c476c`, `c4d8c6f` | `infra-prod.test.ts` | 503 et non 429 (Wings ne rejoue que les 5xx) ; la production locale n'avait **aucune** limitation, elle a désormais celles du modèle |
| NC-50 | Corrigée | `c7aa452` | `infra-prod.test.ts`, `response-headers.test.ts` | Pas de `preload` ni d'agrafage OCSP : Let's Encrypt n'en publie plus |
| NC-51 | Corrigée | `2b886ec` | `auth-cookies.test.ts` (contrats et API) | Avec un défaut trouvé en passant : un effacement sans `Secure` laissait le cookie `__Host-` en place à la déconnexion |
| NC-52 | Corrigée | `4ae7d01` | `infra-prod.test.ts` | Archive `.tar.enc`, clé `/opt/gamedashboard/backup.key` hors de `env/`, à conserver ailleurs |
| NC-53 | Corrigée | `633f360` | `design/page.test.tsx` | Captures de référence reprises sur le runner (`88351e9`) : l'entrée « Design system » quitte la navigation, et la rétention de NC-39 ajoute une ligne à la vue d'ensemble de l'administration |
| NC-54 | Corrigée | `de2626d` | `credentials.integration.test.ts` | |
| NC-55 | Corrigée | `ba7aaca` | `node-load.test.ts` | |
| NC-56 | Corrigée | `fb53f8c` | `instatus.service.test.ts`, `platform-settings.test.ts` | |
| NC-57 | Corrigée | `995b67e` | `infra-prod.test.ts` | Trois vhosts : modèle, production locale, domaines de revendeurs |
| NC-58 | Conservée | `92cda16` | `google-sign-in.integration.test.ts` | Voir §0.1 |
| NC-59 | Corrigée | `84add95` | `admin-users.integration.test.ts` | |
| NC-60 | Corrigée | `11e5876`, `2f2fc6a` | `staff-2fa.guard.test.ts`, `credentials.integration.test.ts` | |
| NC-61 | Documentée | `14ebad9` | — | PLAN §5.5 décrit la lecture réelle du jeton |
| NC-62 | Documentée | `f8093fe` | — | ADR 0007 |
| NC-63 | Documentée | `60742d2` | — | `docs/securite/modele-de-menace.md` |
| NC-64 | Corrigée | `d0573d8`, `e5faa98`, `e1b1fba`, `3d2d143` | `ceremony.test.ts`, `api-key.repository.integration.test.ts`, `ip-allowlist.test.ts`, `staff-2fa.guard.test.ts`, `admin-write-routes.test.ts`, `server-idor.integration.test.ts` | Aucun IDOR trouvé |

### 0.3 Doutes du §7

| N° | Issue | Preuve |
|---|---|---|
| D-1 | Sans objet : le jeton de console ne porte plus d'ordre (NC-14) | `wings-token.test.ts` |
| D-2 | **Ouvert** : demande Wings, à rejouer sur Codiax (`verifier-transfert.sh`) | — |
| D-3 | Confirmé, corrigé : tout ce qui suit la lecture du compte part en tâche détachée | `165465b`, `forgot-password-timing.test.ts` |
| D-4 | Conservé : repli ouvert quand HIBP est injoignable, journalisé (l'inscription et le changement de mot de passe ne dépendent pas d'un tiers). À trancher si le niveau 2 strict est visé | `packages/auth/src/policy.ts:90-91` (`pwnedCheckFailed`) |
| D-5 | Confirmé, corrigé : `AdminGuard` refuse toute session empruntée | `7b83b49`, `impersonation-promotion.integration.test.ts` |
| D-6 | Tranché : le défi d'une cérémonie est à usage unique et consommé en base (NC-30, NC-32) ; un compteur à zéro est celui des clés synchronisées, admis par WebAuthn | `login-challenge.integration.test.ts` |
| D-7 | Confirmé, corrigé : index unique `(user_id, provider)` (migration 0043) | `dd18811`, `sso-resolve.integration.test.ts` |
| D-8 | Sans objet pour le panel : aucune adresse de fournisseur n'atteint `pullFile` hors des listes d'hôtes (NC-47), jar de plateforme compris ; le comportement de Wings seul reste à voir sur Codiax | `marketplace-downloads.test.ts` |
| D-9 | Conforme : `private, no-cache, no-store` sur les pages, authentifiées ou non | Sonde sur l'application compilée |
| D-10 | Confirmé, corrigé : un transfert ne sort plus un serveur du périmètre de son revendeur | `97b1074`, `server-transfer-perimetre.integration.test.ts` |

### 0.4 Défauts trouvés hors du rapport, corrigés

| Commit | Défaut | Test |
|---|---|---|
| `1cb0d55` | **Le lien de la facturation ne connectait personne** : la page posait le cookie pendant son rendu, ce que Next interdit ; chaque arrivée sans second facteur finissait en 500, session ouverte côté API et jamais remise au navigateur. Reproduit sur une instance jetable | `billing-link.test.ts` |
| `11c698c` (PowerNexus/PowerDashboard#24) | Suite du précédent : derrière nginx, les redirections bâties sur `request.nextUrl.origin` renvoyaient le client vers l'adresse d'écoute de Next (`https://localhost:3210/`), sans son cookie de session ; les retours de l'annuaire et de Google avaient le même défaut. Redirections relatives (`redirectWithin`), le client reste sur le domaine d'arrivée, plateforme ou revendeur | `e2e/facturation.spec.ts`, `ceremony.test.ts`, `billing-link.test.ts` |
| `9835769` | Quota de ports compté hors transaction : cinq demandes simultanées passaient toutes (même défaut que NC-08) | `allocations.integration.test.ts` |
| `8be4083` | Rétention : décompte lu sous `rowCount`, que postgres-js n'expose pas — l'écran annonçait toujours « 0 ligne », et une seule tranche par heure | `retention.integration.test.ts` |
| `efdeafa` | Nettoyage des bases de test : il coupait aussi l'autovacuum, superutilisateur, et le fichier échouait au nettoyage, tous ses tests verts | `throwaway-database.integration.test.ts` |
| lot `reliquats-asvs` | Le mot de passe provisoire d'un compte créé depuis l'administration (`AdminActionsService.createUser`) n'avait pas d'échéance, contrairement à ceux de `create-admin` et `reset-password` (NC-33) : 24 h, après quoi la connexion **et le SFTP** le refusent (le SFTP ne lisait pas l'échéance, scripts compris) ; avant, la première connexion mène à la page de changement, sans l'imposer route par route. Les comptes créés avant ce lot ne sont pas touchés (§0.5) | `admin-create-user.test.ts`, `sftp-auth.test.ts` |
| lot `reliquats-asvs` | `SsoService.refresh` remplaçait l'adresse du compte par celle du fournisseur sans prévenir le titulaire (ASVS 2.5.5) : avis à l'ancienne adresse (cloche, et courriel si elle était confirmée), liens de réinitialisation et de vérification déjà partis éteints, comme pour un changement fait par l'administration | `google-sign-in.integration.test.ts` |
| `0239c39` | Le « piège connu » de la consigne (`security-alert` › panne de courrier) n'était pas Argon2 : le test libérait l'envoi avant son départ et attendait pour toujours. La connexion, elle, répondait en 78 ms | le test lui-même, trois exécutions vertes |

### 0.5 Ce qui reste, et pourquoi

- **Décisions produit** : NC-35 (inscription sans énumération), ré-authentification
  des comptes sans mot de passe local (NC-20), sort des clés personnelles
  existantes sans échéance (NC-36), réécriture des anciennes lignes de journal
  de console (NC-13), repli HIBP (D-4), NC-58.
- **Hors de portée d'une session distante** (Wings et nginx réels, sur Codiax) :
  `verifier-sauvegardes.sh`, `verifier-sftp.sh`, `verifier-transfert.sh` (D-2),
  `verifier-cycle-serveur.sh`, `verifier-console.sh` (adapté par NC-14 : la
  console envoie ses commandes par l'API) ; recharger nginx pour la production
  locale.
- **À l'exploitation** : jouer l'étape § 4 du runbook de la clé maître (NC-18)
  une fois la version en service ; conserver `backup.key` hors de la machine
  (NC-52).
- **Restes signalés** : corrigés par le lot `reliquats-asvs` (NC-44, NC-47 et
  deux lignes du §0.4). Limites connues : un éditeur de plateforme qui change
  de domaine fait refuser l'installation de son jar jusqu'à ce que la liste
  `ENGINE_DOWNLOAD_HOSTS` (`engine-sources.ts`) le suive ; le changement du
  mot de passe provisoire est proposé à la première connexion, pas imposé
  (l'échéance de 24 h tient ASVS 2.3.1).
- **Comptes créés par l'administration avant ce lot** : leur mot de passe tiré
  au sort n'a pas d'échéance. Pour les repérer (lecture seule), puis leur
  envoyer un lien de réinitialisation depuis l'administration :

  ```sql
  SELECT u.id, u.email, u.role, a.at AS cree_le, u.last_login_at
  FROM activity_logs AS a
  JOIN users AS u ON u.id::text = a.properties ->> 'userId'
  WHERE a.event = 'admin.user_created'
    AND (a.properties ->> 'withPassword')::boolean
    AND u.password_hash IS NOT NULL
    AND u.password_expires_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM activity_logs AS b
      WHERE b.actor_id = u.id
        AND b.event IN ('account.password', 'account.password_reset')
        AND b.at > a.at)
  ORDER BY a.at;
  ```
- **Pentest externe** : non fait. Recommandé avant une ouverture au public.

---

## 1. Résumé

Le socle est solide : Argon2id, sessions opaques de 256 bits hachées en base,
cookie `__Host-`/`HttpOnly`/`Secure`/`SameSite=Lax`, TOTP anti-rejeu, codes de
secours hachés, jetons à usage unique atomique, verrou anti-bruteforce en base,
point unique de décision d'accès aux serveurs (aucun IDOR trouvé sur 75
routes), secrets réversibles en AES-256-GCM, actions CI épinglées par SHA,
SBOM attesté. Les sondes dynamiques confirment : pas d'énumération de comptes,
pas de fixation de session, déconnexion effective, 2FA non rejouable.

**Une non-conformité haute** : une clé applicative de revendeur ouvre, par le
lien de facturation, une session **complète** sur le compte d'un client qui a
aussi des serveurs chez d'autres revendeurs.

**Vingt-trois moyennes**, dont quatre points d'architecture qu'il faut trancher
plutôt que corriger à la volée : le CSRF (la protection documentée « Origin +
double soumission » **n'existe pas**, la défense réelle est `SameSite=Lax` et
le fait que nginx n'expose pas l'API cliente), l'absence d'expiration
d'inactivité des sessions, l'absence de toute notification au titulaire quand
son mot de passe ou son second facteur change, et le second facteur ignoré
après un lien de facturation. Le reste des moyennes tient en corrections
locales : quotas revendeur contournables par la boutique et non verrouillés,
prise en main d'un revendeur en écriture, comptes rendus de sauvegarde acceptés
pour une sauvegarde close, gestes d'administration et refus d'accès non
journalisés, commandes console consignées en clair, 2FA du personnel inactif
par défaut.

**Quarante basses**, listées en §2.3 ; aucune n'est exploitable seule.

---

## 2. Non-conformités par gravité

Constat au moment de l'audit ; l'état de chacune, commit et test, est au §0.2.

Gravité = exploitabilité × impact, pas le niveau ASVS. « Correction » décrit
le changement minimal ; chaque correction viendra avec son test de
non-régression qui échoue sur le code actuel (règle du dépôt).

### 2.1 Haute

| N° | Exigence | Constat | Preuve | Correction |
|---|---|---|---|---|
| NC-01 | 4.1.3, 4.2.1 | **Le lien de facturation d'un revendeur ouvre une session complète sur un client partagé.** Il suffit qu'*un* serveur du client relève du revendeur ; la session obtenue gère tout le compte : serveurs chez d'autres revendeurs, clés d'API, clés SSH. La règle « tous les serveurs ou rien » existe pourtant pour le choix du domaine. | `api/auth/billing-sso.service.ts:148-159` (un seul `limit(1)`) contre `:225-233` (`selectDistinct`, refus si plusieurs revendeurs) ; session complète `api/auth/auth.controller.ts:1283` ; `reseller-perimeter.test.ts` ne couvre pas `sso` | Dans `issue`, quand `resellerId !== null`, refuser (même `NotFoundException`) dès qu'un `resellerId` distinct apparaît parmi les serveurs du client |

### 2.2 Moyenne

| N° | Exigence | Constat | Preuve | Correction |
|---|---|---|---|---|
| NC-02 | 4.2.2, 13.2.3 | **CSRF : l'API ne vérifie ni `Origin`, ni `Sec-Fetch-Site`, ni aucun jeton.** L'affirmation « l'API vérifie Origin et un jeton en double soumission » est fausse et sert de justification à l'exception ZAP 10202. L'API parse `application/x-www-form-urlencoded` (Nest l'enregistre), donc un `<form>` HTML produit un corps valide. La défense réelle : `SameSite=Lax`, le contrôle d'origine natif des actions serveur de Next, et nginx qui n'expose pas `/api/v1/auth`, `/client`, `/admin` (seuls `/api/v1/application/`, `/api/remote/`, `/api/application/`, `openapi.json`, `status`). Le relais `upload-chunk` n'a pas de contrôle d'origine, contrairement au relais `websocket`. | `api/auth/session.guard.ts:57-68` ; `apps/api/src/main.ts:62-65` ; sonde 1.2 (form-urlencoded → 422 de Zod, donc parsé) et 1.7 (GET avec `Origin: https://evil.example` + cookie → 200) ; `infra/ci/zap-regles.tsv:14` ; `PLAN.md` §5.4 et §7.1 ; `infra/prod/panel.conf:105-174` ; `web/app/api/upload-chunk/[serverId]/[uploadId]/[index]/route.ts:22-31` contre `web/app/api/servers/[id]/websocket/route.ts:29-36` | **À arbitrer.** (a) Corriger les trois textes ; (b) défense en profondeur : Next transmet `origin`/`sec-fetch-site` à l'API, `SessionGuard` refuse une requête mutante par cookie dont l'origine n'est pas `PANEL_ORIGIN` ; (c) même contrôle sur `upload-chunk` ; (d) test du garde |
| NC-03 | 3.3.2 | **Sessions : 7 jours absolus, aucune expiration d'inactivité.** Le niveau 2 exige 12 h, ou 30 min d'inactivité. `lastSeenAt` est écrit mais jamais lu pour refuser. | `api/auth/session.repository.ts:45` (`SESSION_TTL_MS`), `:140` (`expiresAt` fixé à la création), `:184` (`resolve` ne teste que `expiresAt`/`revokedAt`), `:231` (`touch` n'écrit que `lastSeenAt`) ; sonde 1.5 (`Max-Age=604800`) | **À arbitrer** (confort contre exigence). Refuser dans `resolve` une session inactive depuis N min ; ramener l'absolu à 12 h ou documenter l'écart |
| NC-04 | 2.2.3, 2.5.5 | **Aucune notification au titulaire** lors d'un changement de mot de passe, d'une réinitialisation aboutie, de l'activation ou désactivation du 2FA, de l'ajout ou retrait d'une clé d'accès, ni à l'ancienne adresse lors d'un changement d'adresse. Seules existent : alerte après 5 échecs, alerte nouvel appareil. | `api/auth/auth.controller.ts:604-690` (mot de passe : `activity.record` seul), `:783-841`, `:1135`, `:1205`, `:1591`, `:1660` ; envois de courriel limités à `account-mail.service.ts:54,73` et `security-alert.service.ts:20-21` ; `api/admin/admin-users.service.ts:98-111` (nouvelle adresse seulement) | Une méthode `afterCredentialChange(userId, kind)` dans `SecurityAlertService`, appelée depuis ces routes et depuis `AdminUsersService.update` (vers l'ancienne adresse) |
| NC-05 | 2.8, 3.x | **Le lien de facturation ouvre la session sans le second facteur du panel**, alors que le chemin SSO/Google le demande « quel que soit le chemin d'entrée ». | `api/auth/auth.controller.ts:1267-1284` (`issueSession` direct) contre `:1465-1480` | **À arbitrer** (le facturier est-il un IdP de confiance suffisant ?). Sinon : reprendre les lignes 1471-1480 dans `billingConsume`, et côté web traiter `twoFactorRequired` comme `ceremony.ts:121-147` |
| NC-06 | 4.1.3, 7.1.3 | **Prise en main d'un revendeur en écriture.** Le garde lecture seule n'est pas posé sur `ResellerController`, et un compte `reseller` est une cible admise. L'agent agit sous le nom du revendeur : il peut se donner le consentement « provisionnement plateforme », créer une clé, supprimer un serveur. | `api/reseller/reseller.controller.ts:87` (gardes sans `ImpersonationReadOnlyGuard`) ; `api/admin/admin-actions.service.ts:214` (seuls `admin`/`support` refusés) ; journal imputé au revendeur `reseller.controller.ts:244-248` | Ajouter `ImpersonationReadOnlyGuard` à `reseller.controller.ts:87` ; en ceinture, refuser `target.role === "reseller"` |
| NC-07 | 4.1.3, 11.1.4 | **La création guidée (offres, boutique) ne vérifie jamais l'enveloppe du revendeur.** Seul le chemin explicite appelle `assertRoom`. Une clé de revendeur crée des serveurs au-delà de `memoryMb`/`diskMb`/`serversMax`. | `api/client/server-provisioning.service.ts:133-136`, `:446-479` (`placeGuided` rend `resellerId` sans quota), unique appel `:590` | Après `:136` : `if (resellerId) await this.quotas.assertRoom(resellerId, { memoryMb: plan.memoryMb, diskMb: plan.diskMb })` |
| NC-08 | 11.1.6 | **Quotas sans transaction ni verrou** : revendeur (création, redimensionnement) et sauvegardes. N requêtes parallèles à `max - 1` passent toutes. | `api/reseller/reseller-quota.service.ts:217-243` ; `api/client/server-resize.service.ts:153-168` ; `api/client/backups.service.ts:101-125` (contre `databases.service.ts:127` et `allocations.service.ts:101` qui verrouillent) | Contrôle + écriture dans une transaction avec `for update` sur `reseller_quotas` / `servers` |
| NC-09 | 4.1.3, 12.x | **Compte rendu de sauvegarde accepté pour une sauvegarde close.** Un node compromis réécrit l'archive S3 d'une sauvegarde terminée (restaurée plus tard sur un node sain), ou bascule une sauvegarde `local` en `s3`. | `api/remote/remote-backup.service.ts:55-62` et `:94-106` (`where` sans `isNull(completedAt)` ni `disk = 's3'`), `:79` (`disk: "s3"` inconditionnel) | Ajouter `isNull(backups.completedAt)` aux deux `where`, et `eq(backups.disk, "s3")` dans `openUpload` |
| NC-10 | 4.3.1 | **2FA du personnel désactivé par défaut.** Sur l'instance jetable, l'administrateur fraîchement créé, sans second facteur, lit `/admin/settings`. Le commentaire du réglage explique le choix (installation neuve). | `pkg/contracts/src/platform-settings.ts:356-377` (`fallback: false`) ; `api/admin/staff-2fa.guard.ts:42` ; sonde : `GET /api/v1/admin/settings` → 200 sans 2FA | **À arbitrer.** `fallback: true` (l'espace client reste ouvert pour enrôler), ou activation automatique dès que le premier administrateur a un second facteur, plus une ligne dans `docs/installation.md` |
| NC-11 | 7.1.3 | **Gestes d'administration sans trace d'activité** : changement de rôle, création et suppression de compte, révocation de sessions, enveloppe revendeur, suspension et suppression de serveur, transfert, suppression de node, parts, maintenance, **réglages de plateforme** (dont `security.staffRequires2fa`). Aucun service `admin/*` ni `reseller/*` n'injecte `ActivityService`. | `api/admin/admin.controller.ts:621-632` (rôle), `:248-270` (réglages), `:688-693`, `:953-971`, `:1084-1089` ; 17 événements `admin.*` en tout | `activity.record(...)` dans chaque handler, sur le modèle de `admin.controller.ts:872-880` |
| NC-12 | 7.2.2, 7.1.3 | **Refus d'accès et rejets de jetons non journalisés** : `ServerAccessService`, `AdminGuard`, `ApplicationGuard`, `NodeTokenGuard` refusent en silence. Un jeton de node volé essayé d'ailleurs ne laisse rien. | `api/client/server-access.service.ts:95` ; `api/admin/admin.guard.ts:42` ; `api/application/application.guard.ts:76-79` ; `api/remote/node-token.guard.ts:36,46` | Événements `access.denied`, `node.token_rejected`, `application.key_rejected` (route, IP, sans secret) |
| NC-13 | 7.1.1, 8.3.4 | **Commandes console journalisées avec leur contenu**, lisibles par `activity.read` (preset `viewer`), conservées 365 j et exportées en CSV. Un `/login <mot de passe>` (AuthMe) ou `rcon_password …` y figure. | `api/client/server-runtime.controller.ts:139` ; `pkg/contracts/src/permissions.ts:59` ; `api/scheduler/retention.service.ts:163-165` | Ne consigner que le premier mot et la longueur, ou masquer les arguments des commandes connues (`login`, `register`, `changepassword`, `rcon_password`) |
| NC-14 | 4.1.1, 4.1.3 | **Le jeton WebSocket ouvre une porte parallèle** : il scelle `control.console`/`control.*` pour qui a `console.send`/`power.*`, sans passer par `requireOperable` (serveur suspendu, en installation, en transfert) ni par le journal du panel (l'interface, elle, envoie tout par l'API). Le journal de Wings (`/api/remote/activity`) compense partiellement. | `api/client/server-runtime.controller.ts:154-169` (pas de `requireOperable`) ; `api/wings/wings-token.service.ts:20-32` ; `web/lib/use-server-socket.ts:271-289` | N'émettre que `websocket.connect`, `backup.read` et, pour le propriétaire, `admin.websocket.install` ; **doute** : Wings refuse-t-il `set state` sur un serveur suspendu ? À vérifier avec `infra/local/verifier-console.sh` |
| NC-15 | 4.1.3, 4.2.1 | **Exécuter ou réactiver une planification n'exige pas les permissions de ses tâches.** Un sous-utilisateur `schedules.update` sans `power.stop` arrête le serveur par `POST schedules/:id/run`. Le contrôle existe à la création et à la modification seulement. | `api/client/server-features.controller.ts:581-614` contre `:514-530` (`requireTaskPermissions`, appelé `:547`, `:568`) | Relire les tâches et appeler `requireTaskPermissions` dans `runSchedule` et `setScheduleActive` |
| NC-16 | 7.1.3, 4.1.1 | **En prise en main, des `GET` à effet sont permis et imputés au client** : lien de téléchargement de fichier, de sauvegarde, révélation du mot de passe d'une base. Le journal n'écrit jamais `impersonator`. | `api/auth/impersonation.guard.ts:53-54` ; `api/client/server-runtime.controller.ts:357-369`, `:588` (`actorId: request.user.id`) ; `api/client/server-features.controller.ts:182-193`, `:264-275` | Refuser ces trois routes quand `request.user.impersonator` est posé, ou ajouter l'emprunteur aux `properties` du journal |
| NC-17 | 12.1.3 | **Envoi reprenable sans plafond de sessions** : 5 Gio par fichier, morceaux sur le disque du panel, aucun compteur par utilisateur ; balayage seulement après 6 h d'inactivité. | `api/client/file-upload.service.ts:88-130` (`open()` sans comptage), `:50`, `:53`, `:78` | Refuser (409) au-delà de N sessions ouvertes pour le couple utilisateur/serveur |
| NC-18 | 6.2.3, 8.3.7 | **Le contexte AAD de `encryptSecret` n'est employé par aucun appelant.** Qui écrit en base permute deux colonnes chiffrées (secret TOTP de deux comptes, mot de passe de base de deux serveurs, jeton de deux nodes) sans que GCM le détecte. | `pkg/auth/src/secrets.ts:105-116` (`context` facultatif) ; appels à un seul argument : `api/auth/two-factor.repository.ts:127`, `api/client/databases.service.ts:144,188`, `api/admin/node-configuration.service.ts:160`, `api/admin/infrastructure.service.ts:335`, `api/admin/database-hosts.service.ts:142,177`, `api/client/server-webhooks.service.ts:126,184`, `api/webhooks/webhook-registry.service.ts:219,246`, `api/admin/platform-settings.service.ts:383` ; `apps/api/src/common/rekey.ts:31` ne gère pas l'AAD | Passer `"<table>.<colonne>:<id>"` aux paires chiffrer/déchiffrer des colonnes par ligne (TOTP, bases, nodes d'abord) ; adapter `rekey.ts` ; l'ancien format reste lu |
| NC-19 | 6.4.1, 2.10.4 | **Aucune longueur minimale pour `APP_SECRET_KEY`** : `APP_SECRET_KEY=motdepasse` démarre ; scrypt avec sel public, donc dictionnaire possible sur une copie de la base. | `pkg/auth/src/secrets.ts:73-84` (`if (!secret)` seul) ; `apps/api/.env.example:15-16` recommande sans imposer | Refuser `secret.length < 32` dans `derivedKey` ; test dans `secrets.test.ts` |
| NC-20 | 3.7.1, 2.8.6 (esprit) | **Enrôlement d'un second facteur, d'une clé d'accès, d'une clé SSH et création d'une clé d'API sans ré-authentification.** Une session volée enrôle son propre TOTP et se crée une clé d'API sans fin. Désactiver le 2FA, régénérer les codes, retirer une clé exigent bien le mot de passe. | `api/auth/auth.controller.ts:1108-1109`, `:1569`, `:1591`, `:1501-1502` ; `api/client/account.controller.ts:71-73` ; sonde 3.9-3.10 (DELETE 2fa → 422 « Mot de passe attendu » ; POST api-keys → 201 sans mot de passe) | Faire passer `2fa/setup`, `2fa/passkeys/options`, `ssh-keys` et `POST api-keys` par `confirmedUser` |
| NC-21 | 14.2.6, 1.14 | **`ci.yml` sans `permissions:`** : le `GITHUB_TOKEN` reçoit les droits par défaut du dépôt, sur un runner auto-hébergé, avec Semgrep en conteneur root. `release.yml` et `captures.yml` posent `contents: read`. | `.github/workflows/ci.yml` (aucune occurrence) ; `.github/workflows/release.yml:33` | `permissions: { contents: read }` en tête de `ci.yml` |
| NC-22 | 14.2.3, 10.3.2 | **Monaco chargé depuis `cdn.jsdelivr.net` sans SRI**, et la CSP l'autorise en `script-src`. Compromission du CDN ou du paquet → script exécuté dans le panel. | `web/lib/content-security-policy.ts:18,35` ; `web/components/code-editor.tsx:4` (chargeur CDN par défaut de `@monaco-editor/react`) ; aucun `integrity=` | Installer `monaco-editor`, `loader.config({ monaco })`, retirer `cdn.jsdelivr.net` de la CSP |
| NC-23 | 5.1.3, 5.1.4, 13.2.2 | **Validation positive non uniforme** : pas de pipe global ; plusieurs routes lisent le corps par `typeof` (nodes, localisations, rôle) ; champs sans borne (`command`, `dockerImage`, `startup`, `bodyMd`, `RenameRequest.to`, `CreateUser`/`CreateServer` applicatifs) ; e-mail d'invitation validé par `includes("@")` ; `per_page` de l'inventaire Wings non plafonné. Seule borne : corps Fastify 1 Mo. | `apps/api/src/main.ts` (aucun `useGlobalPipes`) ; `api/admin/admin.controller.ts:1057-1080`, `:1028-1036`, `:628-629` ; `api/client/server-runtime.controller.ts:130-133` ; `pkg/contracts/src/files.ts:155` ; `api/client/server-features.controller.ts:407-410` ; `api/remote/remote.controller.ts:92-97` | `.max()` sur ces champs, `z.string().email()` pour l'invitation, `Math.min(perPage, 500)`, schémas Zod pour nodes/localisations/rôle |
| NC-24 | 7.4.1, 13.x | **Routes `remote` : un identifiant mal formé produit un 500**, que Wings traite comme une panne et rejoue avec temporisation exponentielle. | Sonde 5 : `GET /api/remote/servers/pas-un-uuid` → 500 « Erreur interne du panel » ; idem `POST …/install`, `GET /backups/pas-un-uuid` ; `api/remote/remote.controller.ts:129,143,153,190,209,255,275` (`:uuid` passé tel quel à `eq(servers.id, …)`) | `ParseUUIDPipe` sur chaque `@Param("uuid")` (→ 400, définitif pour Wings) |

### 2.3 Basse

| N° | Exigence | Constat | Preuve | Correction |
|---|---|---|---|---|
| NC-25 | 3.4.4 | Le cookie `gd_return` (jeton de session de l'agent pendant une prise en main) n'a pas le préfixe `__Host-`. | `api/auth/impersonation.ts:19` ; `api/admin/admin.controller.ts:762-767` ; `web/server/api/session.ts:10` | `__Host-gd_return` en production, comme `session.guard.ts:12` |
| NC-26 | 3.5.1 | Cookie `state`/PKCE conservé après un retour OAuth en échec (10 min) : login CSRF résiduel si l'attaquant apprend le `state`. | `web/server/ceremony.ts:69` (`fail` ne l'efface pas) contre `:136` | Effacer le cookie sur chaque sortie `fail` une fois lu |
| NC-27 | 2.7, 5.1 | `preferred_username` accepté comme adresse, `email_verified` lu à part : un annuaire OIDC mal configuré rapprocherait `admin@…` fourni par l'utilisateur. Google non concerné. | `pkg/contracts/src/sso.ts:62-68` ; `api/auth/sso.service.ts:278` | Retirer `preferred_username`, ou forcer `emailVerified = false` quand l'adresse ne vient pas de `email` |
| NC-28 | 5.1 | Index unique sur `email` sensible à la casse ; lectures en `lower()`, écritures SSO telles quelles. | `pkg/db/migrations/0000_familiar_scorpion.sql:629` ; `api/auth/sso.service.ts:336,402` contre `api/application/application.service.ts:143` | `.toLowerCase()` aux deux écritures ; migration vers un index sur `lower(email)` |
| NC-29 | 2.2.1 | Verrou par compte (10 échecs, 15 min) déclenchable par un tiers ; le captcha ne protège que s'il est configuré (défaut : non). | `pkg/auth/src/throttle.ts:15,41` ; `api/auth/turnstile.service.ts:75` ; sonde 2.G (429 après 10 échecs) | Exempter du verrou les IP ayant déjà réussi une connexion sur ce compte (colonne `success` existante) |
| NC-30 | 2.9.1, 3.2 | Liste des défis consommés en mémoire d'un seul processus : rejeu possible sur une autre instance ou après redémarrage, 5 min. Le même contrôleur suppose ailleurs plusieurs instances. | `api/auth/login-challenge.ts:118` contre `api/auth/auth.controller.ts:1297,1566` | Consommer le `jti` en base (`auth_tokens`), ou documenter « un seul processus API » |
| NC-31 | 2.5.6 | Jetons de réinitialisation non révoqués au changement de mot de passe (valables jusqu'à 1 h). | `api/auth/auth.controller.ts:604-690` ; `revokePending` appelé seulement `admin-users.service.ts:105,253` | `revokePending(user.id, ["password_reset"])` après `:672` |
| NC-32 | 3.2.1 | Le défi `login` survit à une connexion par clé d'accès (seul `passkey-login` est consommé). | `api/auth/auth.controller.ts:1717-1780` contre `:422` | Transporter et consommer le défi `login` dans le retour passkey |
| NC-33 | 2.3.1 | Mots de passe initiaux des scripts (`create-admin`, `reset-password`) sans expiration ni changement forcé ; l'API applicative, elle, ne pose aucun mot de passe. | `apps/api/scripts/create-admin.mts:40-56` ; `reset-password.mts:71` ; `api/application/application.service.ts:181` | Colonne `password_expires_at` posée par les scripts, refusée à `login` avec redirection vers le changement |
| NC-34 | 2.1.8 | Pas d'indicateur de force à l'écran (la politique serveur est bonne). | `web/components/register-form.tsx:59`, `password-form.tsx:134` ; grep `zxcvbn|strength` vide | Compteur ou jauge sous `PasswordInput` |
| NC-35 | 2.2.1 | L'inscription répond 409 « Un compte existe déjà » : énumération, assumée en commentaire, limitée aux panels qui ouvrent l'inscription. | `api/auth/auth.controller.ts:912-920,962` ; sonde 2.B | Répondre 200 et envoyer « vous avez déjà un compte » à l'adresse |
| NC-36 | 2.10.1, 3.5.2 | Clés d'API personnelles sans expiration par défaut (les applicatives sont bornées à 365 j). | `api/client/api-keys.service.ts:70-71,95-98` ; `api/client/account.controller.ts:85` | Défaut `CLIENT_KEY_MAX_DAYS` quand la valeur est absente |
| NC-37 | 2.10 | Liste d'IP : `0.0.0.0/0` accepté (ne restreint rien) ; clés applicatives validées par une regex seule, sans CIDR. | `pkg/auth/src/ip-allowlist.ts:28-31` ; `api/application/application-keys.service.ts:144-149` | `isAllowlistEntry` partout, `bits >= 1` |
| NC-38 | 2.10 | Aucun plafond du nombre de clés par compte ; lignes révoquées conservées. | `api/client/api-keys.service.ts:65-138` ; `api/application/application-keys.service.ts:79-196` | Compter avant insertion, refuser au-delà de 20 |
| NC-39 | 8.3.8 | `idempotency_records` jamais purgés, avec la réponse complète mémorisée (e-mail, nom du compte créé). | `api/scheduler/retention.service.ts:75-165` (table absente) ; `api/application/idempotency.service.ts:92-98` | Ligne de rétention 30 j |
| NC-40 | 8.3.4 | `GET /admin/settings` lisible par `support` : secrets masqués, mais identifiants (`s3.accessKey`, `sso.clientId`, hôtes SMTP/S3) en clair. | `api/admin/admin.controller.ts:184-187` (sans `AdminWriteGuard`) ; `api/admin/admin.guard.ts:10` | `AdminWriteGuard` sur cette lecture |
| NC-41 | 4.1.5 | Changement de propriétaire sans révocation des jetons de console de l'ancien (10 min). La suspension et le retrait d'un sous-utilisateur révoquent. | `api/admin/admin-server.service.ts:211-249` (aucun appel à `WingsTokenService`) contre `admin-actions.service.ts:301-304` | `revocableForServer` puis `denyWebsocketTokens` après l'`update` |
| NC-42 | 8.3.x | `activity.read` (preset `viewer`) expose l'adresse IP de chaque acteur et (NC-13) les commandes. | `api/activity/activity.service.ts:168-189` ; `pkg/contracts/src/permissions.ts:59` | Masquer `ip` quand `isOwner: false` |
| NC-43 | 3.5.1 | Jetons WebSocket non révoqués à la déconnexion (console ouverte 10 min après `logout`). | `api/auth/auth.controller.ts:583-587` ; `denyWebsocketTokens` appelé seulement pour suspension et retrait | Révoquer les jetons de l'utilisateur dans `logout` |
| NC-44 | 2.2.1, 5.5 | SFTP : `transferring` non fermé ; état `restoring` jamais posé ; limitation par IP seulement (`Map` non purgée) ; mot de passe seul sans second facteur (parité Pterodactyl). | `api/remote/sftp-auth.service.ts:62,56-59,91-95,175-176` ; `api/client/backups.service.ts:196-210` | Ajouter `transferring` ; poser `restoring` ; clé `username` seule ; documenter ou refuser le mot de passe pour un compte 2FA |
| NC-45 | 7.3.4, 7.1.4 | Activité remontée par Wings : `user` doit exister mais pas être lié au serveur (attribution à n'importe quel compte), `ip` non validée (échec du lot entier → 500 → réessais), horodatage libre. | `api/remote/remote-activity.service.ts:57-83`, `:232-268` | Exiger propriétaire ou sous-utilisateur ; `net.isIP` ; borner `at` |
| NC-46 | 12.3.1, 12.3.2 | Chemins de fichiers relayés à Wings sans validation panel (`..`, `\0`) ; le confinement repose sur Wings (choix documenté). | `api/client/server-runtime.controller.ts:205-207` ; `pkg/contracts/src/files.ts:133-136,154-168` | `refusePath()` partagé (octet nul, segment `..`) avant `relay()`, en défense en profondeur |
| NC-47 | 12.6.1, 5.3.9 | URL de téléchargement rendues par Modrinth/CurseForge transmises au node sans filtre ; seul l'index `.mrpack` passe par la liste d'hôtes. | `api/marketplace/marketplace.service.ts:159-165` ; `engine.service.ts:252,347` contre `modpack-source.ts:28-48` | Appliquer `isTrustedDownload` avant tout `pullFile` |
| NC-48 | 7.4.1, 14.3.3 | Messages d'erreur du daemon relayés bruts (nom interne du node, `ECONNREFUSED 10.x:8080`). | `api/wings/wings-client.service.ts:44` ; `api/client/server-runtime.controller.ts:602-612` | Message générique au client, cause au `Logger` |
| NC-49 | 2.2.1 | Aucune limitation de débit applicative sur `/api/remote` ; nginx n'en pose pas non plus sur ce préfixe (contrairement à `/api/v1/application/`). | `apps/api/src/main.ts` ; `infra/prod/panel.conf:123-135` (pas de `limit_req`) contre `:106` | `limit_req` sur `/api/remote/`, ou `@fastify/rate-limit` |
| NC-50 | 14.4.4, 14.4.5, 14.3.3, 9.2.4 | En-têtes : HSTS sans `includeSubDomains` ni `preload` ; `server_tokens off` absent ; pas d'OCSP stapling ; réponses de l'API sans `X-Content-Type-Options` ni `Cache-Control: no-store` (atténué : l'API n'est jointe que par Next). | `infra/prod/panel.conf:96` ; grep `server_tokens`, `ssl_stapling` vides ; sondes 1.1 et 1.6 | Quatre directives nginx ; hook `onSend` dans `main.ts` |
| NC-51 | 3.4.1 | `Secure` et `__Host-` dépendent de `NODE_ENV` seul ; `deploy.sh` le pose, les unités systemd et `app.sh` non. | `api/auth/session-issuer.service.ts:137` ; `web/lib/session-cookie.ts:13-14` ; `infra/prod/deploy.sh:89,118` | Dériver aussi de `PANEL_ORIGIN.startsWith("https://")` |
| NC-52 | 8.1, 14.1 | Sauvegarde d'exploitation (`app.sh backup`) en clair : `pg_dump` + `env/` (donc `APP_SECRET_KEY`) dans un `.tar` chmod 600. | `infra/prod/app.sh:262-290` | Chiffrer l'archive ou exclure `env/` |
| NC-53 | 14.2.2 | Page vitrine `/design` (données factices) servie en production à tout utilisateur connecté. | `web/app/(panel)/design/page.tsx:1-8` | `notFound()` en production |
| NC-54 | 7.2.1 | Échecs de connexion et verrouillages hors du journal d'audit (seulement `login_attempts`, purgée à 30 j). | `api/auth/user.repository.ts:181-189` ; `api/scheduler/retention.service.ts:136-139` | Événements `account.login_failed`, `account.locked` |
| NC-55 | 7.4.1 | `GET nodes/:id/load?window=constructor` → 500 (accès prototype sur un `Record`). | `api/admin/node-load.service.ts:24-36,64-65` | `Object.hasOwn(WINDOWS, window)` |
| NC-56 | 5.2.6 | Destinations réglées par l'administration non filtrées : Instatus (`http:`, tout hôte, résultat public), sonde MySQL (hôte/port libres, erreur rendue), node `http`. Rôle admin seulement. | `pkg/contracts/src/instatus.ts:160-165` ; `api/admin/database-hosts.service.ts:92-113` ; `api/admin/infrastructure.service.ts:281-288` | `assertPublicDestination` sur l'URL Instatus ; documenter le reste |
| NC-57 | 7.1.1, 3.5 | Jeton de facturation consommé au rendu d'une navigation `GET` (un aperçu de lien le grille) et écrit dans le journal d'accès nginx (2 min, usage unique). | `web/app/(auth)/sso/[token]/page.tsx:26-33` ; `infra/prod/panel.conf:85,195` | `access_log off` pour `location ~ ^/sso/` |
| NC-58 | politique | Le bouton Google rapproche aussi les comptes du personnel par adresse vérifiée (parité avec la réinitialisation par courriel ; le 2FA s'applique ensuite). | `api/auth/sso.service.ts:257-355` (rôle jamais lu) contre `billing-sso.service.ts:128-132` | À trancher ; sinon refuser `admin`/`support` quand `provider === "google"` |
| NC-59 | 4.3.x | Un administrateur peut réécrire l'adresse d'un autre administrateur puis lui envoyer une réinitialisation (journalisé). | `api/admin/admin-users.service.ts:62-113`, `:125-167` | Refuser `emailChanged` sur un compte du personnel autre que soi |
| NC-60 | cohérence | L'indicateur « 2FA requis » rendu à l'interface ignore le rôle `reseller`, pourtant soumis au garde. | `api/auth/auth.controller.ts:1094-1095` contre `reseller.controller.ts:87` | `\|\| user.role === "reseller"` |
| NC-61 | PLAN §5.5 | Le jeton de node est lisible à la demande (YAML de configuration, `AdminWriteGuard`, journalisé) alors que le plan promet « affiché une fois ». | `api/admin/admin.controller.ts:1115-1132` ; sonde 5 (jeton en clair dans le YAML) | Amender §5.5, ou limiter la lecture aux minutes qui suivent une rotation |
| NC-62 | 6.1.1, 6.4.2, 2.4.5 | Architecture, à consigner en ADR plutôt qu'à corriger : PII en clair en base (e-mail, nom, IP des sessions) ; clé maître en fichier d'env, dérivée dans le processus, sans coffre ; pas de poivre secret en plus d'Argon2id. | `pkg/db/src/schema/identity.ts:24,31-32,202-203` ; `pkg/auth/src/secrets.ts:73-80` ; `pkg/auth/src/password.ts:15-30` ; `docs/runbooks/cle-maitre-secrets.md:60` | ADR « secrets et données personnelles au repos » (chiffrement du volume, absence de HSM) |
| NC-63 | 1.1.2 | Aucun modèle de menace documenté ; PLAN §5.5 en tient lieu pour la seule liaison Wings. | grep `modèle de menace|threat model` vide sur `PLAN.md` et `docs/` | Une page `docs/securite/modele-de-menace.md` |
| NC-64 | règle du dépôt | Tests manquants sur des règles de sécurité : `ip-allowlist` (aucun test), `StaffTwoFactorGuard` (aucun), `admin-write-routes.test.ts` (trois méthodes seulement), IDOR de `mustFind` avec un `serverId` étranger, vérification de `state` côté web, `ApiKeyRepository.resolve` (expiration, révocation, IP). | `ls pkg/auth/src` ; `api/admin/admin-write-routes.test.ts:17` ; grep vides | À écrire avec les corrections correspondantes |

### 2.4 Points à arbitrer avant correction

Ces cinq points changent le comportement visible ou une décision du plan ;
ils ne se corrigent pas sans décision :

1. **CSRF (NC-02)** : corriger seulement les textes, ou ajouter le contrôle
   d'origine dans l'API en défense en profondeur ?
2. **Sessions (NC-03)** : expiration d'inactivité (et laquelle), ou écart
   documenté au niveau 2 ?
3. **Lien de facturation (NC-05)** : le facturier vaut-il second facteur ?
4. **2FA du personnel par défaut (NC-10)** : `fallback: true`, activation
   automatique après le premier enrôlement, ou consigne d'installation ?
5. **Commandes console (NC-13)** : masquer les arguments, ou ne rien
   consigner ?

---

## 3. Sondes dynamiques

Instance jetable : API seule, `NODE_ENV=production`, `PANEL_ORIGIN=http://localhost:3298`,
base migrée par `pnpm db:migrate`, administrateur créé par `create-admin.mts`,
inscriptions ouvertes par SQL pour les sondes 2 et 3. Aucune interface Next
lancée : les contrôles d'origine des actions serveur sont ceux du framework
(`next@16.3.5`, `dist/server/app-render/action-handler.js`, message
« Missing `origin` header from a forwarded Server Actions request »).

| Sonde | Requête | Résultat | Conclusion |
|---|---|---|---|
| 1.1 | `GET /api/health` | `access-control-allow-origin: http://localhost:3298`, `content-type: application/json; charset=utf-8`, aucun `X-Content-Type-Options` | NC-50 ; 14.4.1 conforme |
| 1.2 | `POST /auth/login` en `application/x-www-form-urlencoded`, `text/plain`, `multipart/form-data` | 422 (Zod, donc corps parsé), 415, 415 | NC-02 : un `<form>` urlencoded est parsé |
| 1.3 | `POST /auth/login` mauvais mot de passe, compte existant contre inconnu, ×3 | 401 « Identifiants invalides. » dans les six cas ; délais identiques par rang (0,02 s / 0,26 s / 0,5 s / 1 s) | Pas d'énumération, délai progressif par IP |
| 1.4 | `POST /auth/password/forgot` existant contre inconnu | 204 / 204, 3 ms / 1 ms | Pas d'énumération par le corps ; écart de temps faible (doute D-3) |
| 1.5 | Connexion réussie | `Set-Cookie: __Host-gd_session=<32 car. base64url>; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax` | 3.4.x conformes ; NC-03 (7 j) |
| 1.6 | `GET /auth/me` authentifié | pas de `Cache-Control` | NC-50 |
| 1.7 | Préflight `OPTIONS` depuis `https://evil.example` ; `GET /auth/me` avec cookie et `Origin: https://evil.example` | ACAO reste `http://localhost:3298` ; GET → 200 | CORS fermé ; l'API ne lit pas `Origin` (NC-02) |
| 2.A | Inscription : `password1234`, mot de passe contenant l'adresse, phrase de 180 caractères avec `€` | 422 « figure dans des fuites » (443 397 occurrences HIBP), 422 « contenir votre nom », accepté | 2.1.1, 2.1.2, 2.1.4, 2.1.7 conformes |
| 2.B | Inscription en double | 409 « Un compte existe déjà » | NC-35 |
| 2.C | Compte non vérifié : `/auth/me`, `/client/servers` | 200, 200 | Utilisable avant vérification (choix, pas d'exigence L2) |
| 2.D | `/admin/users` en utilisateur simple ; cookie forgé ; `Bearer gd_live_forge` | 403, 403, 403 | Fermé par défaut |
| 2.E | Connexion avec un cookie pré-posé | Nouveau jeton émis | Pas de fixation (3.2.1) |
| 2.F | `POST /auth/logout` puis réemploi du cookie | 204 puis 403 | Révocation côté serveur (3.3.1) |
| 2.G | 12 échecs sur un compte puis le bon mot de passe | 401 ×10 avec délais 2 s, 4 s, 5 s…, puis 429 « Trop de tentatives », bon mot de passe → 429 | 2.2.1 ; NC-29 (verrou par compte) |
| 2.H | `GET /status`, `GET /openapi.json` sans session | 200 (état, composants, incidents), 57 Ko | Exposition publique assumée |
| 3.1-3.3 | `2fa/setup` → secret ; `2fa/enable` avec le code courant ; nouvelle connexion | 201 ; 200 + codes de secours ; `twoFactorRequired`, défi `v3:…`, **aucun cookie** | 2.8.x : le défi n'ouvre rien |
| 3.4 | `login/2fa` avec le code déjà employé à l'enrôlement | 401 | 2.8.5 anti-rejeu |
| 3.5 | `login/2fa` avec le code du pas suivant | 200 + cookie `__Host-` | — |
| 3.6 | Même défi + même code | 401 « Demande de connexion expirée » | Défi consommé |
| 3.7 | Nouveau défi + code déjà servi | 401 | 2.8.5 |
| 3.8 | Défi altéré | 401 | Scellé AES-GCM |
| 3.9 | `DELETE /auth/2fa`, `POST 2fa/recovery-codes` sans mot de passe | 422 « Mot de passe attendu » | 3.7.1 sur ces routes |
| 3.10 | `POST /client/account/api-keys` sans mot de passe | 201, secret rendu une fois | NC-20 |
| 4.1 | `PUT /api/health`, `TRACE /api/health` | 404, 404 | 14.5.1 |
| 4.2 | `POST /api/remote/servers/reset` sans jeton ; avec `abc.def` | 403 `{errors:[…]}`, sans `Location` | Format attendu par Wings, pas de redirection |
| 4.3 | `POST /auth/login` avec `X-Forwarded-For: 203.0.113.9, 198.51.100.7` depuis `127.0.0.1` | IP enregistrée `198.51.100.7` | Loopback = pair de confiance, comme prévu ; en production nginx ajoute l'adresse réelle en dernier |
| 5 | Node créé (`POST /admin/nodes`), YAML de configuration lu ; routes `remote` avec le jeton | inventaire 200 ; `servers/pas-un-uuid` → **500** ; `servers/<uuid inconnu>` → 404 ; `install`/`backups` sur `pas-un-uuid` → 500 ; `activity` lot étranger → 204 ; `sftp/auth` → 403 `InvalidSftpCredentials` ; mauvais secret → 403 | NC-24 ; NC-61 ; règle « serveurs du node » tenue |

---

## 4. Tableau des exigences (niveaux 1 et 2)

Verdicts **au moment de l'audit** (voir §0 pour les corrections) : **C** conforme,
**NC** non conforme, **P** partiel, **SO** sans objet.
Une exigence de niveau 3 n'est pas listée. Les renvois `NC-nn` pointent §2.

### V1 Architecture, conception et modélisation des menaces

| Exigence | Verdict | Preuve |
|---|---|---|
| 1.1.1 Cycle de développement sécurisé | P | CI : lint, types, tests, `pnpm audit --audit-level low` (`ci.yml:117-118`), Trivy (`:134`), Semgrep (`:148`), ZAP (`:255`) ; pas de revue de sécurité formalisée avant cet audit |
| 1.1.2 Modèle de menace | NC | NC-63 |
| 1.1.3 Exigences de sécurité dans les récits | P | `PLAN.md` §5 ; pas de trace par fonctionnalité |
| 1.1.4 Frontières de confiance documentées | C | `PLAN.md` §5.5 (panel ↔ Wings), §7.1 (origine unique), `infra/prod/panel.conf:99-174` |
| 1.1.5 Architecture de haut niveau | C | `PLAN.md` §3, §11 ; `docs/adr/*` |
| 1.1.6 Contrôles de sécurité centralisés | P | Gardes uniques (`SessionGuard`, `AdminWriteGuard`, `ServerAccessService`) ; validation non centralisée (NC-23) |
| 1.1.7 Liste de vérification de codage sûr | C | `docs/contribuer.md` §« API » (autorisation, Zod, hacher/chiffrer, `battre()`) |
| 1.2.1 Comptes de faible privilège par composant | C | `infra/prod/gamedashboard-api.service:39-46` (`NoNewPrivileges`, `ProtectSystem=strict`) ; rôle PostgreSQL dédié (`infra/prod/installer.sh`) ; hôte MySQL séparé (`infra/docker/compose.dev.yml`) |
| 1.2.2 Communications inter-composants authentifiées | C | Wings ↔ panel : jeton par node (`api/remote/node-token.guard.ts`) ; panel → Wings : `Bearer` (`api/wings/wings-client.service.ts`) ; Next → API : cookie relayé, API sur `127.0.0.1` (`deploy.sh:95`) |
| 1.2.3 Mécanisme d'authentification unique | C | `api/auth/session-issuer.service.ts` seul émetteur, vérifié par `session-issuance-coverage.test.ts:36-44` |
| 1.2.4 Chemins d'authentification de force égale | P | Mot de passe + 2FA, SSO/Google + 2FA ; lien de facturation sans 2FA (NC-05) |
| 1.4.1 Points d'application de confiance | C | Décisions côté API ; le rendu web ne fait que masquer (`web/app/(admin)/admin/layout.tsx:35`) |
| 1.4.4 Mécanisme de contrôle d'accès unique | C | `api/client/server-access.service.ts:74-151` ; `permissions-coverage.test.ts:52-61` |
| 1.4.5 Contrôle par attributs et non par rôle seul | C | Permissions par serveur (`pkg/contracts/src/permissions.ts`), portées de clés |
| 1.5.1 Exigences d'entrée/sortie définies | C | Schémas Zod dans `pkg/contracts` ; catalogue d'API (`api-catalogue.ts`) |
| 1.5.2 Pas de sérialisation non protégée vers le client | C | JSON seul ; jetons scellés (`login-challenge.ts:74`) |
| 1.5.3 Validation côté serveur | C | `api/client/client.controller.ts:214-217`, `auth.controller.ts:363` |
| 1.5.4 Encodage en sortie près de l'interpréteur | C | React ; CSV protégé (`api/activity/audit-export.ts:39,60`) ; `escapeId` MySQL (`pkg/mysql/src/index.ts:121-129`) |
| 1.6.1 Politique de gestion des clés | C | `docs/runbooks/cle-maitre-secrets.md`, `rotation-jeton-node.md` |
| 1.6.2 Protection des clés par les consommateurs | P | `APP_SECRET_KEY` en env, dérivée en mémoire (`pkg/auth/src/secrets.ts:70-80`) ; NC-62 |
| 1.6.3 Clés remplaçables, rechiffrement | C | `apps/api/scripts/rekey-secrets.mts` (`TARGETS:178-191` couvre toutes les colonnes chiffrées) ; `apps/api/src/common/rekey.test.ts` |
| 1.6.4 Secrets côté client considérés non sûrs | C | Aucun secret dans le navigateur ; `apps/web/.env.example` (« aucune variable `NEXT_PUBLIC_` ») |
| 1.7.1 Format de journalisation commun | C | `api/activity/activity.service.ts:71-131` ; `activity-coverage.test.ts` |
| 1.7.2 Journaux transmis en sécurité | C | journald (`gamedashboard-api.service:48-50`) |
| 1.8.1 Données sensibles identifiées | C | `kind: "secret"` (`pkg/contracts/src/platform-settings.ts:12,51-57`), `is_secret` en base |
| 1.8.2 Niveaux de protection par classification | P | Secrets chiffrés ou hachés (tableau §5) ; PII en clair (NC-62) |
| 1.9.1 Communications chiffrées entre composants | P | TLS navigateur ↔ nginx ; nginx → Next/API en clair sur `127.0.0.1` ; Wings en `http` possible pour une IP (`api/admin/infrastructure.service.ts:281`), réseau d'administration attendu (PLAN §5.5) ; `DATABASE_SSL`/`MYSQL_TLS` optionnels |
| 1.9.2 Authenticité des deux côtés | P | TLS vérifié par défaut (aucun `rejectUnauthorized: false`) ; Wings n'offre pas de mTLS (PLAN §5.5) |
| 1.10.1 Contrôle de version avec suivi | C | GitHub, PR, CI |
| 1.11.1 Composants définis par fonction | C | `PLAN.md` §3, §11 ; `docs/contribuer.md` « Où mettre quoi » |
| 1.11.2 Pas d'état non synchronisé dans les flux sensibles | P | Allocations verrouillées (`allocations.service.ts:101`) ; quotas non (NC-08) |
| 1.12.2 Fichiers envoyés hors racine web | C | `tmpdir()/gamedashboard-uploads` (`file-upload.service.ts:78`) ; jamais servis par le panel |
| 1.14.1 Séparation des composants | C | Unités systemd séparées (`infra/prod/gamedashboard-*.service`), `HOST=127.0.0.1` |
| 1.14.2 Déploiement par artefacts vérifiés | P | Archive + `sha256` vérifiés (`infra/prod/app.sh:166-176`) ; attestation produite (`release.yml:112-125`) mais non vérifiée par `app.sh` |
| 1.14.3 Pipeline alerte sur composants obsolètes | C | `pnpm outdated -r` (`docs/contribuer.md`), Renovate (`.github/renovate.json`) |
| 1.14.4 Pipeline avec étapes de sécurité automatiques | C | `ci.yml:93-166` (audit, Trivy, Semgrep), `:255` (ZAP) |
| 1.14.5 Déploiements confinés | C | `gamedashboard-api.service:39-46` |
| 1.14.6 Pas de technologie cliente obsolète | C | Next 16, React ; aucun plugin natif |

### V2 Authentification

| Exigence | Verdict | Preuve |
|---|---|---|
| 2.1.1 ≥ 12 caractères | C | `pkg/auth/src/policy.ts:12,37` ; `policy.test.ts:23` ; sonde 2.A |
| 2.1.2 ≥ 64 acceptés | C | `policy.ts:14` (256) ; sonde 2.A (180 caractères acceptés) |
| 2.1.3 Pas de troncature | C | Argon2id `password.ts:24-26` ; `password.test.ts:27` |
| 2.1.4 Unicode accepté | C | Points de code `policy.ts:37` ; sonde 2.A (`€`, accents) |
| 2.1.5 Changement possible | C | `auth.controller.ts:604` |
| 2.1.6 Changement exige l'ancien | C | `auth.controller.ts:639` |
| 2.1.7 Mots de passe compromis refusés | C | HIBP k-anonymat `policy.ts:86-94` ; appels `auth.controller.ts:654,810,952` ; sonde 2.A ; repli ouvert si HIBP injoignable (`policy.ts:130`, journalisé) — doute D-4 |
| 2.1.8 Indicateur de force | NC | NC-34 |
| 2.1.9 Pas de règles de composition | C | `policy.ts:7-10` ; `policy.test.ts:38` |
| 2.1.10 Pas de rotation périodique | C | grep `passwordExpires|mustChange` vide |
| 2.1.11 Collage autorisé | C | grep `onPaste` vide |
| 2.1.12 Masquage/affichage | C | `pkg/ui/src/components/input.tsx:45-69` |
| 2.2.1 Anti-automatisation | P | Verrou compte + IP en base (`throttle.ts:12-17,41-48`, `user.repository.ts:182-241`) ; délai progressif ; nginx `limit_req` (`panel.conf:19-21,181`) ; captcha optionnel ; sonde 2.G ; NC-29, NC-35 |
| 2.2.2 Pas de SMS | C | grep `sms|twilio` vide |
| 2.2.3 Notification des changements d'authentifiant | NC | NC-04 |
| 2.2.4 Résistance au hameçonnage | SO | Niveau 3 ; passkeys disponibles (`relying-party.ts:32-40`) |
| 2.2.5 mTLS entre CSP et vérifieur | SO | Pas de fournisseur externe d'authentifiant |
| 2.2.6 / 2.2.7 | SO | idem |
| 2.3.1 Secret initial aléatoire, unique, expirant | P | 192 bits aléatoires (`create-admin.mts:40`) ; pas d'expiration (NC-33) ; API applicative sans mot de passe (`application.service.ts:181`) |
| 2.3.2 Enrôlement de plusieurs authentificateurs | C | `passkey.service.ts:61-76` (`excludeCredentials`) |
| 2.3.3 Renouvellement des authentificateurs | SO | Aucun authentificateur à durée limitée (clés d'API : 2.10) |
| 2.4.1 Hachage salé, KDF approuvé | C | Argon2id (`password.ts:15-30`, ADR 0002) |
| 2.4.2 Sel ≥ 32 bits unique | C | Sel Argon2 par condensat (bibliothèque `argon2`) |
| 2.4.3 PBKDF2 ≥ 100 000 itérations | SO | PBKDF2 non employé |
| 2.4.4 bcrypt facteur ≥ 10 | SO | bcrypt seulement lu en héritage puis réécrit (`password.ts:39`, `auth.controller.ts:316-318`) |
| 2.4.5 Itération supplémentaire avec sel secret | NC | Aucun poivre (NC-62) |
| 2.5.1 Pas de secret initial en clair | C | Courriels avec lien seul (`account-mail.service.ts:107-123`) |
| 2.5.2 Pas de questions secrètes | C | grep vide |
| 2.5.3 Pas d'envoi du mot de passe | C | `pkg/contracts/src/user.ts:33-37` ; `admin-users.service.ts:154` |
| 2.5.4 Pas de compte partagé | C | Comptes nominatifs (`create-admin.mts:24-31`) |
| 2.5.5 Notification | NC | NC-04 |
| 2.5.6 Lien limité, unique, aléatoire | C | 256 bits (`tokens.ts:13-16`), SHA-256 (`auth-token.repository.ts:117`), 1 h (`:40`), 3/h (`:58`), consommation atomique (`:163-177`) ; NC-31 |
| 2.5.7 Perte du second facteur | C | Codes de secours (`auth.controller.ts:1160,1636`), consommation (`two-factor.repository.ts:242`) |
| 2.6.1 Codes de secours à usage unique | C | `two-factor.repository.ts:236-247` |
| 2.6.2 Entropie suffisante | C | 50 bits + Argon2id (`recovery.ts:25-39`) |
| 2.6.3 Codes hachés | C | `two-factor.repository.ts:262` |
| 2.7.1 Hors bande : pas de secret en clair | C | Lien de facturation : haché, 2 min, usage unique (`auth-token.repository.ts:42,117,164-177`) |
| 2.7.2 Expiration ≤ 10 min | C | 2 min (`:42`) |
| 2.7.3 Usage unique | C | `update … where consumed_at is null … returning` (`:164-177`) ; NC-57 (grillé par un aperçu) |
| 2.7.4 Canal sécurisé | C | Lien rendu à l'API applicative (HTTPS) ; NC-57 (journal nginx) |
| 2.7.5 / 2.7.6 | C | Jeton aléatoire 256 bits, haché (`tokens.ts:13-29`) |
| 2.8.1 Durée / fenêtre TOTP | C | 30 s, ±1 pas (`totp.ts:15,27`) |
| 2.8.2 Secret protégé | P | AES-256-GCM (`secrets.ts:17`) sans contexte (NC-18) |
| 2.8.3 Algorithme approuvé | C | HMAC-SHA1 RFC 6238, comparaison constante (`totp.ts:36,212`) |
| 2.8.4 Génération aléatoire | C | 20 octets (`totp.ts:111`) |
| 2.8.5 Anti-rejeu | C | `lastUsedStep` (`two-factor.repository.ts:185-191`) ; sondes 3.4, 3.7 |
| 2.8.6 Révocation / ré-authentification | P | Désactivation sous mot de passe (sonde 3.9) ; enrôlement sans (NC-20) |
| 2.9.1 Défi aléatoire à usage unique | P | Défi scellé et consommé (`auth.controller.ts:1584,1608,1723,1752`) ; en mémoire d'un processus (NC-30) |
| 2.9.2 Origine et RP ID vérifiés | C | `relying-party.ts:32-40` ; `passkey.service.ts:103-104,179-180` ; tests |
| 2.9.3 Compteur de signature | C | `passkey.service.ts:195` ; doute D-6 (compteur à zéro) |
| 2.10.1 Secrets de service non fixes, renouvelés | P | Jeton par node, rotation (`node-configuration.service.ts:127-135`) ; clés applicatives ≤ 365 j ; personnelles sans fin (NC-36) |
| 2.10.2 Pas de secret codé en dur | C | Clé maître exigée (`main.ts:17`) ; grep vide |
| 2.10.3 Mots de passe de service chiffrés | C | `platform-settings.service.ts:383`, `database-hosts.service.ts:142` |
| 2.10.4 Stockage sûr des secrets | P | AES-256-GCM en base ; clé en env sans longueur minimale (NC-19, NC-62) |

### V3 Gestion de session

| Exigence | Verdict | Preuve |
|---|---|---|
| 3.1.1 Jeton de session jamais dans l'URL | C | Cookie seul (`session.guard.ts:57`) |
| 3.2.1 Nouveau jeton à la connexion | C | `session.repository.ts:127` ; sonde 2.E ; défi 2FA sans droit (sonde 3.3) ; NC-32 |
| 3.2.2 ≥ 64 bits d'entropie | C | 256 bits (`tokens.ts:13-16`) ; sonde 1.5 |
| 3.2.3 Stockage haché | C | SHA-256 (`session.repository.ts:132`) |
| 3.2.4 Générateur approuvé | C | `crypto.randomBytes` (`tokens.ts:16`) |
| 3.3.1 Déconnexion invalide côté serveur | C | `auth.controller.ts:583-587` ; sonde 2.F |
| 3.3.2 Ré-authentification périodique (12 h ou 30 min d'inactivité) | NC | NC-03 |
| 3.3.3 Déconnexion de toutes les sessions | C | `auth.controller.ts:1874-1880`, `:672`, `:828` |
| 3.3.4 Liste des sessions et révocation unitaire | C | `session.repository.ts:245-276,310` ; sonde 4.3 (IP, agent, méthode, dernière vue) |
| 3.4.1 `Secure` | C | Sonde 1.5 ; NC-51 (conditionné à `NODE_ENV`) |
| 3.4.2 `HttpOnly` | C | Sonde 1.5 ; `session-issuer.service.ts:134` |
| 3.4.3 `SameSite` | C | `Lax` (sonde 1.5) |
| 3.4.4 Préfixe `__Host-` | P | Session oui (`session-cookie.ts:13-14`) ; `gd_return` non (NC-25) |
| 3.4.5 `Path` | C | `path: "/"` (`session-issuer.service.ts:131`) |
| 3.5.1 Révocation des jetons OAuth/API | P | Sessions et clés révocables ; jetons WebSocket non révoqués à la déconnexion (NC-43) |
| 3.5.2 Jetons sans état plutôt que secrets statiques | P | Sessions opaques hachées ; jeton de node statique imposé par Wings (PLAN §5.5) ; clés personnelles sans fin (NC-36) |
| 3.5.3 Jetons signés, algorithme contrôlé | C | JWT Wings HS256 exigés par le daemon, `exp` courts, `jti` (`wings-token.service.ts:43-64,187`) ; le panel ne vérifie jamais de JWT entrant |
| 3.7.1 Ré-authentification avant transaction sensible | P | Mot de passe, désactivation 2FA, retrait de clé, codes : oui ; enrôlement, clés d'API/SSH : non (NC-20) |

### V4 Contrôle d'accès

| Exigence | Verdict | Preuve |
|---|---|---|
| 4.1.1 Contrôle sur une couche de confiance | C | `server-access.service.ts:74-151` appelé avant tout effet sur les 75 routes serveur (annexe A de l'agent, vérifiée) ; rôles relus par requête (`session.repository.ts:162`) ; NC-14 (porte WebSocket) |
| 4.1.2 Attributs non manipulables par l'utilisateur | C | Identité posée par `SessionGuard` seul (`session.guard.ts:62-67`) ; `resolveOwner` refuse `ownerId` d'autrui (`server-provisioning.service.ts:375-377`) ; rôle jamais dans un schéma client (`pkg/contracts/src/user.ts:37-42`) |
| 4.1.3 Moindre privilège | P | Refus 404/403 (`server-access.service.ts:144-149`) ; sous-utilisateur borné par `grantable` (`subusers.service.ts:305-343`) ; clés d'API bornées, refusées en admin/revendeur ; NC-01, NC-06, NC-07, NC-15 |
| 4.1.5 Échec sûr | C | Exceptions, jamais de défaut permissif ; `granted()` rend `[]` (`server-access.service.ts:382`) ; NC-41 |
| 4.2.1 Pas d'IDOR | C | Toute sous-ressource liée au serveur ou au compte : `backups.service.ts:237`, `schedules.service.ts:209`, `databases.service.ts:258`, `allocations.service.ts:173,195`, `subusers.service.ts:358`, `server-invites.service.ts:240`, `server-webhooks.service.ts:207`, `file-upload.service.ts:263`, `api-keys.service.ts:144`, `ssh-key.repository.ts:113`, `passkey.repository.ts:133`, `session.repository.ts:310` ; périmètre revendeur en SQL (`reseller.service.ts:155,241,267`) ; NC-01 |
| 4.2.2 Anti-CSRF | P | `SameSite=Lax`, contrôle d'origine des actions serveur Next, API cliente non exposée par nginx ; aucun contrôle dans l'API (NC-02) |
| 4.3.1 Interfaces d'administration sous MFA | P | `StaffTwoFactorGuard` sur les sept contrôleurs de personnel (`admin.controller.ts:111`, `reseller.controller.ts:87`…) ; inactif par défaut (NC-10) |
| 4.3.2 Pas de listage de répertoires, métadonnées hors accès | C | Next (pas de listage) ; `.git` hors de la racine servie (`infra/prod/app.sh` déploie l'archive compilée) |
| 4.3.3 Autorisation renforcée pour les fonctions sensibles | P | Écriture admin réservée au rôle `admin` (`admin-write.guard.ts:24`) ; retrait de passkey sous mot de passe ; prise en main lecture seule sauf revendeur (NC-06) et `GET` à effet (NC-16) |

### V5 Validation, assainissement, encodage

| Exigence | Verdict | Preuve |
|---|---|---|
| 5.1.1 Pollution de paramètres | C | Champs recopiés un à un (`server-features.controller.ts:1117-1125`) |
| 5.1.2 Assignation de masse | C | Clé de réglage inconnue refusée (`platform-settings.service.ts:374-378`) ; rôle par route dédiée (`admin-actions.service.ts:30`) |
| 5.1.3 Validation positive | P | NC-23 |
| 5.1.4 Données structurées typées et bornées | P | NC-23 |
| 5.1.5 Redirections vers des cibles autorisées | C | Aucune cible fournie par l'utilisateur (`ceremony.ts:33,69,121-133`) ; `redirectUri` fixé (`web/server/api/sso.ts:52-54`) |
| 5.2.1 HTML assaini | C | Aucun `dangerouslySetInnerHTML` ; annonces en texte |
| 5.2.2 Données non structurées bornées | C | Nom de serveur 120 (`server-settings.service.ts:172-175`) |
| 5.2.3 Injection d'en-têtes de mail | C | Texte brut (`mailer.service.ts:64-71`) ; nodemailer retire `\r\n` |
| 5.2.4 Pas d'`eval` | C | grep `eval(|new Function(|node:vm` vide |
| 5.2.5 Injection de gabarit | C | idem |
| 5.2.6 SSRF | P | Côté client : `https` + résolution DNS + plages privées refusées + `redirect: "manual"` (`apps/api/src/common/public-url.ts:19-39`, `server-webhooks.service.ts:210-226`, `webhook-dispatcher.service.ts:139-143`, `modpack-source.ts:29-44`, `egg-import.service.ts:587-591`) ; destinations admin libres (NC-56) ; URL fournisseurs (NC-47) |
| 5.2.7 SVG | C | Logos par URL `https`, jamais inlinés (`web/app/brand/logo/route.ts:31`) |
| 5.2.8 Markdown, CSS, expressions | C | Accent hexadécimal normalisé (`pkg/contracts/src/branding.ts:102-104`), URL filtrées (`:123-131`) |
| 5.3.1 Encodage en sortie contextuel | C | React ; CSV (`audit-export.ts:39,60`) |
| 5.3.2 Unicode | C | UTF-8 (`panel.conf:77`, sonde 1.1) |
| 5.3.3 Protection XSS | C | CSP à nonce + `strict-dynamic` (`content-security-policy.ts:34-45`) ; `e2e/securite.spec.ts:37-85` |
| 5.3.4 Requêtes paramétrées | C | Drizzle ; `sql.raw` sur constantes seules (`retention.service.ts:73-165,362-365`) ; MySQL `escapeId` + regex (`pkg/mysql/src/index.ts:45,121-129,204-205`) |
| 5.3.5 Injection base | C | idem |
| 5.3.6 Injection JSON | C | `JSON.parse` sur corps Fastify ; `remote-activity.service.ts:110-126` |
| 5.3.7 LDAP | SO | Aucun LDAP |
| 5.3.8 Injection de commande | C | Aucun `child_process` en production (seul `pkg/db/scripts/check-migrations.mjs:17`) |
| 5.3.9 Inclusion de fichiers | P | Chemins délégués à Wings (NC-46) ; montages bornés (`mounts.service.ts:225-254`) |
| 5.3.10 XPath/XML | SO | Aucun analyseur XML |
| 5.4.1 – 5.4.3 Mémoire, chaînes, entiers | SO | Langage géré ; entiers bornés par Zod (`provisioning.ts:292-308`) |
| 5.5.1 Désérialisation | C | JSON seul ; egg importé borné à 512 Ko (`egg-import.service.ts:42,317-326`) |
| 5.5.2 XXE | SO | Pas de XML |
| 5.5.3 Désérialisation JSON sûre | C | `pterodactyl-egg.ts:140-160` champ par champ |
| 5.5.4 Pas d'`eval` sur JSON | C | `pkg/contracts/src/zod-runtime.ts:1-25` |

### V6 Cryptographie stockée

| Exigence | Verdict | Preuve |
|---|---|---|
| 6.1.1 Données personnelles chiffrées au repos | NC | NC-62 |
| 6.1.2 / 6.1.3 Santé, finance | SO | Aucune donnée de santé ; facturation externe |
| 6.2.1 Échec sûr des modules cryptographiques | C | `node-token.guard.ts:87-91` ; `platform-settings.service.ts:322-327` |
| 6.2.2 Algorithmes approuvés | C | AES-256-GCM, SHA-256, Argon2id, scrypt |
| 6.2.3 Modes et paramètres | P | IV 96 bits aléatoire, tag 128 bits (`secrets.ts:21,114,153-159`) ; AAD inutilisée (NC-18) |
| 6.2.4 Algorithmes remplaçables | C | Format versionné `v3:` (`secrets.ts:19,122`), ancien format relu (`:143-144`) |
| 6.2.5 Pas d'algorithme faible | C | SHA-1 limité à HIBP et TOTP (imposés) |
| 6.2.6 Nonces uniques | C | IV neuf par appel (`secrets.test.ts:23-30`) |
| 6.3.1 Aléa cryptographique | C | `randomBytes` partout (`tokens.ts:16,89`, `webhook-registry.service.ts:212`) |
| 6.3.2 GUID v4 | C | `defaultRandom()` (`pkg/db/src/columns.ts:12`) |
| 6.4.1 Gestion des secrets (coffre) | P | Clé en env, longueur non imposée (NC-19, NC-62) |
| 6.4.2 Clés non exposées à l'application | NC | Dérivée dans le processus (`secrets.ts:79-80`) ; NC-62 |

### V7 Gestion des erreurs et journalisation

| Exigence | Verdict | Preuve |
|---|---|---|
| 7.1.1 Pas d'identifiants ni de jetons dans les journaux | NC | NC-13 ; conforme ailleurs (`application-keys.controller.ts:88-89`, `admin.controller.ts:1154-1156`, `sso.service.ts:211-214`) |
| 7.1.2 Pas de données sensibles superflues | P | NC-13, NC-42 |
| 7.1.3 Événements de sécurité tracés | P | Connexion, mot de passe, 2FA, prise en main, rotation de jeton tracés (`auth.controller.ts:409,675,761,831,1159,1226,1640,1690`, `admin.controller.ts:1148-1157`) ; NC-11, NC-12, NC-54 |
| 7.1.4 Contexte suffisant | C | Acteur, IP, agent, cible, propriétés (`activity.service.ts:121-131`) |
| 7.2.1 Décisions d'authentification tracées | P | NC-54 |
| 7.2.2 Décisions d'accès tracées | NC | NC-12 |
| 7.3.1 Encodage des journaux | C | JSONB, rendu React, CSV protégé |
| 7.3.3 Journal protégé | C | Trigger ajout seul (`pkg/db/migrations/0025_activity_logs_append_only.sql:8-22`) ; purge seule voie (`retention.service.ts:369-383`) |
| 7.3.4 Horodatage fiable | P | Serveur (`activity.service.ts:130`) ; daemon libre (NC-45) |
| 7.4.1 Messages d'erreur génériques | P | Problem Details vers Wings (`wings-error.filter.ts:177-190`) ; NC-48, NC-55, NC-24 |
| 7.4.2 Gestion des exceptions | C | `apps/api/src/common/background-tick.ts` ; `activity.service.ts:71-81` |
| 7.4.3 Gestionnaire de dernier recours | P | Aucun filtre global (`useGlobalFilters` absent) ; Nest rend un 500 générique (sonde 5, sans trace) |

### V8 Protection des données

| Exigence | Verdict | Preuve |
|---|---|---|
| 8.1.1 Pas de cache intermédiaire de données sensibles | C | Aucun `proxy_cache` (`panel.conf`) |
| 8.1.2 Cache serveur minimal | P | Clé dérivée mémorisée (`secrets.ts:70`) ; réponses d'idempotence sans purge (NC-39) |
| 8.1.3 Minimisation des paramètres | C | Relecture par identifiant, corps limités aux champs utiles |
| 8.1.4 Détection des accès anormaux | P | Alertes après échecs et nouvel appareil (`security-alert.service.ts`) ; refus non tracés (NC-12) |
| 8.2.1 `Cache-Control: no-store` | P | Relais Next en `cache: "no-store"` (`web/server/api/client.ts:136`) ; API sans en-tête (NC-50) |
| 8.2.2 Pas de secret en stockage navigateur | C | `localStorage` : thème, annonces lues, reprise d'envoi (`web/lib/file-upload.ts:115`) |
| 8.2.3 Données effacées à la déconnexion | C | Cookie `HttpOnly` effacé (`web/server/api/session.ts:42-45`) |
| 8.3.1 Pas de donnée sensible dans l'URL | P | Jetons de réinitialisation et de facturation en chemin/`?token=`, usage unique, `Referrer-Policy` posée (NC-57) |
| 8.3.2 Export ou effacement des données | C | Export d'audit (`admin.controller.ts:490-519`) ; suppression de compte (`:688-693`) |
| 8.3.3 Consentement / usage des données | C | Aucune collecte hors besoin ; télémétrie Next désactivée en CI (`ci.yml:23`) |
| 8.3.4 Données sensibles identifiées et protégées | P | Classification `kind: "secret"` ; NC-13, NC-40 |
| 8.3.5 Accès aux données sensibles journalisé | C | Mot de passe de base (`server-features.controller.ts:274`), configuration de node (`admin.controller.ts:1120-1130`) |
| 8.3.6 Effacement mémoire | SO | Langage géré |
| 8.3.7 Chiffrement des données sensibles | P | Secrets oui (tableau §5) ; PII non (NC-62) ; AAD (NC-18) |
| 8.3.8 Rétention | P | `retention.service.ts:129-165` ; `idempotency_records` (NC-39) |

### V9 Communications

| Exigence | Verdict | Preuve |
|---|---|---|
| 9.1.1 TLS pour tout le trafic client | C | Redirection 301 vers HTTPS (`panel.conf:49-56`, `infra/local/README.md`) ; HSTS |
| 9.1.2 Suites de chiffrement modernes | C | `tls-intermediate.conf` (Mozilla intermédiaire : AES-GCM, ChaCha20, ECDHE) |
| 9.1.3 TLS 1.2/1.3 seulement | C | `ssl_protocols TLSv1.2 TLSv1.3` |
| 9.2.1 Certificats de confiance côté serveur | P | Let's Encrypt (`panel.conf:71-72`, `certificates.sh`) ; Wings en `http` autorisé pour une IP (`infrastructure.service.ts:281`) |
| 9.2.2 Chiffrement de toutes les liaisons | P | SMTP `requireTLS` en production (`mailer.service.ts:129-133`) ; base et MySQL en option (`DATABASE_SSL`, `MYSQL_TLS`) ; Wings selon `scheme` |
| 9.2.3 Liaisons sortantes authentifiées | C | TLS vérifié par défaut, aucun `rejectUnauthorized: false` ; `pkg/mysql/src/index.ts:238` |
| 9.2.4 Révocation (OCSP stapling) | NC | NC-50 |

### V10 Code malveillant

| Exigence | Verdict | Preuve |
|---|---|---|
| 10.2.1 Pas de collecte ni d'appel maison non déclaré | C | Télémétrie Next désactivée (`ci.yml:23`, `release.yml:38`) ; Semgrep en CI |
| 10.2.2 Pas de permissions superflues | C | `Permissions-Policy` (`next.config.ts:19-21`) |
| 10.3.1 Mises à jour signées et vérifiées | P | `sha256` vérifié (`app.sh:166-176`) ; attestation de provenance produite (`release.yml:112-125`) mais non vérifiée à l'installation |
| 10.3.2 Intégrité des ressources tierces | P | Monaco sans SRI (NC-22) ; Turnstile (non signable, `captcha-field.tsx:74`) |
| 10.3.3 Pas de reprise de sous-domaine, `Host` contrôlé | C | `X-Forwarded-Host` réécrit (`panel.conf:203-206`) ; domaine revendeur vérifié par TXT + CNAME avant service (`branding.service.ts:442-467,480`) |

### V11 Logique métier

| Exigence | Verdict | Preuve |
|---|---|---|
| 11.1.1 Séquence des étapes | C | Création en transaction (`server-provisioning.service.ts:167-220`) |
| 11.1.2 Rythme humain | P | Connexions (délais, 429) ; nginx `limit_req` ; création interdite aux clés (`client.controller.ts:191-195`) ; réinstallation sans limite |
| 11.1.3 Limites par utilisateur | C | `SERVERS_PER_USER` (`server-provisioning.service.ts:126`), sauvegardes, invitations 25 (`server-invites.service.ts:50`) |
| 11.1.4 Anti-automatisation | P | Jetons mail 3/h (`auth-token.repository.ts:58`) ; SFTP par IP ; NC-07, NC-17 |
| 11.1.5 Limites métier | C | `provisioning.ts:292-308` ; `server-resize.service.ts:207-216` |
| 11.1.6 TOCTOU / verrous | P | Allocations et bases verrouillées ; quotas non (NC-08) |
| 11.1.7 Surveillance des abus | P | Alertes de connexion ; refus non tracés (NC-12) |
| 11.1.8 Alertes automatisées | P | idem |

### V12 Fichiers et ressources

| Exigence | Verdict | Preuve |
|---|---|---|
| 12.1.1 Taille maximale d'envoi | C | 5 Gio par fichier, morceaux 8 Mio, `bodyLimit` (`file-upload.service.ts:32-50`, `main.ts:56`) ; nginx 16M pour le reste |
| 12.1.2 Archives contrôlées | SO | Décompression par Wings (`server-runtime.controller.ts:532-535`) |
| 12.1.3 Quota par utilisateur | NC | NC-17 |
| 12.2.1 Type de fichier vérifié | SO | Fichiers de jeu arbitraires par conception ; jamais exécutés ni servis par le panel |
| 12.3.1 Métadonnées de nom | P | Envoi : `nomDeFichier` (`file-upload.service.ts:318-333`) ; autres routes relayées (NC-46) |
| 12.3.2 Traversée de répertoire | P | NC-46 (confinement par Wings, choix PLAN §4.3) |
| 12.3.3 Téléchargement réfléchi | SO | En-têtes posés par Wings |
| 12.3.4 RFI/SSRF sur les fichiers | P | `pull` jamais exposé au client ; NC-47 |
| 12.3.5 LFI | C | Aucune lecture locale à partir d'un chemin utilisateur (`readFile` seulement sur `meta.json` de l'envoi, identifiant aléatoire vérifié `:105,242`) |
| 12.3.6 Pas d'inclusion depuis une source non fiable | C | Eggs importés depuis des sources déclarées par l'administration (`egg-import.service.ts:587-591`) |
| 12.4.1 Fichiers hors racine web, droits limités | C | `tmpdir()/gamedashboard-uploads` (`file-upload.service.ts:78`) |
| 12.4.2 Analyse antivirale | NC | Aucun scanner ; fichiers de jeu de l'utilisateur, à consigner comme risque accepté |
| 12.5.1 / 12.5.2 Service et exécution de fichiers envoyés | SO | Le panel ne sert ni n'exécute rien ; Wings livre en `octet-stream` |
| 12.6.1 SSRF : liste d'autorisation | P | `TRUSTED_DOWNLOAD_HOSTS` (`modpack-source.ts:28-36`) ; NC-47, NC-56 |

### V13 API et services web

| Exigence | Verdict | Preuve |
|---|---|---|
| 13.1.1 Même analyseur partout | C | Fastify seul ; `URLSearchParams` vers Wings |
| 13.1.3 Pas de secret dans l'URL | P | `?token=` de téléchargement Wings (60 s, imposé par le daemon) ; NC-57 |
| 13.1.4 Autorisation par ressource | C | `access.require` avant chaque relais ; prédicats `nodeId` sur chaque route `remote` (tableau §6) |
| 13.1.5 Types de contenu inattendus refusés | P | `multipart` → 415 ; `x-www-form-urlencoded` accepté (NC-02) |
| 13.2.1 Méthodes REST attendues | C | Routes Nest explicites ; sonde 4.1 |
| 13.2.2 Schéma JSON | P | NC-23 |
| 13.2.3 CSRF pour les API à cookie | P | NC-02 |
| 13.2.5 `Content-Type` vérifié | P | JSON, `text/plain`, urlencoded acceptés (sonde 1.2) |
| 13.2.6 Charges signées entre services | C | Rappels signés HMAC (`webhook-dispatcher.service.ts:128-143`) |
| 13.3.1 / 13.3.2 SOAP | SO | Aucun SOAP |
| 13.4.1 / 13.4.2 GraphQL | SO | Aucun GraphQL |

### V14 Configuration

| Exigence | Verdict | Preuve |
|---|---|---|
| 14.1.1 Build reproductible | C | `pnpm install --frozen-lockfile` (`ci.yml:114-115`) |
| 14.1.2 Compilateur durci | SO | Langage géré |
| 14.1.3 Configuration durcie | C | `gamedashboard-api.service:39-46` ; `tls-intermediate.conf` |
| 14.1.4 Déploiement automatisé | C | `installer.sh`, `app.sh` |
| 14.2.1 Composants à jour | C | Renovate ; `pnpm outdated -r` ; règle « dernière version stable » |
| 14.2.2 Fonctions inutiles retirées | P | NC-53 ; OpenAPI public assumé (`openapi.controller.ts`) |
| 14.2.3 SRI | P | NC-22 |
| 14.2.4 Sources de composants approuvées | C | Registre npm, actions épinglées par SHA (`ci.yml:35-39,134,148,260`), `pnpm-workspace.yaml` (`allowBuilds`) |
| 14.2.5 SBOM | C | `release.yml:119-125` (CycloneDX attesté) |
| 14.2.6 Bac à sable des dépendances | P | NC-21 |
| 14.3.2 Débogage désactivé | C | `unsafe-eval` hors production (`content-security-policy.ts:35`) ; `poweredByHeader: false` |
| 14.3.3 Pas de version dans les en-têtes/erreurs | P | NC-48, NC-50 |
| 14.4.1 `charset` | C | Sonde 1.1 ; `panel.conf:77` |
| 14.4.2 `Content-Disposition` des téléchargements | C | `web/app/api/admin/audit-export/route.ts:54` |
| 14.4.3 CSP | C | `content-security-policy.ts:34-45` ; `proxy.ts:15-25` ; `e2e/securite.spec.ts` |
| 14.4.4 `X-Content-Type-Options: nosniff` | P | Next oui (`next.config.ts:14`) ; API non (NC-50) |
| 14.4.5 HSTS | P | `max-age=31536000` sans `includeSubDomains` (NC-50) |
| 14.4.6 `Referrer-Policy` | C | `next.config.ts:17` |
| 14.4.7 Anti-cadrage | C | `X-Frame-Options: DENY`, `frame-ancestors 'none'` |
| 14.5.1 Méthodes HTTP attendues seulement | C | Sonde 4.1 |
| 14.5.2 `Origin` jamais utilisé pour autoriser | C | Contrôle d'origine du relais WebSocket = anti-CSRF seul (`websocket/route.ts:33-36`) |
| 14.5.3 CORS strict | C | `main.ts:62-65` ; sonde 1.7 |
| 14.5.4 En-têtes ajoutés par les proxies authentifiés | C | `trustProxy` en liste (`main.ts:37`) ; `CF-IPCountry` vidé par nginx (`panel.conf:189,214`) ; sonde 4.3 |

---

## 5. Secrets en base : ce qui est haché, chiffré, en clair

| Table.colonne | Nature | Protection | Écriture | Rotation (`TARGETS`) |
|---|---|---|---|---|
| `users.password_hash` | mot de passe | Argon2id m=19456 t=2 p=1 ; bcrypt hérité réécrit | `auth.controller.ts:319,662,818,972` | s.o. |
| `user_credentials_totp.secret_enc` | secret TOTP | AES-256-GCM (sans AAD) | `two-factor.repository.ts:127` | oui |
| `user_recovery_codes.code_hash` | codes de secours | Argon2id | `two-factor.repository.ts:261-273` | s.o. |
| `sessions.token_hash` | session | SHA-256 | `session.repository.ts:129-132` | s.o. |
| `auth_tokens.token_hash` | réinitialisation, vérification, facturation | SHA-256 | `auth-token.repository.ts:114-117` | s.o. |
| `api_keys.key_hash`, `application_keys.key_hash` | clés d'API | SHA-256 (secret de 256 bits) | `api-keys.service.ts:102-108`, `application-keys.service.ts:170-175` | s.o. |
| `server_invites.token_hash` | invitation | SHA-256 | `server-invites.service.ts:150-160` | s.o. |
| `nodes.daemon_token_enc` | jeton Wings | AES-256-GCM (sans AAD) | `node-configuration.service.ts:160` | oui |
| `database_hosts.password_enc`, `databases.password_enc` | MySQL | AES-256-GCM (sans AAD) | `database-hosts.service.ts:142`, `databases.service.ts:144` | oui |
| `webhooks.secret_enc`, `application_webhooks.secret_enc` | HMAC | AES-256-GCM (sans AAD) | `server-webhooks.service.ts:126`, `webhook-registry.service.ts:219` | oui |
| `settings.value` (`is_secret`) : SMTP, CurseForge, OIDC, Google, S3, Turnstile, facturation | secrets de plateforme | AES-256-GCM | `platform-settings.service.ts:383` | oui |
| `settings.value` : identifiants (`accessKey`, `clientId`, `siteKey`) | identifiants | **clair** (non secrets) | `platform-settings.service.ts:438-442` | s.o. |
| `idempotency_records.response` | réponses (PII) | **clair** | `idempotency.service.ts:92-98` | s.o. (NC-39) |
| `users.email`, `nameFirst`, `sessions.ip` | PII | **clair** | — | s.o. (NC-62) |

---

## 6. Routes appelées par Wings : appartenance au node

Garde de classe `NodeTokenGuard` (`remote.controller.ts:55`), filtre
`WingsErrorFilter` (`:56`), node lu dans `request.node` (jamais dans le corps).

| Route | Ligne | Prédicat |
|---|---|---|
| `GET /servers` | 87 | `eq(servers.nodeId, nodeId)` (`remote-server.service.ts:46,52`) |
| `POST /servers/reset` | 109 | `nodeId` + états `installing`/`restoring` (`:211`) |
| `GET /servers/:uuid` | 128 | `id ∧ nodeId` (`:84`), ou node d'arrivée d'un transfert en cours borné (`server-transfer.service.ts:489-503`) |
| `GET/POST /servers/:uuid/install` | 140, 150 | `:137`, `:158-164` |
| `POST /sftp/auth` | 168 | `sftp-auth.service.ts:120` |
| `POST /servers/:uuid/archive` | 188 | sans effet (journal seul) |
| `POST /servers/:uuid/transfer/:state` | 205 | `isTransferTarget` / `reportedBy ∈ {from, to}` (`server-transfer.service.ts:348-357,489-503`) |
| `GET/POST /backups/:uuid` | 253, 271 | `servers.nodeId` (`remote-backup.service.ts:58-59,102-103`) ; **sans test « en cours »** (NC-09) |
| `POST /backups/:uuid/restore` | 293 | `servers.nodeId` (`RemoteBackupService.restored`) ; ne lève que l'état `restoring`, et consigne l'issue une fois (NC-44) |
| `POST /activity` | 304 | serveurs du node (`remote-activity.service.ts:226-243`) ; auteur non lié (NC-45) |

---

## 7. Doutes restant à trancher par un test

Ce que la lecture et l'instance jetable n'ont pas permis de conclure. Chaque
ligne dit le test qui tranche.

| N° | Doute | Test |
|---|---|---|
| D-1 | Wings refuse-t-il `set state`/`send command` sur un serveur suspendu ou en installation quand le jeton porte `control.*` ? (NC-14) | Sur Codiax : `infra/local/verifier-console.sh` avec un serveur `suspended`, envoyer `{"event":"set state","args":["start"]}` |
| D-2 | Le jeton de transfert (sans `jti`, 1 h) est-il rejouable vers `POST /api/transfers` du node d'arrivée ? | Rejouer le même `Bearer` après un transfert réussi (`verifier-transfert.sh`) |
| D-3 | Énumération par le temps sur « mot de passe oublié » (3 ms contre 1 ms sur une machine vide) | 200 requêtes alternées, comparer les médianes sous charge réelle |
| D-4 | HIBP injoignable : le repli ouvert (`policy.ts:130`) est-il voulu au niveau 2 ? | Décision, pas test |
| D-5 | Session d'emprunt promue : si un second administrateur promeut la cible pendant la prise en main, la session empruntée écrit dans `/admin` sous le nom de la cible | Test d'intégration : emprunt, promotion, `POST /admin/settings/flags/…` → attendre 403 |
| D-6 | Clé d'accès dont le compteur reste à 0 (clés synchronisées) : rejeu accepté par `verifyAuthenticationResponse` ? | `SoftwareAuthenticator.authenticate(…, { counter: 0 })` deux fois |
| D-7 | Course entre `dejaLie` et `link` (`sso.service.ts:289-301`, pas d'index unique `(userId, provider)`) | Deux `resolveUser` concurrents sur un compte existant |
| D-8 | Wings bloque-t-il les plages privées sur `files/pull` ? (NC-47) | Mock Modrinth rendant `http://169.254.169.254/`, observer le node |
| D-9 | `Cache-Control` des pages Next authentifiées (`private, no-store` attendu par défaut en rendu dynamique) | `curl -sI -b "__Host-gd_session=…" https://panel/servers` |
| D-10 | Transfert d'un serveur rattaché à un revendeur vers le node partagé d'un autre : consommation de part non comptée ? | Test d'intégration `server-transfer` + `reseller-share` |

---

## 8. Rejouer les sondes

```bash
# base jetable et administrateur
createdb gd_asvs_live
DATABASE_URL=postgres://…/gd_asvs_live pnpm db:migrate
DATABASE_URL=… pnpm --filter @gamedashboard/api exec tsx scripts/create-admin.mts admin@audit.test Audit Admin
# API seule, en mode production, sur des ports libres
cd apps/api && DATABASE_URL=… APP_SECRET_KEY=$(openssl rand -base64 48) PORT=3299 HOST=127.0.0.1 \
  PANEL_ORIGIN=http://localhost:3298 NODE_ENV=production pnpm exec tsx src/main.ts
# ouvrir les inscriptions pour les sondes 2 et 3
psql … -c "insert into settings (key, value) values ('security.registrationOpen', 'true')"
```

Les requêtes sont celles du tableau §3 ; un code TOTP se calcule avec
`totpCodeAt(secret, totpStep())` de `packages/auth/src/totp.ts`.
