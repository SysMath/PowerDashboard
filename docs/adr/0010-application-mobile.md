# 0010 — L'application mobile est une application Expo publique qui se lie à n'importe quel panel auto-hébergé par le navigateur du téléphone, et parle à son API comme un appareil révocable

- **État** : acceptée (2026-10-02, avec les réponses de Matheo : dernière section)
- **Date** : 2026-10
- **Références** : PLAN §10.3, §11 ; [ADR 0001](./0001-wings-conserve.md),
  [ADR 0003](./0003-catalogue-api-source-unique.md), [ADR 0004](./0004-sdk-ecrit.md),
  [ADR 0005](./0005-machine-muette.md), [ADR 0007](./0007-secrets-et-donnees-au-repos.md) ;
  `packages/contracts`, `packages/sdk/src/client.ts`, `packages/i18n`,
  `packages/ui/src/styles/tokens.css` ;
  `apps/api/src/modules/auth/session.guard.ts` (`Bearer`, provenance NC-02),
  `browser-session.guard.ts` (routes réservées au navigateur),
  `session.repository.ts` (`SESSION_IDLE_MS`), `packages/db/src/schema/identity.ts`
  (`sessions`, `api_keys`) ; `apps/web/src/app/api/servers/[id]/websocket/route.ts`
  (jeton de console Wings) ; `docs/securite/rapport-asvs-l2.md` (sessions,
  second facteur) ; Expo SDK 57 (React Native 0.86)

> Proposée puis **acceptée** par Matheo le 2026-10-02. Ses réponses aux sept
> questions sont consignées dans la dernière section. Trois d'entre elles
> changent la décision, et le texte ci-dessous les intègre : l'application
> couvre aussi l'espace revendeur et une administration simple ; la
> restauration de sauvegarde et le gestionnaire de fichiers sont dans
> l'application ; et surtout, **l'application est publique et doit se lier à
> n'importe quel panel**, puisque chacun peut héberger le sien. Le découpage
> en lots est revu en conséquence. Aucune ligne de code de l'application ne
> s'écrit avant que Matheo ait validé cette version révisée.

## Contexte

Le PLAN prévoit pour la v2 une « app mobile React Native partageant
`@gamedashboard/contracts` et `@gamedashboard/sdk` » (§10.3). Le panel est déjà
utilisable sur téléphone (interface adaptative, PWA installable), mais une
PWA ne reçoit pas de notification fiable sur iOS hors de l'écran d'accueil,
ne garde pas de session au-delà de la politique du navigateur, et se perd
dans les onglets. Le besoin premier est court : **savoir tout de suite qu'un
serveur tombe, et pouvoir le relancer ou taper une commande depuis le
téléphone**, sans ouvrir un ordinateur. Pour les revendeurs et
l'administration, c'est le même besoin à l'échelle du parc : voir ce qui ne
va pas et faire le geste courant qui le règle.

Six contraintes cadrent la réponse.

1. **Wings ne change pas** (ADR 0001). La console d'un serveur de jeu est un
   WebSocket ouvert **directement chez Wings** avec un jeton de dix minutes
   que le panel délivre ; Wings refuse une connexion dont l'en-tête `Origin`
   n'est pas l'adresse du panel (`allowed_origins` est vide dans la
   configuration que le panel écrit). L'application doit donc présenter
   l'origine du panel, ce que React Native permet (en-têtes du constructeur
   `WebSocket`) et qu'un banc doit confirmer sur iOS et Android.
2. **Les sessions du panel sont faites pour un navigateur** : cookie,
   contrôle de provenance (NC-02), fermeture après 30 minutes d'inactivité
   et 12 h au plus (arbitrage ASVS de Matheo). Une application qu'on ouvre
   deux fois par jour serait déconnectée à chaque fois. Les clés
   personnelles (`api_keys`, `gd_live_…`), elles, sont des secrets longs
   qu'on recopie à la main : les faire coller dans un téléphone, c'est les
   faire passer par le presse-papiers et les captures d'écran.
3. **Toute la connexion vit déjà dans le navigateur** : mot de passe,
   second facteur, clés d'accès (passkeys, liées au domaine, y compris celui
   d'un revendeur), Google, annuaire OIDC obligatoire. La réécrire dans
   l'application doublerait la surface la plus sensible du panel.
4. **N'importe quel panel, n'importe quelle marque.** Exigence de Matheo :
   l'application est publiée une fois, pour tout le monde, mais **le panel
   doit pouvoir être hébergé par n'importe qui**. L'application ne connaît
   donc aucune adresse à l'avance : elle se lie à l'instance que
   l'utilisateur désigne, vérifie que c'en est bien une, et peut en tenir
   plusieurs (un client servi par deux hébergeurs). Un même panel sert
   aussi des revendeurs en marque blanche, sur leur propre domaine. Un
   système de licence viendra plus tard, à discuter avec Matheo : rien
   n'en est conçu ici, mais rien ne doit l'empêcher.
5. **La facturation n'est jamais gérée par le panel** (règle de Matheo).
   Côté magasins d'applications, c'est aussi une nécessité : Apple et Google
   imposent leur propre paiement aux biens numériques vendus dans une
   application. Rien de payant, aucun lien vers un achat.
6. **Le panel peut tourner sur cPanel** (Passenger, pas de processus de
   fond hors de l'API) et ne garde aucun secret dans le dépôt.

## Décision

**Une application Expo (React Native), `apps/mobile` dans le monorepo,
publiée une seule fois et utilisable avec n'importe quel panel auto-hébergé.
Elle couvre l'espace client, l'espace revendeur et une administration
simple, chacun selon les droits du compte. Elle se lie à une instance, après
l'avoir vérifiée, en ouvrant sa page de
connexion dans le navigateur du téléphone (code d'autorisation à usage unique
et PKCE), puis parle à l'API client comme un *appareil* : un jeton d'accès
court, renouvelé par un secret d'appareil que seule une clé non exportable du
téléphone sait présenter, déverrouillé par la biométrie ou le code du
téléphone, et révocable depuis le panel. Les notifications arrivent par le
service de notifications d'Expo, sans contenu sensible, directement ou par un
relais de l'éditeur pour les panels tiers. La console parle à
Wings comme le navigateur. Les binaires sont construits, signés et envoyés
aux magasins par GitHub Actions.** Rien de la facturation.

### Ce que fait l'application

Les permissions sont exactement celles du web : l'application n'en ajoute ni
n'en retire, c'est l'API qui décide. Un client ne voit que l'espace client ;
un revendeur voit en plus le sien ; un membre du personnel voit en plus
l'administration.

**Espace client** :

- **Serveurs** : liste (y compris ceux où l'on est sous-utilisateur), état,
  ressources en direct, blocage « machine injoignable » (ADR 0005) avec le
  même texte que l'interface web.
- **Alimentation** : démarrer, arrêter, redémarrer, tuer, avec confirmation.
- **Console** : sortie en direct, filtres et recherche de la console web
  (mêmes règles : `packages/ui/src/lib/console-text.ts`, qui ne dépend pas
  du DOM, passe dans un paquet partagé), envoi d'une commande,
  autocomplétion des commandes de l'egg.
- **Joueurs** : liste et actions déclarées par l'egg (`players.*`).
- **Sauvegardes** : liste, création, verrouillage et **restauration**
  (réponse 4), avec la même option « supprimer les fichiers existants »,
  l'instantané de sûreté quand le node en a (ADR 0009) et une
  confirmation de présence (plus bas).
- **Fichiers** (réponse 4) : parcourir, lire et modifier un fichier texte
  jusqu'à 1 Mo dans un éditeur simple à police fixe (pas de Monaco),
  téléverser depuis le téléphone, télécharger ou partager, renommer,
  déplacer, créer un dossier, compresser et décompresser, supprimer avec
  confirmation de présence. Mêmes routes et mêmes liens signés de Wings que
  le web ; un fichier binaire ou trop gros se télécharge, il ne s'ouvre pas.
- **Notifications** : la boîte de notifications du panel, et les
  notifications poussées (plus bas), réglées par type comme sur le web.
- **Compte** : appareils liés, instances liées, déconnexion de l'appareil.

**Espace revendeur** (réponse 2) : enveloppe et ce qu'il en reste, ses
clients et leurs serveurs (ouverts avec les écrans du client, dans la
limite de ses droits), suspension et rétablissement de leurs serveurs,
consommation lue. La marque, les domaines et les clés de boutique restent
sur le web.

**Administration** (réponse 2 : « en total intuitivité, sans réglage
majeur ») : ce qu'on vérifie et ce qu'on fait sur le parc depuis un
téléphone, sans un seul écran de configuration.

- **Vue d'ensemble** : machines injoignables, serveurs en panne, incidents
  ouverts, état de la mise à jour du panel ; chaque ligne mène à son
  écran.
- **Machines** : liste, santé, capacités annoncées par l'agent, pannes
  récentes. Lecture seule.
- **Serveurs** : recherche dans tout le parc, ouverture avec les écrans du
  client, alimentation, suspension et rétablissement.
- **Comptes** : recherche, fiche, suspension et rétablissement,
  « déconnecter partout ».
- **Incidents** de la page `/status` : ouvrir, compléter, clore, en
  quelques mots.
- **Mises à jour du panel** : voir la version disponible et lancer
  l'installation, là où le panel se met à jour seul.
- **Activité** : le journal, en lecture.

Restent **sur le web**, et l'application y renvoie par un lien vers la bonne
page : bases de données, planificateur, sous-utilisateurs, réseau et
sous-domaines, instantanés, marketplace et moteur, réglages de sécurité du
compte (mot de passe, second facteur, clés) ; côté revendeur, marque,
domaines et clés ; côté administration, tout ce qui se règle : paramètres,
nests et eggs, création et configuration des machines, emplacements,
montages, hôtes de bases, clés applicatives, webhooks, marque, liaison avec
la facturation, annuaire, rôles, création, redimensionnement et
suppression de serveurs et de comptes.

### Lier un panel

1. L'utilisateur saisit l'adresse de son panel, ou **scanne un code QR**
   affiché dans le panel (Compte › Application mobile), qui contient
   l'adresse et rien d'autre. Aucune adresse n'est écrite dans
   l'application : elle ne connaît que celles qu'on lui donne.
2. **Elle vérifie l'instance** avant d'ouvrir quoi que ce soit : `https://`
   seulement, puis `GET /.well-known/gamedashboard`, un **descripteur
   d'instance** public que tout panel sert (plus bas). Une adresse qui ne
   répond pas par un descripteur valide n'est pas un panel GameDashboard, et
   l'application le dit sans aller plus loin. Elle montre ensuite le nom de
   l'instance et son domaine, en gros, avant la connexion.
3. Elle applique la marque publique de ce domaine (`GET /api/v1/branding` :
   nom, logo, couleurs, ce que la page de connexion montre déjà) : le
   client d'un revendeur voit sa marque, pas « GameDashboard ».
4. Elle ouvre `https://<panel>/auth/app/authorize?…` dans une session de
   navigateur système (`ASWebAuthenticationSession` sur iOS, Custom Tabs sur
   Android), avec un défi PKCE (S256), un `state` et le nom de l'appareil.
   L'utilisateur se connecte **par le chemin habituel** (mot de passe et
   second facteur, clé d'accès, Google, annuaire), puis une page du panel
   demande : « Autoriser l'application sur *Pixel de Léa* ? ».
5. Le panel renvoie vers l'application (lien universel / App Link de
   l'application, schéma propre en repli) avec un **code à usage unique, de
   soixante secondes**. L'application l'échange, avec le vérificateur PKCE
   et la clé publique d'appareil qu'elle vient de créer, contre un jeton
   d'accès et un secret d'appareil.

Le second facteur s'applique donc comme au web, sans une ligne de code de
plus dans l'application ; un compte qui doit passer par l'annuaire y passe.

**Plusieurs instances** : chaque liaison est rangée à part (son secret, sa
clé d'appareil, sa marque), et un sélecteur passe de l'une à l'autre. Rien
ne circule d'une instance à l'autre : une instance malveillante ne voit que
ce que l'utilisateur fait chez elle.

### Le descripteur d'instance

`GET /.well-known/gamedashboard`, public, servi par Next (et donc présent
sur les domaines des revendeurs), sans rien de secret :

- `produit` (`gamedashboard`), `version` du panel, `version_app_minimale` ;
- `instance` : un identifiant tiré au hasard à l'installation et gardé dans
  les réglages, jamais réutilisé ;
- `nom` de l'instance (celui de la marque du domaine) ;
- `origine` attendue par Wings pour les consoles (`PANEL_ORIGIN`), qui
  peut différer du domaine d'un revendeur ;
- `notifications` : `direct`, `relais` ou `aucune` (plus bas) ;
- **une place réservée pour la licence** : aucun champ aujourd'hui, mais
  l'application ignore les champs qu'elle ne connaît pas, et le
  descripteur est l'endroit où une instance pourra un jour présenter une
  preuve de licence, sans changer la liaison.

Si une adresse déjà liée répond un jour avec un autre identifiant
d'instance, l'application suspend la liaison et demande à l'utilisateur de
confirmer : le panel a été réinstallé, ou le domaine a changé de mains.

### L'appareil, ses jetons et sa durée

- **Une table `app_devices`** : compte, nom, plateforme, condensat du secret
  d'appareil, clé publique d'appareil, jeton de notification, dernière
  activité, adresse de dernière activité, révocation. Elle s'affiche dans
  Compte › Sécurité, à côté des sessions, avec « Retirer cet appareil ».
- **Jeton d'accès** de 15 minutes (`Authorization: Bearer gd_app_…`),
  accepté par `SessionGuard` comme une clé `Bearer` : pas de cookie, donc
  pas de contrôle de provenance à faire (NC-02 ne vise que les cookies).
  Il porte les permissions du compte, mais n'est pas une session de
  navigateur : les routes réservées au navigateur (`BrowserSessionGuard` :
  mot de passe, second facteur, clés d'accès, clés SSH, sessions du compte)
  restent refusées à l'application. Côté revendeur et administration, il
  n'ouvre que **les routes que l'application emploie**, listées une fois
  (`APP_STAFF_ROUTES`, contrats) : une route d'administration qui n'y est
  pas est refusée à l'application, même au personnel. L'administration
  d'un écran de téléphone ne peut donc pas toucher un réglage, même par un
  appel fabriqué à la main.
- **Secret d'appareil** échangé contre un nouveau jeton d'accès et
  **remplacé à chaque échange** (un secret rejoué révoque l'appareil :
  quelqu'un l'a copié). La demande est **signée par une clé non exportable**
  du téléphone (Secure Enclave, Android Keystore) dont le panel garde la
  partie publique : un secret volé hors du téléphone ne sert à rien.
- **Durée** : l'appareil reste lié tant qu'il sert au moins une fois tous
  les **30 jours**, et 90 jours au plus avant une nouvelle connexion par le
  navigateur (réponse 3). À l'ouverture, l'application demande la
  biométrie ou le code du téléphone avant de déverrouiller le secret
  (`expo-secure-store`, accès conditionné à l'authentification).
- **Confirmation de présence** pour les gestes lourds (restaurer une
  sauvegarde, supprimer des fichiers, et tout geste d'administration ou de
  revendeur qui écrit) : l'application demande la biométrie, et la clé
  d'appareil, qui ne s'ouvre qu'ainsi, signe un défi à usage unique que le
  panel vient de donner. C'est l'équivalent, pour un appareil, de la
  confirmation par mot de passe du web.
- **Coupures** : changer de mot de passe, activer ou réinitialiser le second
  facteur, suspendre le compte ou « déconnecter partout » retire tous les
  appareils, comme les sessions. Un appareil retiré perd aussi ses
  notifications.
- **Aucune clé personnelle** n'est jamais demandée ni créée par
  l'application.

### Notifications poussées

Les droits d'envoyer une notification à l'application appartiennent à son
éditeur, Matheo : un panel hébergé par quelqu'un d'autre ne peut pas les
avoir. Deux chemins, que le descripteur d'instance annonce :

- **Direct** (`notifications: direct`), pour les instances de Matheo : le
  panel envoie par le service de notifications d'Expo (Expo Push) avec la
  « sécurité renforcée », qui exige un jeton d'accès Expo pour envoyer
  (`EXPO_ACCESS_TOKEN`, dans `env/`, jamais dans le dépôt).
- **Par le relais de l'éditeur** (`notifications: relais`), pour toutes les
  autres instances : un petit service tenu par Matheo, qui garde seul le
  jeton Expo. Le relais est un mode du même code (`PUSH_RELAY=1`), qu'une
  instance de Matheo peut porter, à une adresse fixe écrite dans
  l'application et dans le panel (`PUSH_RELAY_URL`, modifiable).
  - **Enregistrement** : à sa première liaison, une instance crée une paire
    de clés Ed25519 et enregistre sa clé publique et son identifiant
    d'instance au relais. Chaque envoi est signé.
  - **Une instance n'atteint que ses propres appareils** : c'est
    l'application qui inscrit son jeton Expo au relais, pour une instance
    donnée, et reçoit en échange une poignée opaque qu'elle remet au
    panel. Le relais refuse un envoi vers une poignée inscrite pour une
    autre instance ; un panel tiers ne peut donc ni connaître un jeton Expo
    ni écrire à un téléphone qui ne l'a pas lié.
  - **Bornes** : débit plafonné par instance, contenu au format fermé
    (type d'événement, nom du serveur, identifiant de la notification),
    rien de gardé après l'envoi hormis les poignées. Une instance qui abuse
    est coupée.
  - **Licence** : si un système de licence vient, l'enregistrement au relais
    est le second endroit où il pourra se brancher. Rien aujourd'hui.
- **Aucune** (`notifications: aucune`) : un exploitant peut refuser le
  relais ; l'application relève alors la boîte à l'ouverture.

Dans les deux chemins :

- **Les mêmes événements que les notifications du panel**, avec les mêmes
  préférences par type : serveur injoignable ou rétabli, sonde de jeu en
  échec, sauvegarde terminée ou ratée, mise à jour d'extension disponible,
  alerte de sécurité du compte ; pour le personnel, machine perdue ou
  rétablie et mise à jour du panel ; pour un revendeur, ce qui touche ses
  machines partagées.
- **Contenu minimal** (réponse 5) : le type d'événement et le nom du
  serveur (« Survie : hors ligne »), jamais d'adresse, de ligne de console,
  de nom de fichier ni de détail de sécurité. Le texte complet se lit dans
  l'application, par l'API, une fois déverrouillée. Apple, Google, Expo et
  le relais ne voient que cela.
- L'envoi est une tâche du balayage `battre()`, bornée, sans relance
  infinie ; un jeton refusé (`DeviceNotRegistered`) est effacé.

### La console

L'application demande le jeton de console à l'API (`POST
/api/v1/client/servers/{id}/websocket`, la route que le relais de Next
appelle déjà), puis ouvre le WebSocket chez Wings avec l'en-tête `Origin`
égal à l'origine que le descripteur d'instance annonce (celle du panel, même
quand on s'est lié par le domaine d'un revendeur). Wings ne voit aucune différence avec un
navigateur ; le jeton, les permissions et la coupure à la déconnexion sont
ceux d'aujourd'hui. Le relais `realtime` du SDK (§11) est écrit à cette
occasion, pour le web et l'application.

### Ce qui est partagé, ce qui ne l'est pas

- **Partagés tels quels** : `@gamedashboard/contracts` (Zod 4 fonctionne sous
  Hermes), `@gamedashboard/sdk` (fondé sur `fetch`, échéance et refus
  lisibles compris ; il gagne les méthodes de l'espace client dont
  l'application a besoin, chacune vérifiée contre le catalogue comme
  aujourd'hui), `@gamedashboard/i18n` (FR/EN, mêmes clés).
- **Les jetons de couleur** : `tokens.css` reste la source ; un script les
  exporte en module TypeScript pour l'application (clair et sombre), et un
  test vérifie la concordance. Aucune couleur en dur, là non plus.
- **Pas `packages/ui`** : ses composants sont du DOM et du Tailwind. Les
  écrans de l'application ont leurs propres composants React Native, au
  même découpage (atomes, organismes, écrans de moins de 80 lignes).
- **Côté panel** : le descripteur d'instance et l'identifiant d'instance ;
  les routes `auth/app/*` (autoriser, échanger, renouveler, défi de
  présence, retirer), `GET|DELETE /account/devices`, la table
  `app_devices` ; la liste `APP_STAFF_ROUTES` ; l'envoi direct, le client
  du relais et le mode relais ; la page « Application mobile » (code QR) ;
  l'association des liens universels (`/.well-known/apple-app-site-association`,
  `/.well-known/assetlinks.json`). Les routes que l'application emploie
  entrent au catalogue (ADR 0003), y compris celles de revendeur et
  d'administration qu'il ne couvre pas encore, donc dans `openapi.json`,
  avec leurs tests ; migrations additives, compatibles PostgreSQL 9.6.

### Construire et publier

- **Expo SDK 57** (React Native 0.86) au moment de l'écriture, puis la
  dernière version stable, comme le reste des dépendances. TypeScript strict,
  Biome, Vitest pour la logique, tests de composants avec React Native
  Testing Library ; lint, typecheck et tests de `apps/mobile` dans
  `ci.yml`, dans le même conteneur Linux que le reste.
- **Binaires construits et signés par GitHub Actions**, pas par le service
  de compilation d'Expo (souhait de Matheo) : un workflow `mobile.yml`
  part d'une étiquette `mobile-v*` ou d'une exécution lancée à la main.
  `expo prebuild` produit les projets natifs, puis :
  - **Android** (APK pour les essais, AAB pour Google Play) : Gradle dans un
    conteneur Linux épinglé, par `infra/ci/linux.sh`, sur le runner habituel
    ou sa relève `ubuntu-latest` ;
  - **iOS** (IPA) : `xcodebuild archive` puis `-exportArchive` sur un runner
    **macOS hébergé par GitHub** (`macos-latest`, gratuit pour un dépôt
    public). Un binaire iOS exige macOS et Xcode, que ni le runner Windows
    ni un conteneur n'ont : c'est la seule exception à la règle du
    conteneur Linux, écrite dans le workflow.
- **Secrets de signature dans GitHub seulement** : clé de signature Android
  (keystore en base64 et ses mots de passe), certificat de distribution et
  profil Apple, clé de l'API App Store Connect, compte de service de
  l'API Google Play Developer. Ils vivent dans un **environnement GitHub
  `magasins`** dont chaque déploiement attend l'approbation de Matheo, ne
  sont jamais exposés aux exécutions venues d'une PR (le dépôt est public),
  et ne passent jamais par le chat ni par le dépôt. Les jobs suivent les
  règles des autres workflows : actions épinglées par empreinte,
  `persist-credentials: false` (`workflows-jetons.test.ts` les vérifie).
- **Envoi aux magasins par le même workflow**, après approbation : piste de
  test interne de Google Play et TestFlight, puis publication à la main
  dans les consoles des magasins. Chaque binaire est attesté
  (`actions/attest`) et sa nomenclature CycloneDX publiée, comme les
  releases du panel.
- **Publiée sous le compte de Matheo** sur l'App Store et Google Play
  (réponse 6). Pas de mise à jour « à chaud » du code (EAS Update) : chaque
  version passe par les magasins, donc par leur vérification ; une mise à
  jour à chaud serait un chemin pour pousser du code sans relecture.
- **Versions** : l'application lit la version du panel dans le descripteur
  et refuse poliment un panel trop ancien ; le panel y annonce la version
  minimale de l'application, qui demande alors sa mise à jour. Un panel
  auto-hébergé peut ainsi retarder sur l'application sans la casser.

## Sécurité

- **Pas de mot de passe dans l'application** : la connexion se fait dans le
  navigateur système, que l'application ne peut pas lire. Le code PKCE
  empêche une autre application qui intercepterait le retour de l'utiliser.
- **Un appareil volé** : la biométrie ou le code du téléphone protège le
  secret ; le secret seul ne sert à rien sans la clé matérielle ; « Retirer
  cet appareil » coupe tout au prochain renouvellement (15 minutes au plus).
- **Pas de nouveau pouvoir** : un jeton d'application a au plus les
  permissions du compte, sans les routes réservées au navigateur, et, pour
  le revendeur et le personnel, seulement les routes de `APP_STAFF_ROUTES` ;
  les gestes lourds exigent la confirmation de présence. Il ne vaut jamais
  pour l'API applicative.
- **Instances inconnues** : l'application est publique et se lie à
  n'importe quelle adresse. Une fausse instance peut imiter une page de
  connexion, comme n'importe quel site ; l'application réduit ce risque en
  montrant le domaine exact avant la connexion, en exigeant le descripteur,
  et en ne partageant rien entre instances. Une instance n'obtient jamais
  le jeton Expo d'un téléphone, seulement sa poignée au relais.
- **Le relais** est un service de plus chez l'éditeur : il ne voit que le
  contenu minimal, ne garde que les poignées, et une compromission du
  relais permet d'envoyer des notifications trompeuses, pas de lire un
  panel. Le modèle de menace le dit.
- **TLS ordinaire, pas d'épinglage** : chaque panel a son propre certificat,
  souvent Let's Encrypt renouvelé tous les 90 jours ; épingler casserait
  l'application à chaque renouvellement. Adresse en `https://` seulement.
- **Journal** : liaison, renouvellement suspect (secret rejoué), retrait
  d'un appareil et coupure consignés dans l'activité du compte et annoncés
  par l'alerte de sécurité existante (« nouvel appareil lié »).
- **Données sur le téléphone** : le secret dans le trousseau ; aucune ligne
  de console, liste de serveurs ni fichier ouvert gardé hors de la mémoire
  (un fichier téléchargé va où l'utilisateur le range, comme sur le web) ; capture
  d'écran permise (c'est le téléphone de l'utilisateur).
- **Le modèle de menace** (`docs/securite/modele-de-menace.md`) gagne
  l'appareil mobile comme nouvel acteur.

## Options écartées

- **Améliorer la PWA seulement** : pas de notification fiable sur iOS sans
  installation sur l'écran d'accueil, session soumise au navigateur, et le
  PLAN demande une application. La PWA reste, l'application ne la remplace
  pas.
- **Connexion par formulaire dans l'application** : réécrire mot de passe,
  second facteur, clés d'accès, Google et l'annuaire, et voir passer les
  mots de passe ; un formulaire dans une WebView est pire encore (l'application
  peut y lire tout ce qui se tape).
- **Coller une clé personnelle** : secret long, sans expiration courte, qui
  passe par le presse-papiers, et qui donne aussi l'accès par script.
- **Les sessions du navigateur, prolongées** : relâcher les 30 minutes et
  12 heures pour tous parce qu'un téléphone en a besoin reviendrait sur
  l'arbitrage ASVS de Matheo. Un appareil a sa propre politique, plus
  stricte sur la possession (clé matérielle), plus souple sur la durée.
- **APNs et FCM en direct** : deux secrets de plus par panel (clé `.p8`
  d'Apple, compte de service Firebase) liés au compte de l'éditeur ; Expo
  Push n'en demande qu'un et ne voit pas plus de contenu.
- **Une application par revendeur** (marque blanche dans les magasins) :
  une publication et un compte de magasin par marque. L'application unique
  prend la marque du domaine auquel elle se lie.
- **Tauri 2** (question de Matheo, 2026-10-02). Tauri affiche une interface
  web dans la WebView du téléphone, avec un cœur en Rust. Il ne rendrait pas
  l'interface du panel réutilisable : elle est rendue côté serveur par Next,
  avec une CSP à nonce, et ne s'exporte pas en fichiers statiques. Il
  faudrait réécrire les écrans comme avec React Native, ou charger le panel
  distant dans la WebView, ce qui revient à emballer la PWA (Apple refuse
  souvent ces applications, règle 4.2). Son mobile est plus jeune : les
  notifications poussées n'existent que par des greffons communautaires
  concurrents, le trousseau n'est pas couvert par un greffon officiel, et
  la console devrait passer par le côté Rust, car la WebView ne peut pas
  présenter à Wings l'origine du panel. Il ajouterait enfin un troisième
  langage (Rust) au TypeScript et au Go. Son atout, une application de
  bureau, est déjà couvert par le panel web et sa PWA. La construction par
  GitHub Actions, l'autre souhait de Matheo, vaut pour Expo aussi et a été
  retenue.
- **Le service de compilation d'Expo (EAS Build)** : il évite de tenir les
  projets natifs, mais les certificats de signature seraient gardés chez
  Expo. GitHub Actions garde tout dans le dépôt et ses secrets.
- **Flutter, natif Swift et Kotlin** : le PLAN veut partager `contracts` et
  le SDK, écrits en TypeScript.
- **Toute l'administration dans l'application** : Matheo la veut simple et
  sans réglage majeur (réponse 2). Les écrans de configuration restent sur
  le web ; l'application garde la vérification et les gestes courants.
- **Une liste d'instances tenue par l'éditeur** (annuaire des panels) :
  ferait de l'éditeur un passage obligé de chaque liaison et révélerait
  qui héberge quoi. L'adresse vient de l'utilisateur ou du code QR.
- **Notifications seulement pour les instances de l'éditeur** (version
  proposée de cette ADR) : contraire à l'exigence que l'application serve
  tous les panels auto-hébergés.
- **Laisser chaque exploitant publier sa propre application** pour avoir
  ses notifications : un compte de magasin et une publication par
  hébergeur, ce que l'application unique veut justement éviter.

## Conséquences

- **Un deuxième client à tenir à jour** : chaque route qu'il emploie est
  vérifiée contre le catalogue par le SDK, comme aujourd'hui.
- **Comptes et coûts chez des tiers**, à la charge de Matheo : compte
  développeur Apple (annuel), compte Google Play, compte Expo (gratuit,
  pour Expo Push seulement), et l'hébergement du relais de notifications,
  dont dépendent toutes les instances tierces. Les minutes des runners macOS sont gratuites
  tant que le dépôt reste public ; s'il devenait privé, elles seraient
  décomptées à un tarif élevé, et il faudrait un Mac auto-hébergé.
- **Tests** :
  - panel (intégration PostgreSQL, 9.6 compris) : code d'autorisation à
    usage unique et expiré, PKCE faux, `state` faux, échange signé par une
    autre clé, secret rejoué qui révoque l'appareil, durée de 30 et 90 jours,
    coupure au changement de mot de passe et au « déconnecter partout »,
    routes réservées au navigateur refusées, route d'administration hors de
    `APP_STAFF_ROUTES` refusée au personnel, geste lourd refusé sans
    confirmation de présence ou avec un défi rejoué, descripteur
    d'instance sans secret, routes au catalogue, envoi borné et jeton
    périmé effacé, contenu des notifications sans détail ;
  - relais : envoi non signé ou signé par une autre instance refusé,
    poignée d'une autre instance refusée, débit plafonné, rien de gardé
    hormis les poignées ;
  - application : vérification d'une instance (descripteur absent, faux,
    identifiant changé), plusieurs instances rangées à part, logique de
    liaison et de renouvellement, filtres de la console, éditeur de
    fichiers borné, rendu des écrans principaux, concordance des jetons de couleur ;
  - workflow : `mobile.yml` vérifié comme les autres (actions épinglées,
    `persist-credentials: false`, secrets réservés à l'environnement
    `magasins`, aucun secret lu par un job déclenché par une PR) ;
  - banc réel sur un téléphone iOS et un Android contre un panel d'essai et
    un Wings : liaison, console (en-tête `Origin` accepté par Wings),
    notification reçue, appareil retiré. Il ne tourne pas en session
    distante.
- **cPanel** : rien de particulier, tout passe par l'API ; l'envoi Expo est
  une sortie HTTPS. Les deux fichiers `/.well-known/` sont servis par Next
  et doivent figurer dans le relais (`api-relay.ts`) s'ils sont servis par
  l'API.
- **Livraison en sept lots** (réponse 7 : « revoir les plans » avec le
  nouveau périmètre), chacun dans sa PR avec ses tests, chacun utilisable
  seul :
  1. **Panel, socle** : descripteur et identifiant d'instance, liaison
     (`auth/app/*`), `app_devices`, confirmation de présence,
     `APP_STAFF_ROUTES`, Compte › Appareils et code QR, fichiers
     `/.well-known/`.
  2. **Application, socle** : `apps/mobile`, vérification et liste des
     instances, liaison, serveurs, alimentation, console, joueurs,
     notifications dans l'application ; `mobile.yml` jusqu'aux pistes de
     test (TestFlight, test interne de Google Play), pas encore en public.
  3. **Espace client complet** : sauvegardes avec restauration,
     gestionnaire de fichiers.
  4. **Notifications poussées** : envoi direct, mode relais et son
     enregistrement, inscription des poignées par l'application.
  5. **Espace revendeur**.
  6. **Administration simple**.
  7. **Publication publique** dans les deux magasins, après le banc réel
     sur iOS et Android, avec la fiche, la politique de confidentialité et
     les captures.
- **À revoir si** le système de licence arrive (descripteur et
  enregistrement au relais sont ses deux points d'entrée), si Apple ou
  Google changent leurs règles sur les liens de connexion, si Expo Push disparaît ou devient payant au-delà du
  raisonnable, ou si Wings se met à exiger autre chose que l'en-tête
  `Origin` pour sa console.

## Réponses de Matheo (2026-10-02)

1. **Architecture** (Expo plutôt que Tauri, liaison par le navigateur,
   appareil révocable, console directe chez Wings, GitHub Actions, aucune
   facturation) : oui.
2. **Périmètre** : aussi l'espace revendeur et l'administration, **celle-ci
   « en total intuitivité, sans réglage majeur »** → « Ce que fait
   l'application ». Et, en note : **l'application est disponible pour tout
   le monde, mais le panel doit pouvoir être hébergé par n'importe qui**,
   avec un système de licence à discuter plus tard → contexte, point 4 ;
   « Lier un panel » ; « Le descripteur d'instance » ; relais de
   notifications.
3. **Durée d'un appareil** (30 jours d'inactivité, 90 jours au plus,
   biométrie à l'ouverture) : oui.
4. **Restauration de sauvegarde et gestionnaire de fichiers** : oui, si
   possible → dans l'espace client, avec la confirmation de présence.
5. **Notifications** par Expo Push, au contenu minimal : oui. Pour servir
   les panels tiers, cette version ajoute le relais de l'éditeur.
6. **Publication** sous le compte de Matheo, une seule application qui prend
   la marque du panel : oui.
7. **Ordre de livraison** : « revoir les plans » avec ces informations →
   sept lots, dans « Conséquences ».
