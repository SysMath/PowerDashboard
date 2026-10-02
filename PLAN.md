# GameDashboard Game Dashboard — Plan complet

> Panel de gestion de serveurs de jeu (et plus tard VPS) basé sur Docker, au niveau de qualité de Pterodactyl / WISP.gg, avec une stack 2026, une sécurité renforcée et une bibliothèque de composants 100 % réutilisables.
>
> Ce document est la référence unique du projet. Il est organisé en 12 parties :
>
> 1. Vision & positionnement
> 2. Analyse des captures d'écran (existant GameDashboard)
> 3. Architecture globale
> 4. Stack technique (et justification de chaque choix)
> 5. Sécurité
> 6. Modèle de données
> 7. API (REST + temps réel)
> 8. Intégration Wings (le daemon est conservé)
> 9. Design system & bibliothèque de composants
> 10. Fonctionnalités par module (Client / Admin)
> 11. Structure du monorepo
> 12. Roadmap, phases, tests, DevOps

---

## 1. Vision & positionnement

### 1.1 Objectif

Construire **un panel de gestion de serveurs de jeu** (équivalent Pterodactyl / WISP.gg) entièrement custom, basé sur Docker, avec une stack moderne, une sécurité renforcée et une interface au niveau des meilleurs panels du marché.

Les captures d'écran fournies (page de connexion, panier, centre d'aide, panel Pterodactyl) servent **uniquement de référence visuelle** : on reprend leur identité graphique, leur mise en page et leurs patterns d'interface. Elles ne définissent pas le périmètre fonctionnel. La facturation, le panier et les tickets restent hors périmètre de ce projet (un point d'intégration reste prévu via l'API application, voir §7.1, pour un éventuel branchement futur).

Ce que remplace le panel : `game.gamedashboard.fr` (Pterodactyl 1.x + Wings). Même périmètre fonctionnel, plus les fonctionnalités que Pterodactyl n'a pas (voir §10).

**Ce que le projet ne remplace pas : Wings.** Le daemon Pterodactyl est conservé tel quel. Le périmètre réécrit s'arrête à l'interface, à l'API et à l'identité ; la couche d'isolation reste celle qui tourne déjà en production. Ce choix est structurant, la raison figure en §4.3 et son modèle de confiance en §5.5.

### 1.2 Principes directeurs

1. **Docker-native** : chaque serveur de jeu est un conteneur isolé, orchestré par notre daemon (compatible « eggs » Pterodactyl pour ne pas repartir de zéro sur le catalogue de jeux).
2. **Composants réutilisables à tous les niveaux** : UI (design system), backend (modules NestJS), daemon (drivers), infra (modules Ansible). Aucune page ne contient de logique métier propre : une page = composition de composants + hooks.
3. **Temps réel partout** : console, stats CPU/RAM/disque/réseau, état d'installation, notifications, liste de joueurs, sans rafraîchir.
4. **Sécurité par défaut** : 2FA obligatoire pour les admins, passkeys (WebAuthn), tokens courte durée, rate-limiting, audit complet, isolation réseau des conteneurs.
5. **Multi-tenant et multi-nœud dès le départ** : nodes, locations, allocations, sous-utilisateurs, rôles granulaires (RBAC + permissions par serveur).
6. **API-first** : le frontend n'utilise que l'API publique. Tout ce que fait l'UI est scriptable par un client (clé API) ou par un système externe (clé application).
7. **i18n** : FR + EN dès le jour 1 (l'existant mélange français et anglais, c'est un point à corriger).

### 1.3 Ce que Pterodactyl / WISP font mal et que l'on corrige

| Problème observé | Réponse |
|---|---|
| Console = simple websocket, pas d'historique persistant, pas de recherche | Console avec buffer persistant (Redis stream), recherche, filtres par niveau, liens cliquables, autocomplete des commandes du jeu |
| Gestionnaire de fichiers lent, pas d'éditeur avancé | Éditeur Monaco (VS Code), diff avant sauvegarde, upload par chunks résumable (tus), archive/extract en arrière-plan avec progression |
| Aucune notion de « santé » du serveur | Health checks par jeu (query protocol : Minecraft, Source, FiveM…), alertes configurables, graphes historiques (30 jours) |
| Backups locaux ou S3 sans planification fine | Backups planifiés, rétention, restauration partielle (fichier par fichier), stockage S3 compatible + local |
| Sous-utilisateurs = liste plate de permissions | Rôles prédéfinis (Viewer / Moderator / Developer / Owner) + permissions fines, invitations par lien expirable |
| Interface peu responsive, 2 thèmes seulement | Mobile-first, thème clair/sombre/système, densité réglable, palette accent personnalisable (marque blanche revendeurs) |
| Pas de « boutique » intégrée | Module Marketplace : plugins/mods/modpacks (Modrinth, CurseForge, SpigotMC), installation en un clic, versions gérées |
| Aucune notion d'incidents | Page status intégrée (par node), bannières d'incident, historique |

---

## 2. Guide de style tiré des captures d'écran

Les captures montrent deux déclinaisons d'une même identité : une **version claire** (espace client : connexion, panier) et une **version sombre** (centre d'aide, panel). Le nouveau panel supporte les deux, le thème sombre étant celui par défaut pour les écrans « techniques » (console, fichiers) et le clair restant disponible.

### 2.1 Palette

| Rôle | Clair | Sombre | Observé sur |
|---|---|---|---|
| Accent principal | `#7C3AED` | `#8B5CF6` | Bouton « Connexion », « Aller au paiement », « Nouveau ticket », logo, liens |
| Accent hover | `#6D28D9` | `#7C3AED` | |
| Accent doux (fond) | `#EEE9FB` | `#2A2440` | Bandeau d'annonce, onglet actif « Mes tickets », item de sidebar actif « Accès rapide » |
| Fond de page | `#F5F6FA` | `#0F1117` | |
| Surface (cartes) | `#FFFFFF` | `#161922` | Carte de connexion, tableau des tickets |
| Surface secondaire (champs, lignes alternées) | `#F1F2F6` | `#1E2230` | Champs e-mail / mot de passe, en-tête de tableau |
| Bordure | `#E5E7EB` | `#262A37` | |
| Texte principal | `#111827` | `#F3F4F6` | |
| Texte secondaire | `#6B7280` | `#9CA3AF` | Sous-titres « Vos demandes de support et nos réponses. » |
| Succès | `#22C55E` | idem | Statut « Résolu », serveur en ligne |
| Avertissement | `#F59E0B` | idem | Badge « En cours » (orange sur fond ambre sombre) |
| Danger | `#EF4444` | idem | Pastille « Offline », « Vider le panier », « Supprimer » |
| Info | `#3B82F6` | idem | |
| Badge « Répondu » | violet sur fond violet sombre | | Badge de statut violet = accent |

### 2.2 Typographie

- Police unique sans-serif géométrique, proche de **Inter** / Rubik. On adopte **Inter** avec `font-feature-settings: "cv11", "ss01"` pour se rapprocher du rendu observé.
- **JetBrains Mono** pour la console, les IP, les identifiants courts (`31201e0c`) et le code.
- Échelle observée : titre de page 28–30 px semi-bold (« Connexion », « Mes tickets », « Résumé de la commande »), sous-titre 14 px gris, labels de section 11 px capitales espacées (« ESPACE CLIENT », « GÉRER », « COMPTE », « AIDE », « ESSAIE 48H »), corps 14 px, en-têtes de tableau 11–12 px capitales gris.
- Titres en **semi-bold (600)**, jamais en bold lourd.

### 2.3 Formes, espacements, élévation

- Rayon : 12 px sur les cartes et boutons principaux, 8 px sur les champs, badges en pilule (rayon complet).
- Cartes : bordure 1 px + ombre très légère en clair, bordure seule en sombre.
- Padding interne des cartes : 24 px. Espacement vertical entre sections : 24–32 px.
- Champs de saisie : hauteur 44 px, icône à gauche (enveloppe, cadenas), bouton œil pour le mot de passe, bordure accent + halo au focus (visible sur le champ e-mail de la connexion).
- Boutons : hauteur 44 px pour le primaire pleine largeur, 36–40 px ailleurs. Primaire = fond accent, texte blanc, icône flèche à droite (« Connexion → », « Aller au paiement → »). Secondaire = fond blanc/surface, bordure, icône à gauche (« Commande », « Code support », « Espace client »).
- Badges de statut : pastille de couleur + texte, ou pilule colorée (« En cours », « Répondu »). Badge « NOUVEAU » : pilule accent, texte blanc, capitales.
- Pastille d'état (dot) devant les noms : rouge Offline, vert Online, orange transition.

### 2.4 Patterns de mise en page à réutiliser

**Header** (toutes captures) : logo + nom à gauche, bouton burger, puis à droite une rangée d'actions : bouton secondaire avec icône, icônes avec badge compteur (panier, notifications), sélecteur de langue avec drapeau, bloc « crédit », bloc utilisateur (avatar initiale sur fond accent + « BIENVENUE / Prénom » + chevron). Un seul composant `AppHeader` avec des slots.

**Sidebar** (espace client) : items avec icône + label, groupés sous des labels de section en capitales avec un petit trait accent dessous (« GÉRER », « COMPTE », « AIDE »). Item actif = fond accent doux + texte accent. Bloc utilisateur en bas (avatar, nom, ligne secondaire, chevron). Dans le nouveau panel, ces sections deviennent : GÉRER (Tableau de bord, Serveurs), COMPTE (Profil, Sécurité, Clés API, Clés SSH), AIDE (Statut, Documentation). Sidebar panel serveur (Pterodactyl) : même logique, avec groupes repliables (System, Management, Advanced) et un bloc « serveur courant » en haut (nom, badge Offline, IP, 4 mini-métriques).

**Bandeau d'annonce** : fond accent doux, bordure gauche accent 4 px, texte avec liens en gras. Composant `AlertBanner` (variantes info / warning / danger / success).

**Carte formulaire centrée** (connexion) : largeur 440 px, logo centré, sur-titre en capitales accent (« ESPACE CLIENT »), titre, texte d'aide gris, bouton OAuth pleine largeur avec logo, séparateur « ou avec votre e-mail », champs, lien « Mot de passe oublié ? » aligné à droite du label, captcha Turnstile, bouton primaire pleine largeur, lien de pied « Pas encore de compte ? ». Composant `AuthCard`.

**Page liste** (tickets) : titre + sous-titre à gauche, bouton primaire à droite, ligne d'onglets avec compteurs en pilule (« En cours 2 », « Résolus 1 », « Tous 3 ») + champ de recherche à droite, puis tableau en carte : en-tête capitales gris, lignes avec titre bold précédé de l'identifiant `#77`, ligne secondaire tronquée avec icône, colonnes statut et « il y a 51 minutes ». Composants `PageHeader` + `Tabs` + `DataTable`.

**Page récapitulatif** (panier) : colonne principale avec cartes numérotées (« 2 Informations client », « 3 Remarques ») contenant des grilles label/valeur en deux colonnes, colonne latérale avec carte de résumé, lignes total, bloc « total » sur fond accent plein, bouton primaire. Ce pattern est réutilisé pour les pages de **détail serveur** (Server Details, SFTP Details) et pour le **wizard de création** (résumé à droite).

**Carte serveur** (liste My Servers) : pastille d'état, étoile favori, nom + identifiant court gris, IP:port + node en ligne secondaire, rangée de 4 métriques avec icônes (CPU, RAM, disque, joueurs), deux boutons d'action carrés à droite. Fond légèrement illustré (image du jeu en filigrane). Composant `ServerCard`.

**Console** : onglets All / System / Server, zone sombre pleine hauteur, champ de commande avec `$` accent, icônes upload et envoi à droite, groupe de boutons Start (accent) / Restart / Stop / Kill (rouge au hover), sous la console deux cartes de graphes (CPU, Memory) avec sélecteur 1m / 5m en pilules. Composant `Terminal` + `PowerControls` + `Chart`.

**Notifications** : panneau latéral « Notifications » avec bouton « Clear All » accent, cartes avec titre, horodatage relatif et message.

**Bouton chat flottant** en bas à droite (cercle accent). Composant `FloatingAction`, réutilisé pour le support ou la command palette sur mobile.

### 2.5 Ce que l'on ajoute par rapport aux captures

- Sélecteur de serveur dans le header (command palette `Ctrl+K`).
- Fil d'activité + notifications persistantes (pas seulement un toast « Finished installing »).
- Vue « Dashboard » d'accueil avec KPIs (serveurs en ligne, joueurs, incidents, alertes) au lieu d'une simple liste.
- Barre de statut du serveur toujours visible (état, uptime, joueurs, actions) en haut de chaque page serveur.
- Skeletons de chargement calqués sur la géométrie finale, états vides illustrés, transitions douces (150 ms).
- Cohérence linguistique : tout en FR ou tout en EN selon la locale (les captures mélangent les deux).

---

## 3. Architecture globale

```
                        ┌──────────────────────────────┐
                        │   Navigateur / App mobile    │
                        │   (Next.js 15 + PWA)         │
                        └──────────────┬───────────────┘
                                       │ HTTPS / WSS
                     ┌─────────────────▼──────────────────┐
                     │  Edge : Traefik v3 + Cloudflare     │
                     │  (TLS, WAF, rate-limit, anti-DDoS)  │
                     └───────┬─────────────────┬──────────┘
                             │                 │
              ┌──────────────▼───────┐   ┌─────▼───────────────────┐
              │  API « Core »        │   │  Realtime Gateway       │
              │  NestJS 11 / Fastify │◄──┤  (Socket.IO, cluster)   │
              │  REST + OpenAPI 3.1  │   │  rooms par serveur      │
              └───┬───────┬─────┬────┘   └───────────┬─────────────┘
                  │       │     │                    │
      ┌───────────▼─┐ ┌───▼───┐ │       ┌────────────▼────────────┐
      │ PostgreSQL  │ │ Redis │ │       │  Worker (BullMQ)        │
      │ 17 + Drizzle│ │ 7     │ │       │  backups, install,      │
      └─────────────┘ └───────┘ │       │  emails, webhooks…      │
                                │       └─────────────────────────┘
       HTTPS + WS   │  (jeton de node, réseau d'administration isolé)
        ┌───────────────────────┼───────────────────────┐
        │                       │                       │
┌───────▼────────┐    ┌─────────▼────────┐    ┌─────────▼────────┐
│ Node RYZEN-09  │    │ Node RYZEN-10    │    │ Node …           │
│ Wings (amont)  │    │ Wings (amont)    │    │                  │
│ inchangé       │    │                  │    │                  │
│  ├ Docker API  │    │                  │    │                  │
│  ├ SFTP (ssh)  │    │                  │    │                  │
│  ├ Stats/cgroup│    │                  │    │                  │
│  └ Backups     │    │                  │    │                  │
└────────────────┘    └──────────────────┘    └──────────────────┘
        │
   ┌────▼──────────────┐      ┌──────────────────────┐
   │ Stockage objets   │      │ Observabilité        │
   │ S3 / MinIO        │      │ Prometheus, Loki,    │
   │ (backups, uploads)│      │ Grafana, OpenTelemetry│
   └───────────────────┘      └──────────────────────┘

   Intégrations externes : Modrinth/CurseForge (marketplace), Discord (notifs),
   SMTP, Cloudflare API, fournisseur OIDC (annuaire de l'équipe), système de facturation tiers
   via l'API application (hors périmètre).
```

### 3.1 Découpage en services (tous conteneurisés)

| Service | Rôle | Scale |
|---|---|---|
| `web` | Frontend Next.js (SSR + client) | horizontal |
| `api` | Core REST, auth, RBAC, orchestration | horizontal (stateless) |
| `realtime` | WebSocket gateway (console, stats, events) | horizontal via adapter Redis |
| `worker` | Jobs asynchrones (BullMQ) | horizontal |
| `wings` (daemon) | Un par node physique, pilote Docker. **Binaire amont, non modifié.** | 1 par node |
| `postgres`, `redis`, `minio` | État | managés / HA |
| `traefik` | Reverse proxy, TLS, rate-limit | 2+ |

### 3.2 Flux clés

**Création d'un serveur (depuis l'admin ou un système externe)**
1. L'admin (ou un système externe avec clé application) appelle `POST /api/v1/application/servers`.
2. L'API choisit node + allocation (algorithme : location demandée, RAM/CPU disponibles, pondération).
3. Job `server.install` mis en file. Le worker appelle Wings (`POST /api/servers`, jeton de node) pour créer le conteneur d'installation.
4. Wings streame les logs d'install ; le gateway les relaie. L'UI affiche la progression en direct.
5. À la fin, événement `server.installed` : notification client, webhooks sortants.

**Console**
1. L'UI demande un ticket websocket (`POST /servers/:id/ws-token`, JWT 5 min signé, scope `console`).
2. Connexion WSS directe au gateway (pas au daemon : le daemon n'est jamais exposé aux clients).
3. Le gateway s'abonne au WebSocket de Wings et relaye. Les 2 000 dernières lignes sont conservées dans Redis pour l'historique.

---

## 4. Stack technique

### 4.1 Frontend

| Choix | Pourquoi |
|---|---|
| **Next.js 15 (App Router) + React 19** | SSR pour la vitesse perçue, Server Components pour les pages « lecture », moins de JS envoyé. |
| **TypeScript strict** | Zéro `any`, types partagés avec l'API via un package `@gamedashboard/contracts`. |
| **Tailwind CSS 4 + tokens CSS** | Design tokens (couleurs, espacements, rayons) en variables CSS : thèmes et marque blanche sans recompiler. |
| **shadcn/ui (Radix primitives) réécrit dans `@gamedashboard/ui`** | Accessibilité (clavier, ARIA) gratuite, composants copiés donc totalement contrôlables. |
| **TanStack Query v5** | Cache, invalidation, optimistic updates, hydratation SSR. |
| **TanStack Table v8** | Toutes les listes (fichiers, backups, audit, users) partagent une seule `DataTable`. |
| **Zustand** | État UI local (sidebar, thème, console). |
| **Socket.IO client** | Temps réel avec reconnexion et rooms. |
| **Monaco Editor** | Éditeur de fichiers niveau VS Code. |
| **xterm.js** | Rendu console performant (WebGL), sélection, recherche. |
| **Recharts** (uPlot pour les gros volumes) | Graphes CPU/RAM/réseau. |
| **react-hook-form + Zod** | Formulaires typés, schémas partagés avec le backend. |
| **next-intl** | i18n FR/EN, messages typés. |
| **Storybook 8** | Chaque composant documenté et testé visuellement. |

### 4.2 Backend « Core »

| Choix | Pourquoi |
|---|---|
| **NestJS 11 sur Fastify** | Modules, DI, guards, interceptors : parfait pour des modules réutilisables. Fastify est 2 à 3 fois plus rapide qu'Express. |
| **Drizzle ORM + PostgreSQL 17** | SQL typé, migrations versionnées, pas de magie. |
| **Redis 7** | Cache, sessions, pub/sub temps réel, buffers console, rate-limit. |
| **BullMQ** | File de jobs fiable (backups, installs, emails, webhooks), retries, priorités. |
| **HTTP + WebSocket** entre API et daemon | Contrat imposé par Wings, que nous ne choisissons pas (§7.4, §7.5). |
| **Socket.IO + adapter Redis** | Gateway temps réel scalable. |
| **OpenAPI 3.1 générée** (nestjs/swagger) | SDK TypeScript généré pour le front et pour les intégrations externes. |
| **Zod** partout | Validation entrée/sortie, schémas dans `@gamedashboard/contracts`. |
| **Pino** | Logs JSON structurés vers Loki. |
| **OpenTelemetry** | Traces API jusqu'au daemon. |

### 4.3 Daemon : Wings est conservé

**Décision structurante.** Le daemon n'est pas réécrit. Wings reste le binaire amont, non modifié, mis à jour depuis Pterodactyl.

Le métier consiste à exécuter volontairement du code hostile : un client téléverse un `.jar` arbitraire et on le lance. La sécurité réelle du produit se joue donc dans l'isolation — traversée de chemin dans le gestionnaire de fichiers, symlinks sortant du volume, zip-slip à l'extraction d'archive, quotas contournables par hardlink, évasion de conteneur. Wings a rencontré ces défauts et les a corrigés sur une décennie d'exploitation. Un daemon neuf les rencontrerait tous à nouveau, et ce sont précisément ceux qui mènent à une compromission de l'hôte.

S'y ajoute un argument de valeur : personne ne choisit un hébergeur pour son superviseur de conteneurs. Réécrire le daemon coûterait le plus cher et ne différencierait rien.

| Ce qui est réécrit | Ce qui reste amont |
|---|---|
| Interface, expérience, design system | Isolation Docker, limites cgroup, réseaux |
| API client et application, RBAC, identité, SSO | Serveur SFTP |
| Marketplace, planification, notifications | Collecte des statistiques, console, sauvegardes |
| Catalogue d'eggs et son import | Exécution des scripts d'installation |

**Ce que cela impose** — à traiter comme une contrainte, pas comme un détail :

- Le panel doit servir les endpoints que Wings appelle (`/api/remote/servers/:uuid`, `/api/remote/servers/:uuid/install`, authentification SFTP, sauvegardes). Notre modèle de données doit s'y projeter sans le déformer, voir §7.5.
- Wings authentifie le panel par un **jeton statique**, pas par mTLS. Le modèle de confiance réel est décrit en §5.5.
- L'authentification SFTP est déléguée au panel : un défaut de *notre* authentification devient un accès aux fichiers. Notre code d'auth est donc du code critique au même titre que le daemon.
- Toute dérive du contrat par confort casse à la prochaine version de Wings. Les machines de jeu suivent la dernière version publiée : les bancs de `infra/local` se rejouent à chaque nouvelle version, et une dérive se corrige côté panel (§12.4, décision 6).

**Risque assumé** : cela crée une dépendance à la maintenance de Wings en amont, dont le rythme s'est ralenti. Si le projet devenait non maintenu, le repli serait de reprendre le fork communautaire actif plutôt que de réécrire — à réévaluer chaque année.

### 4.4 Infra & outillage

- **Monorepo pnpm + Turborepo** (TS uniquement : aucun daemon à compiler ici).
- **Docker Compose** pour le dev, **Compose HA** (ou k3s + Helm) pour la prod du panel. Les nodes de jeu restent des hôtes Docker bruts pilotés par Wings. En dev, un Wings réel tourne dans le compose : notre couche de compatibilité ne doit jamais être validée contre un simulacre.
- **Traefik v3** + Cloudflare (Anti-DDoS, WAF).
- **GitHub Actions** : lint, typecheck, tests, build images, scan Trivy, déploiement.
- **Sentry** (front + API), **Grafana/Prometheus/Loki**.
- **Biome** (lint + format), **Vitest**, **Playwright**, **k6** (charge).

> **Livré en V1** : une seule machine, l'API et l'interface sous systemd derrière nginx, PostgreSQL sur la même machine (`infra/prod`). Compose HA, Traefik et le chart Helm décrivent la cible, pas l'existant (§12.4, décision 2).

---

## 5. Sécurité

### 5.1 Authentification

| Mesure | Détail |
|---|---|
| Mots de passe | Argon2id, politique 12+ caractères, vérification HaveIBeenPwned (k-anonymity). |
| 2FA | TOTP + **passkeys WebAuthn** (Face ID, YubiKey). Obligatoire pour admins et revendeurs. Codes de secours. |
| Sessions | Cookies `HttpOnly; Secure; SameSite=Lax`, session opaque en Redis (révocable), rotation à chaque élévation de privilège. **Trente minutes d'inactivité, douze heures au plus** (ASVS 3.3.2 niveau 2, `session.repository.ts`) ; le cookie meurt avec la session. |
| Annuaire externe (OIDC) | Un fournisseur OIDC configurable (Authentik, Keycloak, Azure, Google…), pensé pour l'équipe et les sous-utilisateurs (Administration › Paramètres › Annuaire externe). Actif, il devient le **seul** chemin : l'API refuse alors la connexion par mot de passe. Code avec PKCE, `state` vérifié par la couche web. À la première connexion, rapprochement avec un compte existant **seulement** si le fournisseur déclare l'adresse vérifiée ; sinon, création (`sso.service.ts`). Le bouton « Se connecter avec Google », facultatif et ouvert à tous, est une autre porte (§12.4, décision 4). |
| Se connecter avec Google | Bouton facultatif au-dessus du formulaire (Administration › Paramètres › Connexion avec Google : identifiant et secret d'un client OAuth « Application Web », retour sur `/auth/google/callback`). Même cérémonie et même rapprochement que l'annuaire, liaison `google` : un compte est reconnu par son identifiant Google, sinon par une adresse **vérifiée par Google** ; il n'est créé que si les inscriptions sont ouvertes. Le mot de passe reste possible, et le second facteur du panel s'applique. Absent quand l'annuaire est obligatoire. |
| **Entrée depuis le site client** | Le client n'a pas de mot de passe sur le panel : son compte vit chez le système de facturation, qui le crée à la commande (`POST /application/users`). Derrière son bouton « Gérer mon serveur », le plugin demande `POST /application/users/sso-link` (clé applicative, portée `users.sso`) et redirige vers le lien rendu : **deux minutes, un seul usage**, seulement pour un compte existant, jamais pour un compte du personnel. Le panel n'est **pas** un serveur OAuth (ni `/authorize`, ni écran de consentement) : le facturier détient déjà des clés qui créent et suppriment des serveurs, et lui demander en plus le consentement du client serait une cérémonie sans contenu (`billing-sso.service.ts`). |
| Captcha | Cloudflare Turnstile sur connexion, inscription et réinitialisation (comme sur la capture). |
| Clés API | Préfixées (`gd_live_…`), hashées (SHA-256) en base, scopes, IP allowlist, expiration, dernière utilisation. |
| Tokens WebSocket | JWT 5 min, scope + serveur, signé EdDSA, jamais réutilisable. |
| Anti-bruteforce | Rate-limit par IP et par compte (Redis), délai progressif, alerte email à la 5ᵉ tentative. |
| Alertes | Email + notification lors d'une connexion depuis un nouvel appareil ou pays. |

### 5.2 Autorisation

- **RBAC global** : `admin`, `support`, `reseller`, `user`.
- **Permissions par serveur** (liste stockée en JSON) : `console.read`, `console.send`, `power.*`, `files.read/write/delete/sftp`, `backups.*`, `databases.*`, `subusers.*`, `schedules.*`, `settings.*`, `allocations.*`, `startup.*`, `activity.read`.
- **Rôles serveur prédéfinis** (Viewer, Moderator, Developer, Owner) = presets de permissions, modifiables.
- Vérification par **guard NestJS unique** `@RequireServerPermission('files.write')`. Jamais de check ad hoc dans les services.
- **Ownership check** systématique : un utilisateur ne voit que ses serveurs ou ceux où il est sous-utilisateur.

### 5.3 Isolation des conteneurs (assurée par Wings)

Cette couche n'est pas de notre ressort : elle est fournie par le daemon amont (§4.3). Ce qui suit décrit donc ce que nous **vérifions et configurons**, non ce que nous implémentons. Les mesures dépendantes de la configuration de l'hôte (quotas, réseau, pare-feu, registry) sont appliquées par le rôle Ansible de provisionnement d'un node.

- Utilisateur non-root dans le conteneur (`uid 988`), `no-new-privileges`, capabilities `drop ALL`.
- Limites cgroup v2 : CPU, mémoire (+ swap contrôlé), PIDs, IO.
- Réseau : bridge dédié par serveur (ou par tenant), pas d'accès au réseau hôte, egress filtrable (blocklist d'IP internes).
- Volumes : un dossier par serveur, quota disque (project quota XFS/ext4).
- Images : registry privé, scan Trivy, signature cosign.
- Ports : seuls les ports d'allocation sont publiés. Jamais de `--privileged`.
- Filtrage des noms de fichiers (path traversal), limite de taille d'upload, blocage des symlinks sortant du volume — **traité par Wings**, et c'est précisément la raison pour laquelle on ne le réécrit pas.

### 5.4 Application

- **Headers** : CSP stricte (nonce), HSTS, COOP/COEP, Permissions-Policy.
- **CSRF** : pas de jeton anti-CSRF, et c'est un choix. Le cookie de session est `SameSite=Lax` ; le navigateur ne parle qu'à Next, dont les actions serveur refusent une requête dont l'`Origin` n'est pas l'hôte ; les relais qui n'en sont pas (console, envoi par morceaux) font le même contrôle ; et l'API, en défense en profondeur, refuse toute écriture authentifiée par cookie que le navigateur dit venue d'un autre site (`Origin`/`Sec-Fetch-Site`, transmis par Next en `x-gd-origin`/`x-gd-fetch-site` ; règle unique dans `packages/contracts/src/browser-provenance.ts`). nginx ne publie pas l'API cliente.
- **Validation** : Zod sur 100 % des entrées, sorties filtrées (pas de fuite de champs).
- **Secrets** : jamais en base en clair (chiffrement AES-256-GCM via clé maître / SOPS), rotation.
- **Audit log immuable** : chaque action (qui, quoi, où, IP, UA, avant/après) dans une table append-only + export.
- **Dépendances** : Renovate, `pnpm audit`, SBOM (CycloneDX) par release.
- **Backups DB** : PITR PostgreSQL (WAL) + snapshot quotidien chiffré hors site.
- **Tests sécurité** : ZAP baseline en CI ; revue OWASP ASVS niveau 2 faite et corrigée pour la V1 ([rapport](docs/securite/rapport-asvs-l2.md), §0 pour l'état de chaque point ; [modèle de menace](docs/securite/modele-de-menace.md)). Pentest externe : non fait, recommandé avant une ouverture au public.

### 5.5 Modèle de confiance panel ↔ Wings

Wings n'accepte pas le mTLS : il authentifie le panel par un **jeton statique** inscrit dans son `config.yml`, et ce jeton confère un pouvoir total sur le node. C'est le plafond de sécurité de cette liaison, et le plan ne doit pas promettre mieux : une garantie annoncée mais non tenue est plus dangereuse qu'une contrainte assumée, parce qu'on cesse de compenser.

Compensations, puisque le mécanisme lui-même n'est pas renforçable sans modifier Wings :

| Mesure | Détail |
|---|---|
| Un jeton par node | Une fuite compromet un node, pas la flotte. Jamais de jeton partagé. |
| Rotation | Rotation planifiée et rotation immédiate sur incident, depuis `/admin/nodes`. |
| Lecture du jeton | Le jeton n'est **pas** « affiché une fois » : il est rendu à la création, puis reste lisible dans le `config.yml` que l'administration télécharge pour configurer ou réparer une machine (`GET /admin/nodes/:id/configuration`). Cette lecture est réservée à l'écriture admin (`AdminWriteGuard`, jamais le support ni une clé d'API) et consignée au journal avec l'acteur (`node.configuration_read`), de même que le fichier rendu quand une modification de liaison échoue. C'est le prix d'un node qu'on configure ou répare en un geste, sans rotation ; une fuite se traite par la rotation ([runbook](./docs/runbooks/rotation-jeton-node.md)). |
| Réseau d'administration isolé | L'API de Wings n'est jamais exposée publiquement : VPN ou VLAN dédié entre le panel et les nodes, filtrage au pare-feu sur l'IP du panel. |
| Chiffrement au repos | Les jetons de node sont chiffrés en base (AES-256-GCM, clé maître), comme tout secret (§5.4). |
| Journalisation | Tout appel du panel vers un node est tracé dans l'audit log avec l'acteur à l'origine. |
| Jetons éphémères | Les jetons WebSocket et de transfert de fichiers suivent la sémantique attendue par Wings : portée par serveur, expiration courte, non rejouables. Une erreur de portée ici est une vulnérabilité, pas un défaut d'interface — couverte par des tests dédiés. |

**Authentification SFTP.** Wings la délègue au panel. Ce chemin d'appel est donc traité comme du code d'isolation : rate-limit propre, refus par défaut, vérification d'appartenance et de permission `files.sftp` à chaque requête, aucune mise en cache d'une réponse positive au-delà de 60 s.

---

## 6. Modèle de données (PostgreSQL)

Notation : `table (colonnes clés)`. Toutes les tables ont `id uuid`, `created_at`, `updated_at`.

### 6.1 Identité & accès
- `users` (email, password_hash, name_first, name_last, locale, timezone, role, is_2fa_enabled, external_id nullable, avatar_url, last_login_at)
- `user_oauth_accounts` (user_id, provider: google|discord, provider_user_id, email, linked_at)
- `user_credentials_totp` (user_id, secret_enc, verified_at)
- `user_passkeys` (user_id, credential_id, public_key, counter, transports, label)
- `user_recovery_codes` (user_id, code_hash, used_at)
- `sessions` (id, user_id, ip, user_agent, device_label, expires_at, revoked_at)
- `api_keys` (user_id, prefix, key_hash, scopes[], allowed_ips[], expires_at, last_used_at)
- `ssh_keys` (user_id, name, public_key, fingerprint)
- `login_attempts` (email, ip, success, at)

### 6.2 Infrastructure
- `locations` (short, long, country_code)
- `nodes` (name, location_id, fqdn, scheme, daemon_port, daemon_sftp_port, memory_mb, memory_overallocate, disk_mb, disk_overallocate, cpu_cores, public, maintenance_mode, daemon_token_id, daemon_token_enc, daemon_token_rotated_at, wings_version, last_heartbeat_at)
- `allocations` (node_id, ip, ip_alias, port, server_id nullable, notes). Unique (node_id, ip, port)
- `node_metrics` (node_id, at, cpu_pct, mem_used, disk_used, net_rx, net_tx). Partition par jour

### 6.3 Catalogue
- `nests` (name, description). Familles de jeux
- `eggs` (nest_id, name, description, docker_images jsonb, startup, config_files jsonb, config_startup jsonb, config_stop, install_script, install_container, install_entrypoint, features[], file_denylist[], source, source_ref, imported_at)
- `egg_variables` (egg_id, name, env_variable, description, default_value, user_viewable, user_editable, rules)
- `egg_sources` (name, type: git|url|manual, url, branch, path_glob, auto_sync, last_synced_at). Dépôts d'eggs suivis
- `marketplace_sources` (type: modrinth|curseforge|spigot|custom, config)
- `marketplace_installs` (server_id, source, project_id, version_id, installed_files[], installed_at)

### 6.4 Serveurs
- `servers` (uuid_short, name, description, owner_id, node_id, egg_id, allocation_id, docker_image, startup, environment jsonb, memory_mb, swap_mb, disk_mb, io_weight, cpu_pct, threads, oom_killer, status: installing|install_failed|suspended|restoring|null, suspended_reason, external_id nullable, backup_limit, database_limit, allocation_limit, installed_at)
- `server_subusers` (server_id, user_id, role_preset, permissions[], invited_by, accepted_at)
- `server_invites` (server_id, email, token_hash, permissions[], expires_at)
- `server_transfers` (server_id, from_node_id, to_node_id, status, progress, archived_at)
- `server_variables` (server_id, egg_variable_id, value)
- `server_metrics` (server_id, at, state, cpu_pct, mem_bytes, disk_bytes, net_rx, net_tx, players). Partition par jour, rétention 30 j, agrégats 5 min / 1 h
- `server_health` (server_id, at, reachable, query_payload jsonb). Résultat des sondes de jeu

### 6.5 Fonctionnalités serveur
- `backups` (server_id, name, uuid, ignored_files[], disk: local|s3, checksum, bytes, is_successful, is_locked, completed_at, expires_at)
- `backup_schedules` (server_id, cron, retention_count, ignored_files[])
- `databases` (server_id, database_host_id, name, username, password_enc, remote, max_connections)
- `database_hosts` (name, host, port, username, password_enc, node_id nullable, max_databases)
- `schedules` (server_id, name, cron_minute/hour/dom/month/dow, is_active, only_when_online, last_run_at, next_run_at)
- `schedule_tasks` (schedule_id, sequence, action: command|power|backup|restart_if_crashed|webhook, payload, time_offset, continue_on_failure)
- `mounts` (source, target, read_only, user_mountable) + `egg_mounts`, `node_mounts`, `server_mounts`
- `firewall_rules` (server_id, direction, protocol, port_range, cidr, action). v2

### 6.6 Transverse
- `activity_logs` (actor_id, actor_type: user|api_key|system, server_id nullable, event, ip, user_agent, properties jsonb, at). Append-only
- `notifications` (user_id, type, title, body, data jsonb, read_at, channel: inapp|email|discord)
- `notification_preferences` (user_id, event, channels[])
- `webhooks` (owner_id, server_id nullable, url, secret_enc, events[], is_active) + `webhook_deliveries`
- `announcements` (title, body_md, level, starts_at, ends_at, audience)
- `incidents` (title, status, impact, node_ids[], updates jsonb)
- `settings` (key, value jsonb). Marque blanche, SMTP, S3, captcha, etc.
- `feature_flags` (key, enabled, rollout_pct, audience)

---

## 7. API

### 7.1 Conventions

**Domaine.** L'API est servie par le domaine du panel (`game.gamedashboard.fr`), sous le préfixe `/api`. Pas de sous-domaine séparé.

Conséquences concrètes :
- Le frontend et l'API partagent la même origine : l'interface s'authentifie par son cookie de session, aucun jeton ne transite par le JavaScript et il n'y a pas de préflight CORS sur les appels du panel. En pratique, le navigateur ne joint même pas l'API cliente : il parle à Next (actions serveur, deux relais), qui appelle l'API depuis la machine, et nginx ne publie que l'API applicative, `/api/remote`, la spécification et le statut.
- Puisqu'un cookie suffit alors à authentifier, **toute requête mutante par cookie est contrôlée sur son origine**, sans jeton en double soumission : `SameSite=Lax`, contrôle d'origine des actions serveur de Next et des deux relais, puis `SessionGuard`, qui refuse une écriture par cookie que le navigateur dit venue d'un autre site (§5.4). Une clé `Bearer` n'est pas concernée : aucun navigateur ne la joint de lui-même.
- CORS n'est ouvert qu'à l'origine du panel (`PANEL_ORIGIN`). Les systèmes tiers appellent l'API applicative de serveur à serveur, avec une clé : ils n'en ont pas besoin.

**Routage Traefik.** Le préfixe `/api/` va au service API ; le chemin exact `/api` reste servi par Next et rend la page de documentation. Deux règles, la plus spécifique l'emportant :

```
Path(`/api`)          → web    (page de documentation)
PathPrefix(`/api/`)   → api    (service NestJS)
PathPrefix(`/ws`)     → realtime (gateway websocket)
```

- Base : `/api/v1/client/*` (client authentifié), `/api/v1/application/*` (admin / clé application, ex. un système de facturation externe), `/api/remote/*` (Wings vers core, jeton de node — préfixe sans version, imposé par le daemon).
- Schéma OpenAPI : `/api/openapi.json`. Websocket : `wss://game.gamedashboard.fr/ws`.
- Réponses `{ data, meta, links }`, erreurs RFC 9457 (Problem Details).
- Pagination par curseur, filtres `?filter[status]=`, tri `?sort=-created_at`, includes `?include=node,allocations`.
- Idempotence : header `Idempotency-Key` sur les POST sensibles (création serveur, backup).
- Versionnement par préfixe d'URL, dépréciation annoncée via header `Sunset`.
- OpenAPI 3.1 générée, puis SDK TS (`@gamedashboard/sdk`) + doc Scalar.

### 7.2 Endpoints client (extrait)

```
Auth
  POST   /auth/login                      POST /auth/logout
  POST   /auth/2fa/totp/verify            POST /auth/passkey/options|verify
  GET    /auth/sso                        POST /auth/sso/start|callback    (annuaire OIDC)
  GET    /auth/google                     POST /auth/google/start|callback (bouton Google)
  POST   /auth/register                   POST /auth/password/forgot|reset

Compte
  GET/PATCH /account                      GET/DELETE /account/sessions
  GET/POST/DELETE /account/api-keys       GET/POST/DELETE /account/ssh-keys
  POST   /account/2fa/totp/enable|disable POST /account/passkeys/register
  GET/PATCH /account/notifications/preferences

Serveurs
  GET    /servers?filter[type]=owner|admin|subuser
  GET    /servers/:id                     GET /servers/:id/resources
  POST   /servers/:id/power  {signal: start|stop|restart|kill}
  POST   /servers/:id/command {command}
  POST   /servers/:id/ws-token
  GET    /servers/:id/metrics?range=1h|24h|7d|30d&step=…
  GET    /servers/:id/activity

Fichiers
  GET    /servers/:id/files/list?directory=
  GET    /servers/:id/files/contents?file=
  PUT    /servers/:id/files/write?file=    (corps brut)
  POST   /servers/:id/files/rename|copy|delete|compress|decompress|create-folder|chmod
  POST   /servers/:id/files/upload        (tus resumable)
  GET    /servers/:id/files/download?file= (URL signée vers le daemon)
  POST   /servers/:id/files/pull {url}    (téléchargement distant, job)

Backups / DB / Schedules / Subusers / Allocations / Startup / Settings
  CRUD standard + actions (restore, lock, rotate-password, execute-now, reinstall, rename)

Marketplace
  GET    /servers/:id/marketplace/search?source=modrinth&q=
  POST   /servers/:id/marketplace/install {source, project, version}

Application (clé application, pour l'admin et les systèmes externes)
  GET/POST/PATCH/DELETE /application/servers   POST /application/servers/:id/suspend|unsuspend|reinstall
  GET/POST/PATCH/DELETE /application/users     GET/POST /application/nodes|allocations|eggs
  POST   /application/users/sso-link   (entrée du client : lien à usage unique, §5.1)
```

### 7.3 Temps réel (Socket.IO)

Namespaces : `/servers` (client), `/admin` (nodes, incidents).
Rooms : `server:{id}`, `user:{id}`, `node:{id}`.

Événements serveur vers client :
`status` (state), `console.output` (batch de lignes, 50 ms), `stats` (1 s), `install.output`, `install.completed`, `backup.progress`, `backup.completed`, `transfer.progress`, `daemon.error`, `players` (liste), `notification`.

Client vers serveur : `console.send`, `power`, `console.history` (n lignes).

Toujours vérifié : le token WS porte les scopes. `console.send` est refusé sans la permission `console.send`.

### 7.4 Contrat Core → Wings (le panel est client)

Wings expose une API HTTP et un flux WebSocket. Le contrat est celui d'amont : il se respecte, il ne se négocie pas.

| Appel | Usage |
|---|---|
| `POST /api/servers` | Création du serveur et lancement de l'installation |
| `DELETE /api/servers/:uuid` | Suppression, volume compris |
| `POST /api/servers/:uuid/power` | `start`, `stop`, `restart`, `kill` |
| `POST /api/servers/:uuid/commands` | Envoi de commandes console |
| `GET /api/servers/:uuid` | État, statistiques, utilisation disque |
| `/api/servers/:uuid/files/*` | Liste, lecture, écriture, renommage, archive, extraction |
| `POST /api/servers/:uuid/backup` | Création de sauvegarde |
| `POST /api/servers/:uuid/ws/deny` | Révocation des jetons WebSocket émis |
| `GET /api/servers/:uuid/ws` | Console et statistiques en direct |

Authentification : en-tête `Authorization: Bearer <jeton du node>` (§5.5).

### 7.5 Contrat Wings → Core (le panel est serveur)

Le sens inverse est le plus contraignant : **Wings appelle notre panel**, et attend des réponses à la forme Pterodactyl. Ces endpoints ne sont pas un choix de conception, ce sont des obligations.

Relevé **dans la source du daemon** (`remote/servers.go`, `remote/types.go`) et non dans la documentation, qui décrit l'intention plutôt que le comportement. Version de référence : `pterodactyl/wings@d611682` (14/08/2026). Transcrit en schémas Zod dans `@gamedashboard/contracts` (`wings.ts`), avec ses tests.

| Endpoint à servir | Attendu par Wings pour |
|---|---|
| `GET /api/remote/servers` | Inventaire paginé (`?page=&per_page=`), réponse `{ data, meta }` |
| `POST /api/remote/servers/reset` | Remise à zéro des états au démarrage du daemon |
| `GET /api/remote/servers/:uuid` | Configuration : `settings` + `process_configuration` |
| `GET /api/remote/servers/:uuid/install` | `container_image`, `entrypoint`, `script` |
| `POST /api/remote/servers/:uuid/install` | Compte rendu : `successful`, `reinstall` |
| `POST /api/remote/servers/:uuid/archive` | Résultat d'archivage lors d'un transfert |
| `POST /api/remote/servers/:uuid/transfer/:state` | Progression du transfert |
| `POST /api/remote/sftp/auth` | Authentification SFTP → `server`, `user`, `permissions[]` |
| `GET /api/remote/backups/:uuid?size=` | Jetons d'envoi S3 multipart |
| `POST /api/remote/backups/:uuid` | Compte rendu : somme de contrôle, taille, parties |
| `POST /api/remote/backups/:uuid/restore` | Compte rendu de restauration |
| `POST /api/remote/activity` | Journal d'activité remonté par le daemon |

**Trois pièges relevés à la lecture**, qu'une reconstitution de mémoire manquait :

1. Le jeton présenté est en **deux parties** : `Authorization: Bearer <identifiant>.<secret>`. D'où les trois colonnes de `nodes` (§5.5) — l'identifiant permet de retrouver la ligne en une lecture indexée au lieu de comparer chaque condensat de la flotte à chaque requête. Le découpage se fait au **premier** point : un secret en contenant un serait sinon tronqué.
2. Les sauvegardes vivent sous `/backups/:uuid`, **pas** sous `/servers/:uuid/backups`.
3. `POST /servers/reset` et `POST /activity` existent et sont faciles à oublier ; leur absence ne se voit qu'à l'usage.

**Comportements imposés.** Wings ne réessaie pas sur un 4xx et réessaie avec temporisation exponentielle sur tout le reste : répondre 500 à une condition définitive — un serveur supprimé — déclenche une boucle de tentatives. Il refuse aussi toute réponse hors 2xx, redirections comprises : un intergiciel d'authentification appliqué par erreur aux routes `remote` renverrait une 302 vers `/login`, que le daemon traite comme une panne.

Ces routes sont isolées dans un module `remote` dédié, avec son propre guard (jeton de node, pas session utilisateur), ses propres schémas Zod figés sur le format Pterodactyl, et des tests de contrat exécutés contre un **Wings réel** en CI. Le format y prime sur nos préférences internes : la traduction entre notre modèle et le leur se fait dans ce module, nulle part ailleurs.

---

## 8. Intégration Wings

### 8.1 Couche de compatibilité (`apps/api/src/modules/remote` + `wings-client`)

Rien n'est à écrire côté node : Wings est installé tel quel. Le travail est entièrement côté panel, réparti en deux modules symétriques.

```
apps/api/src/modules/
  wings-client/    Client HTTP typé vers Wings (§7.4)
    client.ts        appels, jeton de node, timeouts, retry idempotent
    console.ts       abonnement WebSocket, relais vers le gateway
    tokens.ts        émission des jetons éphémères à la sémantique Wings
    errors.ts        traduction des erreurs Wings en Problem Details
  remote/          Endpoints servis à Wings (§7.5)
    guard.ts         authentification par jeton de node, jamais de session
    schemas.ts       schémas Zod figés sur le format Pterodactyl
    mapper.ts        seul endroit où notre modèle est traduit vers le leur
    sftp.ts          authentification SFTP (traitée comme du code d'isolation, §5.5)
```

**Version épinglée.** La version de Wings supportée est déclarée dans la configuration du panel et vérifiée au premier contact avec un node. Un node en version inattendue est signalé dans `/admin/nodes` plutôt que piloté à l'aveugle.

### 8.2 États du serveur

Les états viennent de Wings (`offline`, `starting`, `running`, `stopping`) et sont relayés tels quels : le panel ne tient pas une machine à états concurrente, qui finirait par diverger de la réalité du conteneur.

Le panel ajoute en revanche ses propres états, qui relèvent de la gestion et non du conteneur : `installing`, `restoring`, `transferring`, `suspended`. Ils sont stockés en base et priment à l'affichage sur l'état rapporté par le daemon.

**Détection de boucle de crash** : côté panel, à partir des événements reçus. Plus de 3 arrêts non nuls en 5 minutes marque le serveur en `crash_loop`, notifie le client et désactive le redémarrage automatique jusqu'à une action manuelle.

**Sondes de jeu** (nombre de joueurs, ping Minecraft, A2S Source) : Wings ne les fournit pas. Elles sont exécutées par le worker, depuis le réseau d'administration.

### 8.3 Compatibilité Pterodactyl et sources d'eggs

**Sources officielles à importer** (décidé le 15/09/2026) :

| Source | Nature | Usage |
|---|---|---|
| `https://github.com/pterodactyl/game-eggs` | Dépôt Git officiel des eggs communautaires, un JSON par jeu, rangé par famille | Source principale du catalogue. Synchronisation périodique par le worker, avec suivi du commit importé. |
| `https://eggs.pterodactyl.io/` | Index consultable des eggs | Découverte et vérification. Les fichiers eux-mêmes viennent du dépôt Git. |

**Mécanique d'import** :
1. Le worker clone (ou met à jour) le dépôt dans un cache local, à un commit épinglé.
2. Chaque JSON est validé par un schéma Zod dérivé du format egg v2. Un fichier invalide est signalé, pas importé silencieusement.
3. La famille (nest) est déduite de l'arborescence du dépôt. Les eggs sont rattachés ou créés en conséquence.
4. Un egg déjà importé est mis à jour, sauf s'il a été modifié localement : dans ce cas l'admin voit un écart et choisit d'écraser ou de conserver.
5. Les images Docker référencées sont remplaçables par nos propres images (registry privé, scannées), via une table de correspondance.
6. L'import manuel d'un JSON reste possible depuis `/admin/eggs`, et l'export produit un JSON compatible Pterodactyl.

**Sécurité** : le script d'installation d'un egg tiers s'exécute dans un conteneur éphémère isolé, sans accès au réseau interne ni aux volumes des autres serveurs (voir §5.3). Les eggs importés ne sont pas exposés aux clients tant qu'un administrateur ne les a pas activés.

- Import des eggs JSON (v2) tel quel : variables, `config_files` (parsing properties/yaml/json/ini), détection de démarrage, images. Le format n'est pas seulement importé, il est **servi** à Wings par `/api/remote/servers/:uuid` : notre stockage doit pouvoir le restituer sans perte.
- Les volumes ne bougent pas (`/var/lib/pterodactyl/volumes/<uuid>`) : le daemon étant inchangé, il n'y a aucune donnée à déplacer.
- Script de migration : lit la base Pterodactyl et crée users, nodes, servers, allocations dans le nouveau schéma. **Les UUID de serveur sont conservés**, sans quoi Wings ne retrouverait plus les volumes existants.
- Bascule possible node par node, le panel Pterodactyl restant en place pour les nodes non migrés — un même Wings ne répondant toutefois qu'à un seul panel à la fois.

---

## 9. Design system & composants réutilisables

### 9.1 Tokens (`packages/ui/tokens.css`)

```css
:root {
  --gd-accent-500: #7c3aed; --gd-accent-400: #8b5cf6; --gd-accent-600: #6d28d9;
  --gd-bg: #f5f6fa;  --gd-surface: #ffffff; --gd-surface-2: #f1f2f6;
  --gd-border: #e5e7eb; --gd-text: #111827; --gd-text-muted: #6b7280;
  --gd-success: #22c55e; --gd-warning: #f59e0b; --gd-danger: #ef4444; --gd-info: #3b82f6;
  --gd-radius: 12px; --gd-radius-sm: 8px;
  --gd-font-sans: "Inter", system-ui, sans-serif; --gd-font-mono: "JetBrains Mono", monospace;
  --gd-density: 1;   /* 0.85 compact, 1 normal, 1.15 confortable */
}
[data-theme="dark"] {
  --gd-bg: #0f1117; --gd-surface: #161922; --gd-surface-2: #1e2230;
  --gd-border: #262a37; --gd-text: #f3f4f6; --gd-text-muted: #9ca3af;
}
```
Marque blanche : un revendeur peut surcharger `--gd-accent-*`, logo, nom, favicon depuis l'admin (stocké dans `settings`), injecté côté serveur.

### 9.2 Hiérarchie des composants (`packages/ui`)

**Atomes** (aucune dépendance métier)
`Button` (variants : primary/secondary/ghost/danger/outline, sizes, loading, icon), `IconButton`, `Badge`, `StatusDot`, `Avatar`, `Input`, `Textarea`, `Select`, `Combobox`, `Checkbox`, `Switch`, `RadioGroup`, `Slider`, `Tooltip`, `Kbd`, `Spinner`, `Skeleton`, `Progress`, `Separator`, `Tag`, `CopyButton`, `Code`.

**Molécules**
`Card` (header/body/footer), `FormField` (label, description, erreur, piloté par react-hook-form), `SearchInput`, `StatTile` (label, valeur, delta, sparkline), `MetricBar` (barre + valeur/max, ex. RAM 2.1/4 GB), `Tabs`, `Dropdown`, `ContextMenu`, `Dialog`, `Drawer`, `AlertBanner` (le bandeau lavande de la capture), `EmptyState`, `Pagination`, `Breadcrumbs`, `PageHeader` (icône, titre, sous-titre, actions, breadcrumbs, celui de toutes les captures), `ConfirmDialog` (avec saisie du nom pour les actions destructives), `Toast`.

**Organismes** (génériques, paramétrés par props/colonnes)
- `DataTable<T>` : colonnes déclaratives, tri, filtres, sélection multiple, actions par ligne, virtualisation, états loading/empty/error, export CSV. Utilisée par : fichiers, backups, databases, subusers, allocations, schedules, audit, admin users/nodes/servers.
- `AppShell` : header + sidebar + contenu, responsive (drawer mobile), sections de nav déclaratives (`NavSection[]`).
- `Sidebar` / `NavItem` : rendus depuis une config JSON (icône, label, href, badge, permission requise). Une seule implémentation pour les 3 sidebars observées.
- `CommandPalette` (`Ctrl+K`) : navigation, changement de serveur, actions.
- `Chart` (line/area/bar) avec `TimeRangePicker` (1m, 5m, 1h, 24h, 7d, 30d).
- `Terminal` (xterm) : props `lines`, `onSend`, filtres, recherche, autocomplete.
- `FileBrowser` : `DataTable` + drag-drop + fil d'Ariane + upload tus + menu contextuel.
- `CodeEditor` (Monaco) : langage auto, diff, sauvegarde `Ctrl+S`.
- `CronBuilder` : UI visuelle + expression brute.
- `PermissionMatrix` : groupes × permissions, presets.
- `ResourceForm` : CPU/RAM/disque/swap/IO avec validation contre le node.
- `NotificationCenter`, `ActivityFeed`, `StatusBar` (barre d'état serveur persistante).
- `Wizard` (multi-étapes) : création serveur, onboarding.

**Templates**
`ListPageTemplate` (header + filtres + DataTable), `DetailPageTemplate` (header + tabs), `SettingsPageTemplate` (sections en cartes), `AuthPageTemplate`.

### 9.3 Règles d'implémentation

1. Un composant n'importe jamais TanStack Query ni le SDK : il reçoit des données et des callbacks. Les **hooks métier** (`useServer`, `useServerFiles`, `useBackups`…) vivent dans `packages/features/*` et branchent SDK + temps réel.
2. Une page = `Template` + hooks + organismes. Objectif : moins de 80 lignes par page.
3. Chaque composant a : story Storybook, test Vitest (rendu + interactions), variantes documentées, support clavier + ARIA.
4. Props typées, `forwardRef`, `className` mergée via `cn()`, pas de style inline.
5. Icônes : `lucide-react` uniquement.
6. Toutes les chaînes via `next-intl`. Aucune chaîne en dur.
7. Loading = `Skeleton` de même géométrie que le contenu final (pas de spinner de page).

### 9.4 Pages et écrans (client)

| Route | Contenu |
|---|---|
| `/` | Dashboard : StatTiles (serveurs en ligne, joueurs, alertes, backups récents), liste serveurs (cartes ou table), annonces, incidents, activité récente |
| `/servers` | Liste avec recherche, filtres (état, jeu, node), favoris, vues carte/table |
| `/servers/new` | Wizard (si autorisé) : jeu, plan, location, options |
| `/server/[id]` | Console (xterm) + graphes CPU/RAM/réseau/disque + actions power + joueurs |
| `/server/[id]/files` | FileBrowser. `/files/edit?path=` ouvre CodeEditor |
| `/server/[id]/databases` | DataTable + création + rotation mot de passe |
| `/server/[id]/backups` | DataTable, progression live, planification, restauration (complète ou par fichiers) |
| `/server/[id]/schedules` | Liste + CronBuilder + tâches |
| `/server/[id]/users` | Sous-utilisateurs, invitations, PermissionMatrix |
| `/server/[id]/network` | Allocations, port principal (v2 : firewall) |
| `/server/[id]/startup` | Variables d'egg, image Docker, commande |
| `/server/[id]/settings` | Nom, description, SFTP, réinstaller, transférer, zone danger |
| `/server/[id]/marketplace` | Recherche plugins/mods, installés, mises à jour |
| `/server/[id]/activity` | Audit du serveur |
| `/server/[id]/health` | Sondes, historique de disponibilité, alertes |
| `/account` | Profil, langue, thème, densité |
| `/account/security` | Mot de passe, 2FA, passkeys, sessions, historique de connexion |
| `/account/api-keys`, `/account/ssh-keys` | Gestion des clés |
| `/account/notifications` | Préférences par événement et canal |
| `/login`, `/register`, `/forgot-password`, `/2fa` | Pages d'auth sur le pattern `AuthCard` de la capture (Google, e-mail, Turnstile) |
| `/status` | Statut des nodes + incidents |

### 9.5 Pages admin

`/admin` (KPIs, santé des nodes), `/admin/nodes` (allocations, métriques, `config.yml` Wings téléchargeable, rotation du jeton, version du daemon, maintenance), `/admin/locations`, `/admin/servers` (création, suspension, transfert, réinstall), `/admin/users` (impersonation auditée), `/admin/nests` et `/admin/eggs` (éditeur avec import/export JSON), `/admin/mounts`, `/admin/database-hosts`, `/admin/announcements`, `/admin/incidents`, `/admin/webhooks`, `/admin/settings` (branding, SMTP, S3, captcha, OAuth, feature flags), `/admin/audit`.

---

## 10. Fonctionnalités par module

### 10.1 Périmètre v1 (parité Pterodactyl + WISP)
- Auth complète (mot de passe, Google OAuth, TOTP, passkeys, Turnstile, sessions, clés API, clés SSH).
- Liste/détail serveurs, console temps réel, power, stats live + historique 30 j.
- Fichiers (navigation, édition Monaco, upload résumable, archive/extract, permissions, téléchargement).
- Backups (manuels + planifiés, local/S3, verrouillage, restauration).
- Bases de données, sous-utilisateurs avec presets, planificateur, allocations, variables de démarrage, réinstallation, transfert entre nodes.
- Notifications in-app + email. Activité et audit.
- Admin complet (nodes, eggs, users, servers, settings, branding).
- API application complète et documentée (create/suspend/unsuspend/terminate/resize, changement de titulaire) pour qu'un système de facturation externe puisse provisionner des serveurs, sans que ce système fasse partie du projet.
- FR/EN, thème clair/sombre/système, responsive mobile, PWA installable.

### 10.2 v1.5

**Livrée en entier** (septembre 2026). Chaque point cite le module où il se lit.

- **Marketplace** (Modrinth, CurseForge, SpigotMC par Spiget) avec gestion de versions et mises à jour — **livré** (`apps/api/src/modules/marketplace`). Choix d'une version précise, y compris antérieure ; liste des extensions installées avec « Tout mettre à jour » ; veille quotidienne des mises à jour (notification `marketplace.update_available`) ; dépendances obligatoires posées avant l'extension, refus avant tout téléchargement si l'une manque. **Modpacks CurseForge** complets sur Minecraft Java (manifeste, mods côté serveur seulement, overrides, datapacks) : installation en tâche de fond suivie en base (`server_engines`, `server_engine_installs`), chargeur Fabric posé par le panel, Forge et NeoForge par l'egg Minecraft Java unifié, que le panel règle puis réinstalle par Wings (écran « Moteur », `GET|POST /servers/{server}/engine…`).
- **Health checks par jeu + page status + alertes Discord/email** — **livré**. Sondes du worker (`apps/api/src/modules/scheduler/game-probe.service.ts`) : Server List Ping de Minecraft, Steam A2S (Rust, ARK, CS, Garry's Mod, 7 Days to Die, Valheim…) et FiveM/RedM, déclarées par la clé d'egg `game_query` ou reconnues à l'egg (`probe-plan.ts`) ; réponses bornées. Trois sondes ratées d'affilée préviennent le propriétaire (panel, e-mail, webhooks), le retour annonce la durée de la coupure ; une adresse Discord reçoit un message mis en forme. Machine perdue ou rétablie : administrateurs et revendeur prévenus, pannes consignées (`node_outages`). Page `/status` : disponibilité sur 90 jours par composant, incidents.
- Console avancée : recherche, filtres, liens, autocomplete, historique persistant — **livré** (`packages/ui/src/components/console*.tsx`, `lib/console-text.ts`). Rendu HTML gardé plutôt que xterm (décision de Matheo : filtrer et chercher reviennent à choisir les lignes rendues, CSP à nonce intacte). Couleurs ANSI en seize classes closes, filtres Tout / Serveur / Système et Erreurs / Avertissements / Infos, recherche littérale surlignée, liens `http(s)` seulement. Autocomplétion tirée des commandes déclarées par l'egg (`eggs.console_commands`, clé `console_commands` ignorée par Pterodactyl, `GET /servers/{server}/commands`) et de l'historique. Historique des commandes **dans le navigateur**, effacé à la déconnexion : l'API ne garde pas les arguments (ASVS NC-13). L'historique de sortie reste celui de Wings (`send logs`).
- **Vue joueurs** (liste, kick/ban via commandes d'egg déclaratives) — **livré**. Page « Joueurs » du serveur : joueurs lus dans la dernière sonde de jeu, actions (expulser, bannir, gracier, liste blanche, opérateurs) tapées dans la console d'après `eggs.player_commands` (repli sur Minecraft). Permissions `players.read` et `players.manage`, op/deop exigent aussi `console.send` ; `GET|POST /servers/{server}/players`.
- **Marque blanche revendeurs** (domaine custom, logo, couleurs, emails) — **livré** (`apps/api/src/modules/reseller`). Domaine propre prouvé par TXT puis servi par nginx avec son certificat (page d'attente neutre avant lui, mises à niveau filtrées comme sur le panel) ; logo et favicon envoyés par fichier (`brand_images` en base, PNG, JPEG, WebP ou ICO, jamais de SVG) ; courriels au nom de la marque avec l'adresse de réponse du revendeur, l'expéditeur SMTP restant celui de la plateforme (SPF, DKIM) ; clés d'accès et cérémonies SSO sur le domaine vérifié du revendeur (`user_passkeys.rp_id`).
- **Facturation WHMCS et ClientXCms**, à côté de HostBill — **livré** (`apps/api/src/modules/billing` : façade `BillingService`, un `BillingProvider` par système, choisi par `billing.provider`, réglages `billing.*` qui reprennent les anciennes clés `hostbill.*`). Même contrat pour les trois : le panel **lit** les services et leurs échéances pour les montrer au client, et n'écrit rien. **La facturation n'est jamais gérée par le panel** : c'est le facturier tiers qui décide et qui pilote le panel par l'API applicative (§10.1). Les écrans parlent de « la facturation reliée », sans nommer un système ; essai de liaison dans les réglages.

### 10.3 v2

- **Sous-domaines automatiques** (`monserveur.gamedashboard.gg` via Cloudflare API, enregistrements SRV) — **livré** (`apps/api/src/modules/dns`, [guide](./docs/sous-domaines.md)). Le client choisit un libellé dans l'écran Réseau ; le panel publie A, AAAA ou CNAME selon l'adresse publique, et un SRV `_minecraft._tcp` pour Minecraft Java, dans la zone réglée par l'administration. Les enregistrements suivent le port principal et le transfert, disparaissent avec le serveur ; un balayage toutes les cinq minutes rattrape les échecs. Seuls les enregistrements posés par le panel sont touchés, un nom que la zone porte déjà est refusé, aucune adresse privée n'est publiée. Fournisseur derrière `DnsProvider`, jeton chiffré lié à sa ligne.
- **Métriques de consommation exportables** (pour un système de facturation externe) — **livré** (`apps/api/src/modules/consumption`). Résumé journalier de `server_metrics` par serveur (`server_consumption_days`, gardé treize mois, recalculé chaque heure). Export CSV ou JSONL depuis l'administration, l'espace revendeur et l'écran d'un serveur ; JSON paginé par l'API applicative (`GET /consumption`, portée `consumption.read`, bornée au parc d'une clé de revendeur). Le panel fournit les chiffres ; ce qu'on en facture reste l'affaire du facturier.
- **Firewall par serveur** (nftables sur le node) — **proposé, sans code** : [ADR 0008](./docs/adr/0008-pare-feu-nftables.md). Un agent facultatif sur chaque node tire du panel les règles de ses serveurs, les valide et les pose dans sa propre table nftables, avant le DNAT de Docker, sans toucher Wings ni les tables de Docker. Rien ne s'écrit avant que Matheo accepte l'ADR et tranche ses questions ouvertes.
- **Snapshots de volumes** (btrfs/zfs) pour backups instantanés — **livré** ([ADR 0009](./docs/adr/0009-instantanes-de-volumes.md), acceptée). Instantanés du système de fichiers entier des serveurs d'un node, pris et restaurés par l'agent de node ; la restauration recopie le seul dossier du serveur arrêté, Wings n'est pas modifié. Panel : `apps/api/src/modules/snapshots` (politique, ordres, restauration, sauvegarde S3 cohérente tirée d'un instantané, migrations `0059`, `0060`) et écran Instantanés du serveur. Les sauvegardes locales et S3 restent la seule copie hors de la machine. Restent les bancs réels sur une machine d'essai : btrfs et ZFS, et une vraie restauration par Wings d'une archive de l'agent.
- **Agent de node** (socle du pare-feu et des instantanés) — **livré** (`agent/`, Go, [README](./agent/README.md)). Facultatif : authentification `token_id.token` comme Wings, `/etc/gamedashboard-agent/config.yml` écrit par `gamedashboard-agent configure`, journal SQLite local, annonce de ses fonctions au battement de cœur. Le panel (`apps/api/src/modules/node-agent`, migration `0058`) en déduit les capacités de chaque node (`nodeCapabilities()`, `packages/contracts/src/node-agent.ts`) et grise, avec la raison, les fonctions qui en dépendent. Il ne l'appelle jamais : l'agent tire ses ordres. Format, vet et tests en CI dans l'image Go épinglée ; CodeQL analyse aussi le Go.
- Module VPS (via Proxmox API) réutilisant le même AppShell et les mêmes composants — à concevoir.
- App mobile React Native partageant `@gamedashboard/contracts` et `@gamedashboard/sdk` — à concevoir.

---

## 11. Structure du monorepo

```
GameDashboard/
├── apps/
│   ├── web/                 Next.js 15 (client + admin)
│   │   ├── app/(auth)/…     app/(client)/…   app/(admin)/…
│   │   ├── middleware.ts    (auth, locale, CSP nonce)
│   │   └── …
│   ├── api/                 NestJS Core
│   │   └── src/modules/
│   │       auth/ users/ servers/ files/ backups/ databases/ schedules/
│   │       subusers/ allocations/ nodes/ eggs/ marketplace/ notifications/
│   │       webhooks/ application/ admin/ audit/ health/
│   │       wings-client/    Appels sortants vers Wings (§7.4)
│   │       remote/          Endpoints servis à Wings (§7.5)
│   ├── realtime/            Gateway Socket.IO
│   └── worker/              Processeurs BullMQ (+ sondes de jeu)
│                            (pas de daemon ici : Wings est un binaire amont)
├── packages/
│   ├── ui/                  Design system (atomes → templates), Storybook
│   ├── features/            Hooks métier + organismes connectés (useServer, FileBrowserConnected…)
│   ├── contracts/           Schémas Zod + types partagés + événements temps réel
│   ├── sdk/                 Client TS généré depuis OpenAPI + wrapper temps réel
│   ├── db/                  Schéma Drizzle, migrations, seeders
│   ├── config/              Presets Biome, TS, Tailwind partagés
│   └── i18n/                Messages FR/EN
├── infra/
│   ├── docker/              Dockerfiles, compose.dev.yml, compose.prod.yml
│   ├── k8s/ (optionnel)     Helm chart du panel
│   ├── ansible/             Provisioning d'un node (Docker, Wings, quotas, firewall)
│   └── grafana/             Dashboards, alertes
├── docs/                    ADRs, guides, API, runbooks
├── .github/workflows/       ci.yml, release.yml, security.yml
├── turbo.json  pnpm-workspace.yaml  package.json  biome.json
└── PLAN.md  (ce document)
```

---

## 12. Roadmap, tests, DevOps

### 12.1 Phases (estimation pour 1 à 2 devs à temps plein)

| Phase | Durée | Livrables |
|---|---|---|
| **0 : Fondations** | 2 sem. | Monorepo, CI, compose dev, `packages/ui` (tokens + atomes + AppShell + DataTable), `contracts`, schéma DB initial, auth de base, Storybook publié |
| **1 : Intégration Wings** | 1,5 sem. | Client HTTP typé, endpoints `remote` servis à Wings, jetons éphémères, authentification SFTP, console et stats en direct, import egg Pterodactyl, tests de contrat contre un Wings réel |
| **2 : Cœur client** | 4 sem. | Liste serveurs, console, graphes, fichiers + éditeur, power, variables de démarrage, activité, notifications temps réel |
| **3 : Gestion** | 3 sem. | Backups (local + S3, planifiés), databases, schedules, sous-utilisateurs + permissions, allocations, réinstall, transfert |
| **4 : Sécurité & compte** | 2 sem. | 2FA TOTP, passkeys, sessions, clés API/SSH, alertes connexion, audit immuable, CSP, rate-limit, pentest interne |
| **5 : Admin & API application** | 3 sem. | Admin complet, API application documentée (provisioning externe), webhooks sortants, script de migration Pterodactyl |
| **6 : Polish & bêta** | 2 sem. | i18n complet, responsive, PWA, accessibilité (WCAG AA), perf (Lighthouse > 90), doc utilisateur, bêta fermée |
| **v1.5** | +4 sem. | Marketplace, health checks, status page, console avancée, marque blanche, facturation multi-fournisseur. **Livrée** |
| **v2** | itératif | DNS auto, export de la consommation, agent de node et snapshots **livrés** ; firewall **proposé** (ADR 0008) ; VPS, mobile à concevoir |

**Total v1 : environ 19 semaines.** Chaque phase se termine par une démo, une revue sécurité et une mise à jour de ce plan.

**État début octobre 2026** : les phases 0 à 6 et la v1.5 sont dans `main` (§10.1, §10.2) ; la v2 avance point par point (§10.3). Restent hors du code : les bancs de contrat sur la machine de Matheo, les bancs de l'agent sur une machine d'essai (btrfs, ZFS, restauration par Wings) et le pentest externe (§0.5 du [rapport ASVS](./docs/securite/rapport-asvs-l2.md)).

### 12.2 Stratégie de tests

| Niveau | Outil | Cible |
|---|---|---|
| Unitaire | Vitest (TS) | Services, guards, utilitaires, émission des jetons Wings : plus de 80 % |
| Contrat | Vitest contre un **Wings réel** en conteneur | Les endpoints `/api/remote/*` (§7.5) et les appels sortants (§7.4). Exécuté aussi à chaque montée de version de Wings, avant déploiement. |
| Composants | Vitest + Testing Library + Storybook interaction tests | Chaque composant `packages/ui` |
| Visuel | Chromatic (ou captures Playwright) | Régressions de design |
| Intégration API | Vitest + Testcontainers (Postgres, Redis) | Chaque module NestJS |
| Contrat | Schémas Zod + diff OpenAPI en CI | Aucune rupture d'API non versionnée |
| E2E | Playwright | Parcours critiques : login + 2FA, console, upload, backup/restore, création serveur admin |
| Charge | k6 | 500 consoles simultanées, 50 uploads, API 1 000 req/s |
| Sécurité | ZAP, Trivy, `pnpm audit`, gosec, Semgrep | Chaque PR + nightly |

### 12.3 DevOps & exploitation

- **Environnements** : `dev` (compose local), `staging` (miroir prod, données anonymisées), `prod`.
- **Déploiement** : images taguées par SHA, déploiement bleu/vert du panel. Wings suit la dernière version publiée (`installer-wings.sh`, relancé node par node) ; les bancs de contrat se rejouent à chaque nouvelle version (§12.4, décision 6).
- **Migrations** : Drizzle, exécutées par un job avant le déploiement, toujours rétro-compatibles (expand/contract).
- **Observabilité** : dashboards Grafana (latence API, erreurs, jobs, nodes, conteneurs), alertes (node down > 60 s, disque > 90 %, backup échoué, taux 5xx).
- **Sauvegardes** : PostgreSQL PITR + snapshot quotidien chiffré hors site, MinIO répliqué, test de restauration mensuel.
- **Runbooks** dans `docs/runbooks/` : node down, migration de serveur, restauration DB, rotation des secrets, incident sécurité.
- **Documentation** : ADR pour chaque décision structurante (`docs/adr/0001-nestjs-vs-go-core.md`, …), doc API Scalar, guide contributeur.

### 12.4 Décisions structurantes

Posées avant la phase 1, relues à la fin de la V1 (septembre 2026) contre le code, qui fait foi. Toutes sont tranchées, et le code les suit.

1. **Core en NestJS ou en Go.** **Tranché : NestJS.** L'API est en NestJS (`apps/api`) et partage ses types avec l'interface par `packages/contracts`. Aucun Go dans le dépôt : Wings est conservé tel quel ([ADR 0001](./docs/adr/0001-wings-conserve.md)).
2. **Hébergement du panel.** **Tranché pour la V1 : une seule machine.** L'API et l'interface tournent sous systemd derrière nginx, avec PostgreSQL sur la même machine (`infra/prod`, [installation](./docs/installation.md)). Ni Compose HA, ni Traefik, ni chart Helm ne sont livrés ; §4.4 les garde comme cible. La question se rouvrira quand une machine ne suffira plus.
3. **Stockage des sauvegardes.** **Tranché : tout compartiment compatible S3** (Amazon, Scaleway, OVH, MinIO), point d'accès et adressage par chemin réglables dans Administration › Paramètres › Stockage des sauvegardes. MinIO ou S3 externe devient un choix d'exploitation, plus une question de code. Dès qu'un compartiment est réglé, chaque nouvelle sauvegarde y part (adaptateur `s3` de Wings) et se restaure par un lien signé ; sans lui, elles restent sur le disque du node. Le branchement était incomplet — le panel demandait toujours l'adaptateur local — et le chemin distant n'avait jamais tourné : il cachait trois autres défauts (une adresse de partie en trop, une archive sans type de contenu, une empreinte de corps vide signée dans chaque adresse). Corrigés en septembre 2026, et vérifiés contre le code réel de Wings et un MinIO. Un point d'accès privé doit être autorisé sur chaque node (`restore_host_allowlist`), sans quoi Wings refuse d'y reprendre une archive.
4. **Fournisseurs de connexion.** **Tranché et livré : un bouton « Se connecter avec Google », facultatif, à côté du mot de passe.** Les clients entrent d'ordinaire par le lien du système de facturation (§5.1) ; l'équipe peut passer par un annuaire OIDC configurable, qui devient alors le seul chemin, pour tous — le bouton Google disparaît alors. Il s'ajoute pour qui préfère son compte Google au mot de passe, sur la valeur `google` de `oauth_provider`, et ne crée un compte que si les inscriptions sont ouvertes (§5.1). Discord reste hors V1 (valeur `discord` réservée).
5. ~~**Sondes de jeu** : dans Forge ou dans le worker ?~~ **Tranché** : dans le worker. Wings ne les expose pas et n'est pas modifié (§8.2).
6. **Version de Wings.** **Tranché : suivre l'amont.** `installer-wings.sh` installe la dernière version publiée et, relancé sur un node, le met à jour. Les bancs de `infra/local` se rejouent à chaque nouvelle version, et une dérive de contrat se corrige côté panel ; le compose de dev reste épinglé (aujourd'hui `v1.11.13`) pour que les bancs soient reproductibles, et monte avec eux. Risque accepté : un node mis à jour avant le passage des bancs tourne sur une version qu'aucun banc n'a vue. Amendement de l'[ADR 0001](./docs/adr/0001-wings-conserve.md).

---

## Annexe A : composition d'une page avec les composants

```tsx
// apps/web/app/(client)/server/[id]/backups/page.tsx  (< 60 lignes)
export default function BackupsPage({ params }) {
  const t = useTranslations('backups');
  const { data: server } = useServer(params.id);
  const backups = useBackups(params.id);           // TanStack Query + événements temps réel
  const { can } = useServerPermissions(params.id);

  return (
    <ListPageTemplate
      header={<PageHeader icon={Archive} title={t('title')} subtitle={t('subtitle')}
              actions={can('backups.create') && <CreateBackupButton serverId={params.id} />} />}
      quota={<MetricBar label={t('quota')} value={backups.data?.length ?? 0} max={server?.backupLimit} />}
    >
      <DataTable
        columns={backupColumns({ t, can })}
        data={backups.data}
        isLoading={backups.isLoading}
        emptyState={<EmptyState icon={Archive} title={t('empty.title')} description={t('empty.description')} />}
        rowActions={(b) => <BackupRowActions backup={b} />}
      />
    </ListPageTemplate>
  );
}
```

## Annexe B : guard de permission réutilisable (API)

```ts
@Controller('client/servers/:server/backups')
@UseGuards(SessionGuard, ServerAccessGuard)
export class BackupsController {
  @Post()
  @RequireServerPermission('backups.create')
  @Idempotent()
  create(@Server() server: ServerEntity, @Body() dto: CreateBackupDto) {
    return this.backups.create(server, dto);  // publie job + événement temps réel
  }
}
```

## Annexe C : correspondance Pterodactyl vers nouveau panel (migration)

| Pterodactyl | Nouveau |
|---|---|
| `wings` | **Inchangé.** Rien à migrer, rien à redéployer. |
| `config.yml` wings | Même fichier, seuls l'URL du panel et le jeton changent (généré et téléchargeable depuis `/admin/nodes`). |
| Volumes `/var/lib/pterodactyl/volumes` | Inchangés, UUID de serveur conservés. |
| `/api/client/*` | `/api/v1/client/*` (mêmes concepts, erreurs Problem Details) |
| `/api/application/*` | `/api/v1/application/*` |
| Permissions subuser (strings) | Même liste + presets |
| Eggs JSON | Import direct |
| WebSocket `/api/servers/:id/ws` | Socket.IO namespace `/servers`, room `server:{id}` |
