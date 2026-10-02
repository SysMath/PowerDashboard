# 0010 — L'application mobile est une application Expo de l'espace client, qui se lie à un panel par le navigateur du téléphone et parle à l'API comme un appareil révocable

- **État** : proposée
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

> Cette ADR est **proposée** : aucune ligne de code ne s'écrit avant que
> Matheo l'accepte et tranche les questions de la dernière section. Chaque
> question porte un choix recommandé ; le texte ci-dessous les suppose
> retenus.

## Contexte

Le PLAN prévoit pour la v2 une « app mobile React Native partageant
`@gamedashboard/contracts` et `@gamedashboard/sdk` » (§10.3). Le panel est déjà
utilisable sur téléphone (interface adaptative, PWA installable), mais une
PWA ne reçoit pas de notification fiable sur iOS hors de l'écran d'accueil,
ne garde pas de session au-delà de la politique du navigateur, et se perd
dans les onglets. Le besoin réel est court : **savoir tout de suite qu'un
serveur tombe, et pouvoir le relancer ou taper une commande depuis le
téléphone**, sans ouvrir un ordinateur.

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
4. **Plusieurs panels, plusieurs marques.** Le dépôt est public, chacun peut
   installer GameDashboard ; un même panel sert aussi des revendeurs en
   marque blanche, sur leur propre domaine. Une application publiée une fois
   doit pouvoir se lier à n'importe lequel.
5. **La facturation n'est jamais gérée par le panel** (règle de Matheo).
   Côté magasins d'applications, c'est aussi une nécessité : Apple et Google
   imposent leur propre paiement aux biens numériques vendus dans une
   application. Rien de payant, aucun lien vers un achat.
6. **Le panel peut tourner sur cPanel** (Passenger, pas de processus de
   fond hors de l'API) et ne garde aucun secret dans le dépôt.

## Décision

**Une application Expo (React Native), `apps/mobile` dans le monorepo,
consacrée à l'espace client. Elle se lie à un panel en ouvrant sa page de
connexion dans le navigateur du téléphone (code d'autorisation à usage unique
et PKCE), puis parle à l'API client comme un *appareil* : un jeton d'accès
court, renouvelé par un secret d'appareil que seule une clé non exportable du
téléphone sait présenter, déverrouillé par la biométrie ou le code du
téléphone, et révocable depuis le panel. Les notifications arrivent par le
service de notifications d'Expo, sans contenu sensible. La console parle à
Wings comme le navigateur.** Rien de la facturation.

### Ce que fait l'application (première version)

L'espace client, ce qu'on fait vraiment depuis un téléphone :

- **Serveurs** : liste (y compris ceux où l'on est sous-utilisateur), état,
  ressources en direct, blocage « machine injoignable » (ADR 0005) avec le
  même texte que l'interface web.
- **Alimentation** : démarrer, arrêter, redémarrer, tuer, avec confirmation.
- **Console** : sortie en direct, filtres et recherche de la console web
  (mêmes règles : `packages/ui/src/lib/console-text.ts`, qui ne dépend pas du DOM, passe dans un paquet partagé),
  envoi d'une commande, autocomplétion des commandes de l'egg.
- **Joueurs** : liste et actions déclarées par l'egg (`players.*`).
- **Sauvegardes** : liste, création, verrouillage ; la restauration reste
  sur le web (geste destructeur, mieux sur un grand écran).
- **Notifications** : la boîte de notifications du panel, et les
  notifications poussées (plus bas), réglées par type comme sur le web.
- **Compte** : appareils liés, déconnexion de l'appareil.

Restent **sur le web**, et l'application y renvoie : fichiers et éditeur,
bases de données, planificateur, sous-utilisateurs, réseau et sous-domaines,
instantanés, marketplace, réglages de sécurité du compte (mot de passe,
second facteur, clés), espace revendeur, administration. Les permissions
sont exactement celles du web : l'application n'en ajoute ni n'en retire,
c'est l'API qui décide.

### Lier un panel

1. L'utilisateur saisit l'adresse du panel, ou **scanne un code QR** affiché
   dans le panel (Compte › Application mobile), qui contient l'adresse et
   rien d'autre.
2. L'application lit la marque publique de ce domaine (nom, logo, couleurs,
   ce que la page de connexion montre déjà) et l'applique : le client d'un
   revendeur voit sa marque, pas « GameDashboard ».
3. Elle ouvre `https://<panel>/auth/app/authorize?…` dans une session de
   navigateur système (`ASWebAuthenticationSession` sur iOS, Custom Tabs sur
   Android), avec un défi PKCE (S256), un `state` et le nom de l'appareil.
   L'utilisateur se connecte **par le chemin habituel** (mot de passe et
   second facteur, clé d'accès, Google, annuaire), puis une page du panel
   demande : « Autoriser l'application sur *Pixel de Léa* ? ».
4. Le panel renvoie vers l'application (lien universel / App Link de
   l'application, schéma propre en repli) avec un **code à usage unique, de
   soixante secondes**. L'application l'échange, avec le vérificateur PKCE
   et la clé publique d'appareil qu'elle vient de créer, contre un jeton
   d'accès et un secret d'appareil.

Le second facteur s'applique donc comme au web, sans une ligne de code de
plus dans l'application ; un compte qui doit passer par l'annuaire y passe.

### L'appareil, ses jetons et sa durée

- **Une table `app_devices`** : compte, nom, plateforme, condensat du secret
  d'appareil, clé publique d'appareil, jeton de notification, dernière
  activité, adresse de dernière activité, révocation. Elle s'affiche dans
  Compte › Sécurité, à côté des sessions, avec « Retirer cet appareil ».
- **Jeton d'accès** de 15 minutes (`Authorization: Bearer gd_app_…`),
  accepté par `SessionGuard` comme une clé `Bearer` : pas de cookie, donc
  pas de contrôle de provenance à faire (NC-02 ne vise que les cookies).
  Il porte les permissions client du compte, mais n'est pas une session de navigateur :
  les routes réservées au navigateur (`BrowserSessionGuard` : mot de passe,
  second facteur, clés d'accès, clés SSH, sessions du compte) restent refusées à l'application.
- **Secret d'appareil** échangé contre un nouveau jeton d'accès et
  **remplacé à chaque échange** (un secret rejoué révoque l'appareil :
  quelqu'un l'a copié). La demande est **signée par une clé non exportable**
  du téléphone (Secure Enclave, Android Keystore) dont le panel garde la
  partie publique : un secret volé hors du téléphone ne sert à rien.
- **Durée** : l'appareil reste lié tant qu'il sert au moins une fois tous
  les **30 jours**, et 90 jours au plus avant une nouvelle connexion par le
  navigateur (question 3). À l'ouverture, l'application demande la
  biométrie ou le code du téléphone avant de déverrouiller le secret
  (`expo-secure-store`, accès conditionné à l'authentification).
- **Coupures** : changer de mot de passe, activer ou réinitialiser le second
  facteur, suspendre le compte ou « déconnecter partout » retire tous les
  appareils, comme les sessions. Un appareil retiré perd aussi ses
  notifications.
- **Aucune clé personnelle** n'est jamais demandée ni créée par
  l'application.

### Notifications poussées

- **Par le service de notifications d'Expo** (Expo Push), avec la
  « sécurité renforcée » qui exige un jeton d'accès Expo pour envoyer :
  le panel n'a qu'un secret à garder (`EXPO_ACCESS_TOKEN`, dans `env/`,
  jamais dans le dépôt), au lieu d'une clé APNs d'Apple et d'un compte de
  service Firebase. Sans ce secret, rien n'est poussé et l'application
  relève sa boîte à l'ouverture : c'est le cas de toute installation tierce
  du panel, car les droits d'envoi appartiennent à l'éditeur de
  l'application (question 5).
- **Les mêmes événements que les notifications du panel**, avec les mêmes
  préférences par type : serveur injoignable ou rétabli, sonde de jeu en
  échec, sauvegarde terminée ou ratée, mise à jour d'extension disponible,
  alerte de sécurité du compte.
- **Contenu minimal** : le type d'événement et le nom du serveur (« Survie :
  hors ligne »), jamais d'adresse, de ligne de console, de nom de fichier ni
  de détail de sécurité. Le texte complet se lit dans l'application, par
  l'API, une fois déverrouillée. Apple, Google et Expo ne voient que cela.
- L'envoi est une tâche du balayage `battre()`, bornée, sans relance
  infinie ; un jeton refusé par Expo (`DeviceNotRegistered`) est effacé.

### La console

L'application demande le jeton de console à l'API (`POST
/api/v1/client/servers/{id}/websocket`, la route que le relais de Next
appelle déjà), puis ouvre le WebSocket chez Wings avec l'en-tête `Origin`
égal à l'adresse du panel. Wings ne voit aucune différence avec un
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
- **Côté panel**, la seule nouveauté : les routes `auth/app/*` (autoriser,
  échanger, renouveler, retirer), `GET|DELETE /account/devices`, la table
  `app_devices`, l'envoi Expo, la page « Application mobile » (code QR) et
  l'association des liens universels (`/.well-known/apple-app-site-association`,
  `/.well-known/assetlinks.json`). Toutes au catalogue (ADR 0003), donc dans
  `openapi.json`, avec leurs tests ; migration additive, compatible
  PostgreSQL 9.6.

### Construire et publier

- **Expo SDK 57** (React Native 0.86) au moment de l'écriture, puis la
  dernière version stable, comme le reste des dépendances. TypeScript strict,
  Biome, Vitest pour la logique, tests de composants avec React Native
  Testing Library ; lint, typecheck et tests de `apps/mobile` dans
  `ci.yml`, dans le même conteneur Linux que le reste.
- **Compilation des binaires par EAS Build** (le service de compilation
  d'Expo) : un binaire iOS exige macOS, que ni le runner Windows ni le
  conteneur Linux n'ont. Les identifiants de signature restent chez Expo et
  chez Matheo, jamais dans le dépôt.
- **Publiée sous le compte de Matheo** sur l'App Store et Google Play
  (question 6). Pas de mise à jour « à chaud » du code (EAS Update) : chaque
  version passe par les magasins, donc par leur vérification ; une mise à
  jour à chaud serait un chemin pour pousser du code sans relecture.
- **Version minimale du panel** : l'application lit la version que le panel
  annonce et refuse poliment un panel trop ancien pour elle.

## Sécurité

- **Pas de mot de passe dans l'application** : la connexion se fait dans le
  navigateur système, que l'application ne peut pas lire. Le code PKCE
  empêche une autre application qui intercepterait le retour de l'utiliser.
- **Un appareil volé** : la biométrie ou le code du téléphone protège le
  secret ; le secret seul ne sert à rien sans la clé matérielle ; « Retirer
  cet appareil » coupe tout au prochain renouvellement (15 minutes au plus).
- **Pas de nouveau pouvoir** : un jeton d'application a exactement les
  permissions du compte sur l'API client, sans les routes réservées au
  navigateur. Il ne vaut ni pour l'administration ni pour l'API applicative.
- **TLS ordinaire, pas d'épinglage** : chaque panel a son propre certificat,
  souvent Let's Encrypt renouvelé tous les 90 jours ; épingler casserait
  l'application à chaque renouvellement. Adresse en `https://` seulement.
- **Journal** : liaison, renouvellement suspect (secret rejoué), retrait
  d'un appareil et coupure consignés dans l'activité du compte et annoncés
  par l'alerte de sécurité existante (« nouvel appareil lié »).
- **Données sur le téléphone** : le secret dans le trousseau ; aucune ligne
  de console ni liste de serveurs gardée hors de la mémoire ; capture
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
- **Flutter, natif Swift et Kotlin** : le PLAN veut partager `contracts` et
  le SDK, écrits en TypeScript.
- **L'administration dans l'application** : surface sensible pour un usage
  rare depuis un téléphone. Les administrateurs reçoivent les alertes de
  machine perdue par les notifications ; le reste se fait sur le web
  (question 2).

## Conséquences

- **Un deuxième client à tenir à jour** : chaque route qu'il emploie est
  vérifiée contre le catalogue par le SDK, comme aujourd'hui.
- **Comptes et coûts chez des tiers**, à la charge de Matheo : compte
  développeur Apple (annuel), compte Google Play, compte Expo (EAS Build,
  Expo Push).
- **Tests** :
  - panel (intégration PostgreSQL, 9.6 compris) : code d'autorisation à
    usage unique et expiré, PKCE faux, `state` faux, échange signé par une
    autre clé, secret rejoué qui révoque l'appareil, durée de 30 et 90 jours,
    coupure au changement de mot de passe et au « déconnecter partout »,
    routes réservées au navigateur refusées, routes au catalogue, envoi Expo
    borné et jeton périmé effacé, contenu des notifications sans détail ;
  - application : logique de liaison et de renouvellement, filtres de la
    console, rendu des écrans principaux, concordance des jetons de couleur ;
  - banc réel sur un téléphone iOS et un Android contre un panel d'essai et
    un Wings : liaison, console (en-tête `Origin` accepté par Wings),
    notification reçue, appareil retiré. Il ne tourne pas en session
    distante.
- **cPanel** : rien de particulier, tout passe par l'API ; l'envoi Expo est
  une sortie HTTPS. Les deux fichiers `/.well-known/` sont servis par Next
  et doivent figurer dans le relais (`api-relay.ts`) s'ils sont servis par
  l'API.
- **Livraison en trois lots** (question 7) : liaison et appareils côté
  panel ; application (serveurs, alimentation, console, notifications dans
  l'application) ; notifications poussées et publication.
- **À revoir si** Apple ou Google changent leurs règles sur les liens de
  connexion, si Expo Push disparaît ou devient payant au-delà du
  raisonnable, ou si Wings se met à exiger autre chose que l'en-tête
  `Origin` pour sa console.

## Questions ouvertes pour Matheo

Chaque question a un choix, marqué *recommandé*.

1. **Accepter l'architecture** : application Expo de l'espace client,
   liaison par le navigateur (PKCE), appareil révocable, console directe
   chez Wings, aucune facturation. *Recommandé.*
2. **Périmètre** : espace client seulement, avec les écrans de « Ce que fait
   l'application » *recommandé* ; ou aussi un espace revendeur, ou une
   administration en lecture.
3. **Durée d'un appareil** : lié tant qu'il sert tous les 30 jours, 90 jours
   au plus, biométrie ou code du téléphone à chaque ouverture *recommandé* ;
   ou la règle du web (30 minutes, 12 heures), qui reconnecte presque à
   chaque ouverture.
4. **Restauration de sauvegarde et gestionnaire de fichiers** sur le
   téléphone : non en première version *recommandé*, ou oui.
5. **Notifications poussées** : par Expo Push, contenu minimal (type et nom
   du serveur), réservées aux panels qui ont le jeton d'envoi
   *recommandé* ; ou contenu complet ; ou pas de notifications poussées.
6. **Publication** : sous ton compte, une seule application qui prend la
   marque du panel auquel elle se lie *recommandé* ; nom dans les
   magasins : « GameDashboard ».
7. **Ordre de livraison** : les trois lots de « Conséquences » dans cet
   ordre *recommandé*.
