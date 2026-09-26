# GameDashboard Game Dashboard

Panel de gestion de serveurs de jeu basé sur Docker. Voir [PLAN.md](./PLAN.md) pour l'architecture complète.

## Structure

```
apps/web            Next.js 16 : espace client, revendeur, administration
apps/api            NestJS : API client, applicative, contrat Wings, balayages de fond
packages/ui         Design system (@gamedashboard/ui)
packages/contracts  Schémas Zod, règles métier partagées, catalogue d'API
packages/db         Schéma Drizzle + migrations PostgreSQL (@gamedashboard/db)
packages/auth       Mots de passe, chiffrement des secrets, TOTP, jetons
packages/i18n       Catalogues FR/EN et choix de langue (@gamedashboard/i18n)
packages/mysql      Provisionnement des bases MySQL des clients
packages/sdk        Client TypeScript pour les intégrateurs
packages/config     Presets TypeScript partagés
infra/docker        Services de développement (compose)
infra/local         Production locale sur Codiax et bancs contre un Wings réel
infra/prod          Modèle de production sous systemd
infra/eggs          Eggs maison (Minecraft Java unifié)
docs/               ADR, runbooks, guide du contributeur, reprise Pterodactyl
```

## Installer sur un serveur

Sur une Debian ou une Ubuntu neuve, une seule commande — rien d'autre à
télécharger, pas de dépôt à cloner :

```bash
curl -fsSL https://github.com/PowerNexus/PowerDashboard/releases/latest/download/gamedashboard.sh | sudo bash -s -- install
```

Elle télécharge la dernière version publiée (déjà compilée), vérifie son
empreinte, lance l'installation guidée et installe la commande
`gamedashboard` : `status`, `start`, `stop`, `restart`, `logs`, `backup`,
`update`, `admin`, `password`, `wings`, `help`. Le pas à pas complet, pensé
pour qui découvre le projet : [docs/installation.md](./docs/installation.md).
Sur un hébergement mutualisé cPanel (Setup Node.js App), sans nginx ni
systemd ni terminal : l'archive autonome de chaque release, qui se met
ensuite à jour d'elle-même ([docs/hebergement-cpanel.md](./docs/hebergement-cpanel.md)).

Depuis un clone ou une archive extraite, les mêmes commandes s'appellent
`pnpm app:install`, `pnpm app:setup`, `pnpm app:start`… (`pnpm app:help`).
Le préfixe les met à l'abri des commandes de pnpm lui-même (`pnpm setup` en
est une).

## Démarrer (développement)

```bash
pnpm install
pnpm services:up    # PostgreSQL, Redis, MinIO, Mailpit
cp apps/api/.env.example apps/api/.env          # renseigner APP_SECRET_KEY
cp apps/web/.env.example apps/web/.env.local
pnpm db:migrate
pnpm dev            # API sur :3201, interface sur http://localhost:3000
```

Le premier compte administrateur se crée par
`pnpm --filter @gamedashboard/api exec tsx scripts/create-admin.mts <email> <prénom> <nom>`.

`pnpm services:down` arrête les conteneurs **en conservant les données**. Pour
repartir d'une base vierge, il faut ajouter `-v` à la main : effacer des volumes
ne doit pas être ce qui arrive quand on se trompe de commande.

Détails et identifiants : [infra/docker/README.md](./infra/docker/README.md).
Règles du dépôt et gestes courants : [docs/contribuer.md](./docs/contribuer.md).

## Le daemon n'est pas réécrit

Wings est conservé tel quel, en binaire amont non forké. Le périmètre réécrit
s'arrête à l'interface, à l'API et à l'identité : l'isolation des conteneurs —
traversée de chemin, symlinks, extraction d'archive, évasion — reste celle qui a
été éprouvée pendant dix ans. Voir §4.3 de [PLAN.md](./PLAN.md) pour le
raisonnement, et §5.5 pour le modèle de confiance que cela impose (jeton de node,
pas mTLS).

## État d'avancement

**V1 terminée.** Le panel fonctionne de bout en bout contre un Wings réel :
les dix bancs de [infra/local](./infra/local/README.md) l'éprouvent (cycle de
vie d'un serveur, SFTP, sauvegardes, console, bases MySQL, revendeurs,
transfert entre deux daemons, rotation du jeton de node, planificateur).

| Espace | Écrans |
|---|---|
| Client | `/` tableau de bord, `/servers`, `/servers/new`, `/account` (profil, sécurité, clés API), `/status` |
| Serveur | `/server/[id]` console et graphes, `files` (et éditeur), `backups`, `databases`, `users`, `schedules`, `network`, `settings`, `activity`, `marketplace`, `engine`, `webhooks` |
| Revendeur | `/reseller` : parc, clients, serveurs, marque et domaine propre, clés applicatives, webhooks, réglages |
| Administration | `/admin` : nodes, serveurs, comptes, eggs, hôtes MySQL, montages, domaines, annonces, incidents, API, audit, réglages |
| Connexion | `/login`, `/register`, `/forgot`, `/reset`, `/verify`, `/invitation/[token]`, `/sso/[token]` |

La référence de l'API se lit sur l'écran `/admin/api` et dans
[openapi.json](./openapi.json), tous deux tirés du même catalogue
([ADR 0003](./docs/adr/0003-catalogue-api-source-unique.md)). La palette de
commandes s'ouvre avec `Ctrl+K`. En développement, l'écran `/design` montre tous les composants
dans les deux thèmes, sur des données de démonstration (`apps/web/src/lib/mock.ts`,
son seul lecteur) ; en production, il répond « introuvable » et sort de la navigation.

### Composants de `@gamedashboard/ui`

**Atomes** `Button`, `Badge`, `StatusDot`, `Avatar`, `Input`, `PasswordInput`, `FormField`,
`Select`, `Switch`, `Progress`, `Skeleton`, `Brand`, `LogoMark`

**Molécules** `Card`, `KeyValueGrid`, `PageHeader`, `AlertBanner`, `Tabs`, `EmptyState`,
`StatTile`, `MetricBar`, `ThemeToggle`, `Dialog`, `ConfirmDialog`, `Dropdown`, `RowActions`,
`SettingToggle`

**Organismes** `DataTable`, `AppShell`, `AppHeader`, `SidebarNav`, `ServerCard`,
`ServerStatusBar`, `AuthCard`, `PowerControls`, `ConsoleView`, `SparkChart`, `FileBrowser`,
`PermissionMatrix`, `CronBuilder`, `CommandPalette`, `NotificationCenter`, `SelectMenu`,
`RelativeTime`, `Wizard`, `OptionCard`, `CodeBlock`, `CopyButton`, `MethodBadge`

### Règles métier partagées

`@gamedashboard/contracts` porte les règles qui doivent être identiques partout, pas seulement
les types. En particulier `nodeStatus()` déduit l'état d'un node de l'âge de son heartbeat
plutôt que d'un booléen stocké à côté, qui finirait par le contredire. Les mesures d'un
node injoignable sont absentes, jamais à zéro : `MetricBar` accepte une valeur nulle et
la rend en hachures.

### Notes d'implémentation

- **`SelectMenu` plutôt que `Select`.** Le `<select>` natif fait rendre sa liste par le
  système d'exploitation, qui ignore le thème sombre. `SelectMenu` (Radix) est entièrement
  soumis aux tokens et gère groupes, descriptions et options désactivées.
- **`RelativeTime` pour toute date affichée en relatif.** Le serveur et le client rendent à
  des instants différents, donc « il y a 12 minutes » diffère forcément entre les deux.
  Le composant pose `suppressHydrationWarning` pour que React garde la valeur client.
- **Le logo vit dans `apps/web/public/brand/`.** `LogoMark` accepte une prop `src` pour la
  marque blanche.

**Gabarits** `PageTemplate`, `SettingsSection`

## Langues

Français et anglais, via next-intl. **Aucun préfixe de langue dans l'URL** : le
panel est entièrement authentifié, donc la langue appartient au compte et non à
l'adresse. Un lien vers un serveur partagé entre collègues s'ouvre ainsi dans la
langue de celui qui clique, et non dans celle de qui a copié l'URL.

L'ordre de préférence est : compte, puis cookie `NEXT_LOCALE`, puis
`Accept-Language`, puis français.

Les catalogues vivent dans `packages/i18n/src/messages/`. Le français fait foi :
les clés y sont créées, et `messages.test.ts` vérifie que l'anglais ne manque
aucune clé, n'en garde aucune orpheline, et emploie les mêmes variables. Une
traduction manquante ne lève jamais d'erreur — elle affiche du français à un
anglophone, ce que seul un test peut rattraper.

**État de la migration.** Toute l'interface est traduite. Seule la page hors
ligne reste bilingue à dessein : elle s'affiche sans réseau ni session, donc
sans langue connue. Le motif est `await getTranslations("…")` dans un composant
serveur, `useTranslations("…")` dans un composant client. Une route citée dans
un texte (`<c>POST /servers/{server}/websocket</c>`) est vérifiée contre l'API
par `api-reference-coverage.test.ts`.

## Configuration

Copiez `apps/api/.env.example` en `apps/api/.env` et `apps/web/.env.example` en
`apps/web/.env.local`, puis renseignez les valeurs.

| Variable (API) | Rôle |
|---|---|
| `APP_SECRET_KEY` | Clé maître des secrets chiffrés. Sans elle, l'API refuse de démarrer. |
| `HOST`, `TRUSTED_PROXIES` | Interface d'écoute et intermédiaires crus pour l'adresse cliente. |
| `CURSEFORGE_API_KEY` | Recherche CurseForge. Obligatoire pour cette source. |
| `CURSEFORGE_API_URL` | Base de l'API CurseForge. |
| `MODRINTH_API_URL` | Base de l'API Modrinth. Aucune clé requise. |
| `MODRINTH_USER_AGENT` | Modrinth exige un agent identifiant l'appelant. |

| Variable (web) | Rôle |
|---|---|
| `API_URL` | Adresse interne de l'API. |
| `PANEL_ORIGIN` | Origine publique du panel. |

Les clés de catalogue vivent dans l'**API**, pas dans l'interface, et aucune
variable ne porte le préfixe `NEXT_PUBLIC_` : le navigateur passe par l'API, qui
ajoute la clé côté serveur. Une clé exposée au client serait lisible dans les
outils réseau de n'importe quel visiteur.

## Dépendances

Le projet suit les dernières versions stables, pour limiter la surface d'attaque.
Vérifier régulièrement :

```bash
pnpm outdated -r
pnpm audit --audit-level low
```

Les overrides de version vivent dans `pnpm-workspace.yaml`, et non dans `package.json` :
pnpm 11 ne lit plus le champ `pnpm` du fichier de paquet. Deux sont en place : `esbuild`,
que drizzle-kit tire via un chargeur déprécié, et `@types/node`, aligné sur la majeure du
moteur (Node 24) jusque dans les pairs installés d'office.

`trustPolicyExclude`, dans le même fichier, liste les rares versions acceptées malgré une
publication moins garantie que la précédente (perte de la provenance) : chacune a été
relue, et sa justification est écrite à côté.

Le même fichier porte `allowBuilds`, la liste des paquets autorisés à exécuter un script
d'installation. pnpm les bloque par défaut, et c'est justifié : un `postinstall` s'exécute
avant la première ligne du projet, ce qui en fait la voie d'entrée classique d'une
compromission de chaîne d'approvisionnement. Chaque ligne y est une exception motivée.

**Turbopack.** Next 16 l'active par défaut. Une configuration `webpack` résiduelle fait
échouer le build, d'où la section `turbopack` vide dans `next.config.ts`, qui vaut adhésion
explicite. Conséquence : le contournement de scrutation que webpack permettait n'existe plus,
et c'est la raison pour laquelle **le dépôt vit dans le système de fichiers de WSL**
(`/root/workspace/GameDashboard`) et non sur `/mnt/c`. Le montage `drvfs` n'émet aucun
événement `inotify` : un fichier édité depuis Windows change bien sur le disque, et le veilleur
Linux ne l'apprend jamais. Le rechargement à chaud ne fonctionne alors pas, sans que rien ne le
signale — l'erreur qu'on finit par lire accuse le code, sur un export pourtant bien présent,
parce que le graphe de modules date du démarrage du serveur. `watchOptions: { pollIntervalMs }`
ne rattrape pas : essayé, mesuré, sans effet sur le web.

## Vérifications

```bash
pnpm lint        # Biome
pnpm typecheck   # TypeScript strict sur tous les paquets
pnpm test        # Vitest ; avec DATABASE_URL, les tests d'intégration aussi
pnpm db:check    # échoue si le schéma et les migrations ne sont pas en phase
pnpm openapi     # openapi.json doit rester identique au fichier versionné
pnpm e2e         # Playwright contre l'API réelle et PostgreSQL
```

Les tests unitaires couvrent ce qui a des règles, pas le rendu : seuils de
heartbeat et précédence entre maintenance et injoignabilité, permissions,
jetons Wings, chiffrement des secrets, planificateur, catalogue d'API. Le
parcours et l'accessibilité (axe) sont couverts par Playwright, le contrat
Wings par les bancs d'[infra/local](./infra/local/README.md).

## Conventions

- Une page = template + hooks + organismes, moins de 80 lignes.
- Aucun composant de `packages/ui` n'importe de logique métier.
- Tokens de design dans `packages/ui/src/styles/tokens.css`, jamais de couleur en dur.
- Lint et format : `pnpm lint` (Biome).
