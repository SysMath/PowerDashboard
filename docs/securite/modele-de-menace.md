# Modèle de menace

Qui peut vouloir quoi du panel, par où il passe, et ce qui l'en empêche.
Chaque contrôle renvoie au code qui le tient ; les écarts encore ouverts
renvoient au [rapport d'audit ASVS niveau 2](./rapport-asvs-l2.md) (`NC-nn`).
Le lien panel ↔ Wings est détaillé dans [PLAN §5.5](../../PLAN.md), les
données au repos dans l'[ADR 0007](../adr/0007-secrets-et-donnees-au-repos.md).

## Acteurs

| Acteur | Accès légitime | Ce qu'il vise s'il est hostile |
|---|---|---|
| Visiteur anonyme | Connexion, inscription si ouverte, statut, spécification OpenAPI | Un compte (force brute, énumération), un navigateur connecté (CSRF, XSS) |
| Client, sous-utilisateur | Ses serveurs, selon ses permissions par serveur | Les serveurs d'autrui (IDOR), une permission qu'il n'a pas |
| Revendeur | Son parc, ses clients, ses clés applicatives | Sortir de son périmètre, dépasser son enveloppe |
| Support, administrateur | Tout le panel ; prise en main en lecture seule | Abus de pouvoir ; compte volé = panel entier |
| Système tiers (facturation) | API applicative, par clé à portées | Clé volée : créer, suspendre, entrer dans un compte |
| Node Wings | Routes `/api/remote`, par jeton de node | Node compromis : lire ou écrire hors de ses serveurs |
| Application mobile (appareil lié, ADR 0010) | Espace client et profil, par jeton d'appareil `gd_mob_` ; liaison `auth/app/` | Téléphone volé ou secret copié : agir au nom du compte ; fausse instance qui imite une page de connexion |
| Fournisseur d'identité (OIDC, Google) | Affirmer une identité | Annuaire mal réglé, connexion forcée sur le compte d'un autre |
| Chaîne d'approvisionnement | Dépendances, CI, actions | Code exécuté dans le panel ou sur le runner |
| Root sur la machine du panel | Tout | Hors modèle : il lit la clé maître et la base (ADR 0007) |

## Actifs

- **Comptes et sessions**, d'abord ceux du personnel : une session
  d'administrateur ouvre tout.
- **Clé maître** (`APP_SECRET_KEY`) et ce qu'elle déchiffre : **jetons de
  node** (pouvoir total sur un node), mots de passe MySQL, secrets de
  plateforme (SMTP, S3, OIDC…).
- **Serveurs de jeu** : fichiers, consoles, bases, sauvegardes.
- **Clés d'API** personnelles et applicatives ; **appareils mobiles liés**
  (jeton d'accès, secret d'appareil, clé publique P-256).
- **Clés de publication de l'application mobile** : clé d'envoi Android,
  certificat et profil de distribution Apple, comptes d'API des deux
  magasins (environnement GitHub `magasins`).
- **Journal d'activité**, preuve en cas d'incident ; **données personnelles**
  (adresses, adresses IP).
- **Disponibilité** du panel, dont dépend le pilotage de tous les nodes.

## Frontières de confiance

```
navigateur ──TLS──▶ nginx ──boucle locale──▶ Next ──boucle locale──▶ API ──▶ PostgreSQL
    │                  │                                             │  ▲
    │                  └── publie : /api/v1/application/, /api/remote/,│  │ /api/remote
    │                      /api/application/, openapi.json, status ──┘  │ (jeton de node)
    └──────── console, envois : jetons signés courts ──────────▶ Wings ─┘
                                                     API ──jeton de node──▶ Wings
API ──▶ facturation (clé applicative), OIDC / Google, compartiment S3
```

| Frontière | Ce qui la garde |
|---|---|
| Navigateur → nginx | TLS, HSTS avec sous-domaines, `limit_req`, en-têtes réécrits (`infra/prod/panel.conf`) ; CSP à nonce (`apps/web/src/proxy.ts`) ; cookie `__Host-`, `HttpOnly`, `Secure`, `SameSite=Lax` |
| nginx → Next | Boucle locale ; `X-Forwarded-Host` réécrit, `CF-IPCountry` vidé. Actions serveur : contrôle d'origine de Next ; relais console et envois : `apps/web/src/server/browser-provenance.ts` |
| Next → API | Boucle locale (`HOST=127.0.0.1`) ; Next relaie cookie et provenance (`x-gd-*`, `forwarded.ts`) ; `SessionGuard` refuse l'écriture par cookie venue d'un autre site ; seuls les intermédiaires de `TRUSTED_PROXIES` sont crus |
| Internet → API publiée | `ApplicationGuard` (portées, liste d'IP, expiration, idempotence), `NodeTokenGuard` (routes bornées aux serveurs du node) ; le reste de l'API n'est pas publié |
| Application mobile → API | nginx n'envoie l'espace client à l'API que pour un jeton `gd_mob_`, sans cookie (`$gd_mobile_upstream`) ; `SessionGuard` borne l'appareil aux routes de `appMayReach` et exige la confirmation de présence pour les gestes de `APP_PRESENCE_ROUTES` (`packages/contracts/src/app-devices.ts`) ; liaison par code de soixante secondes et PKCE, échange et renouvellement signés par la clé P-256 du téléphone, secret remplacé à chaque renouvellement et retrait sur rejeu (`app-device.repository.ts`) |
| API → PostgreSQL | Base locale, identifiants dans `env/` ; secrets chiffrés (AES-256-GCM), mots de passe et jetons hachés |
| Panel ↔ Wings | Jeton statique par node, rotation ([runbook](../runbooks/rotation-jeton-node.md)) ; jetons WebSocket signés, dix minutes, révocables (`wings-token.service.ts`) ; API de Wings jamais publique (PLAN §5.5) |
| Panel ↔ facturation | Clé applicative à portées ; lien de connexion à usage unique, deux minutes (`billing-sso.service.ts`) |
| Panel ↔ OIDC, Google | `state` et PKCE dans un cookie de la couche web (`apps/web/src/server/ceremony.ts`), adresse de retour bornée à `PANEL_ORIGIN`, rapprochement des comptes par adresse vérifiée (`sso.service.ts` ; NC-27, NC-58) ; second facteur du panel exigé ensuite |
| Machine | `env/` en 750, fichiers en 640 ; services confinés par systemd ; sauvegardes chiffrées, clé hors de l'archive (`infra/prod/app.sh`) |
| CI | Runner auto-hébergé, PR de fork refusées ; actions épinglées par empreinte, jeton en lecture seule ; `pnpm audit`, Trivy, Semgrep, ZAP ; SBOM attesté (`.github/workflows/`) |

## Menaces principales

| Menace | Contrôles | Écarts ouverts |
|---|---|---|
| Prise de compte par mot de passe | Argon2id, refus des mots de passe compromis (`packages/auth/src/password.ts`, `policy.ts`) ; délai progressif et verrou (`throttle.ts`) ; captcha facultatif ; second facteur TOTP ou clé d'accès ; alertes de connexion (`security-alert.service.ts`) | NC-04, NC-10, NC-29 |
| Vol, fixation ou rejeu de session | Jeton de 256 bits haché en base, nouveau à chaque connexion, révoqué à la déconnexion (`session.repository.ts`) | NC-03 |
| Téléphone volé, secret d'appareil copié | Jeton de quinze minutes ; secret inutile sans la clé matérielle ; secret rejoué = appareil retiré et titulaire prévenu ; 30 jours d'inactivité, 90 jours au plus ; retrait depuis Compte › Sécurité ; coupure avec les sessions et au changement de second facteur ; jamais la sécurité du compte, les clés d'API ni l'administration (`BrowserSessionGuard`, `isBrowserSession`) | Banc réel sur téléphone (ADR 0010) |
| CSRF | `SameSite=Lax` ; contrôle d'origine des actions serveur, des relais et de l'API, règle unique (`packages/contracts/src/browser-provenance.ts`) | — |
| XSS, script tiers | Échappement de React ; CSP à nonce et `strict-dynamic` ; `nosniff` ; aucun CDN, Monaco servi par le panel (`apps/web/src/lib/monaco.ts`) | — |
| IDOR, élévation de droits | Point unique `ServerAccessService.require` (`permissions-coverage.test.ts`) ; gardes de rôle et d'écriture ; prise en main en lecture seule | NC-06, NC-15, NC-16, NC-20 |
| Revendeur hors de son périmètre | `ResellerScopeService` (`reseller-perimeter.test.ts`) ; enveloppe de ressources | NC-01, NC-07, NC-08 |
| Clé applicative volée | Portées déclarées route par route, liste d'IP, expiration à 365 jours (`application.guard.ts`) | NC-37, NC-38 |
| Node compromis, jeton de node volé | Un jeton par node ; routes `remote` bornées aux serveurs du node ; rotation | NC-09, NC-12, NC-45 |
| Abus par la console ou les fichiers | Confinement par Wings (ADR 0001) ; jetons WebSocket courts et révocables | NC-14, NC-41, NC-46 |
| Requête forgée côté serveur (SSRF) | `assertPublicDestination` sur les webhooks (`apps/api/src/common/public-url.ts`) | NC-47, NC-56 |
| Fuite de la base ou d'une sauvegarde | Secrets chiffrés, mots de passe et jetons hachés ; sauvegardes chiffrées ; volume chiffré (ADR 0007) | NC-18, NC-19 |
| Application piégée publiée sous le nom de l'éditeur | Secrets dans l'environnement `magasins`, approuvé par Matheo, jamais donné à une PR ; clé d'envoi donnée à la seule commande qui signe, hors du dépôt copié ; APK signé par la clé de débogage refusé ; signature finale par Google Play, clé d'envoi remplaçable ; pistes de test seulement, publication à la main ; binaires attestés avec leur inventaire (`mobile.yml`, `docs/application-mobile.md`) | Le code des dépendances tourne dans le conteneur où l'application se signe |
| Chaîne d'approvisionnement | Lockfile gelé, audit bloquant dès *low*, Trivy, Semgrep, actions épinglées, SBOM attesté, jeton de CI en lecture | — |
| Déni de service | `limit_req` de nginx, corps bornés, balayages de fond qui ne tuent pas le processus (`battre()`) | NC-17, NC-49 |
| Répudiation | Journal d'activité en ajout seul (déclencheur), exportable (`activity.service.ts`) | NC-11, NC-12, NC-54 |

## Hors modèle

- **Root sur la machine du panel** : il lit la clé maître, la base et les
  secrets déchiffrés. La réponse est l'[incident de
  sécurité](../runbooks/incident-securite.md), pas un contrôle du panel.
- **Wings lui-même** : conservé tel quel (ADR 0001), son confinement des
  conteneurs et des fichiers est éprouvé par les bancs `infra/local`.
- **L'hébergeur** des machines, et les fournisseurs tiers (S3, SMTP,
  facturation) au-delà de ce que le panel leur envoie.

Ce document se revoit à chaque nouvelle frontière (un fournisseur, un
préfixe publié par nginx, un nouveau type de clé) et à chaque audit.
