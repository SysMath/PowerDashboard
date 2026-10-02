# Application mobile

L'application GameDashboard pour iOS et Android (ADR 0010) : une seule
application publique, sous le compte de l'éditeur, qui se lie à n'importe
quel panel auto-hébergé. Code dans `apps/mobile` (Expo, React Native).

## Développer

La clé d'appareil vit dans un module natif (`modules/cle-appareil`, Secure
Enclave sous iOS, Keystore sous Android) : Expo Go ne suffit pas, il faut
une version de développement construite sur le poste.

```bash
pnpm --filter @gamedashboard/mobile android   # JDK 17 et SDK Android
pnpm --filter @gamedashboard/mobile ios       # macOS et Xcode
pnpm --filter @gamedashboard/mobile test      # le noyau, sous Node
pnpm --filter @gamedashboard/mobile couleurs  # après toute retouche de tokens.css
```

Le panel visé doit être en `https://`. En local, le tunnel décrit dans
`CLAUDE.md` (« En session distante ») donne une adresse publique avec un
certificat valide.

| Dossier | Contenu |
|---|---|
| `app/` | Écrans (expo-router), moins de 80 lignes chacun |
| `src/noyau/` | Liaison, session, registre des instances, console : TypeScript pur, testé sous Node |
| `src/natif/` | Le noyau branché sur le téléphone (trousseau, clé, navigateur) |
| `src/hooks/`, `src/composants/` | État des écrans et briques d'interface |
| `src/theme/` | Couleurs tirées de `packages/ui/src/styles/tokens.css` (`couleurs.test.ts` vérifie la concordance) |
| `modules/cle-appareil/` | Module natif Swift et Kotlin |
| `plugins/signature.ts` | Signature des binaires publiés, posée à chaque `expo prebuild` |
| `scripts/` | Construction Android, envoi à Google Play, export des couleurs |

Les textes sont dans l'espace `mobile` de `packages/i18n` ; l'interface web
ne l'embarque pas.

## Ce que fait l'application

- **Serveurs** : état, alimentation, console en direct, joueurs.
- **Sauvegardes** : liste et quota, création, verrouillage, restauration
  (par-dessus les fichiers, ou après les avoir vidés), suppression.
- **Fichiers** : parcours, éditeur à chasse fixe pour les fichiers texte
  de 1 Mo au plus, envoi depuis le téléphone, téléchargement vers le
  partage du système, renommage et déplacement (un chemin relatif, comme
  sur le web), nouveau dossier, compression, extraction, suppression. Un
  fichier binaire ou plus gros se télécharge et ne s'ouvre pas.
- **Gestes lourds** : restaurer ou supprimer une sauvegarde, supprimer des
  fichiers, restaurer un instantané. Le SDK y joint une présence fraîche
  (`x-gd-presence`), donc une biométrie, sur les seules routes de
  `APP_PRESENCE_ROUTES` ; l'invite dit le geste.
- Les octets des fichiers vont directement du téléphone au daemon, et
  retour, par les liens signés que délivre le panel, comme pour le web.
  Un fichier téléchargé passe par un seul dossier du cache, vidé au
  téléchargement suivant.
- **Notifications poussées** : voir plus bas. Le toucher ouvre la cloche du
  panel qui les a envoyées.
- Restent au navigateur : bases de données, planificateur, permissions des
  fichiers, sous-utilisateurs, réglages du compte.

## Notifications poussées

Le droit d'écrire à l'application appartient à son éditeur : Apple et Google
ne la joignent que par Expo Push, avec le **jeton d'accès Expo de
l'éditeur** (« sécurité renforcée » : sans lui, le jeton d'un téléphone ne
sert à rien). Un panel le dit dans son descripteur (`notifications`) :

| Mode | Réglage de l'API | Chemin |
|---|---|---|
| `direct` | `EXPO_ACCESS_TOKEN` | Le panel écrit à Expo avec le jeton de l'éditeur : son propre panel, ou un exploitant à qui l'éditeur l'a confié. |
| `relais` | `PUSH_RELAY_URL` (https) | Le panel signe ses envois et les remet au relais de l'éditeur, qui seul détient le jeton. Cas de tout panel auto-hébergé. |
| `aucune` | ni l'un ni l'autre, ou `PUSH_MODE=aucune` | L'application relève la cloche à l'ouverture. |

- **Ce qui voyage** : le type d'événement, le nom du serveur (64 caractères
  au plus), l'identifiant de la notification et celui du panel. Le texte
  est fixe (« Survie » — « Serveur injoignable ») ; le reste se lit dans
  l'application déverrouillée. Une ligne de la boîte d'envoi
  (`push_outbox`) vit une heure au plus ; trois essais.
- **Qui reçoit** : les téléphones liés au compte, vus depuis trente jours,
  pour les événements dont la colonne « Téléphone » est cochée dans
  Compte › Notifications. Par défaut : ce qui part aussi par courriel, plus
  le retour d'un serveur ou d'un node.
- **Le relais** : une instance avec `PUSH_RELAY=1` et `EXPO_ACCESS_TOKEN`
  sert `/api/v1/relais/` (relayé par nginx et par Next). Un panel s'y
  enregistre avec la clé publique Ed25519 de son instance, que le relais
  n'accepte que si le descripteur publié à l'origine du panel la porte ;
  l'application y inscrit son jeton Expo et ne donne au panel que la
  poignée rendue. Le relais ne garde que le condensat des poignées.
  Envois signés, datés à cinq minutes près, rejeu refusé, 2 000 par heure et
  20 000 poignées par instance.
- **L'application ne suit qu'un relais connu** : la liste vient de sa
  construction (`RELAIS_NOTIFICATIONS`), jamais du panel. Un panel qui
  annonce un autre relais n'a pas de notifications poussées.

## Écarts assumés avec l'ADR 0010

- **Secret d'appareil sans authentification propre dans le trousseau.**
  Le secret est rangé « ce téléphone seulement, déverrouillé », sans
  biométrie à chaque lecture : c'est la clé matérielle qui l'exige (fenêtre
  de quinze minutes). Le secret seul ne sert à rien sans elle, et une seule
  invite suffit au lieu de deux.
- **Pas de liens universels** : l'application ne peut pas déclarer chaque
  domaine de panel ; le retour de la liaison passe par `gamedashboard://`,
  protégé par PKCE.
- **Marque du revendeur** : le nom de l'instance seulement, pour l'instant.
- **Tests de composants** (React Native Testing Library) : avec le banc sur
  un vrai téléphone. Vitest couvre le noyau.

## Publier

`.github/workflows/mobile.yml` construit, signe et envoie l'application sur
les **pistes de test** : piste interne de Google Play et TestFlight. La
publication au public se fait ensuite à la main, dans chaque console.

### Une fois pour toutes

1. **Environnement GitHub** : Settings › Environments › `magasins`.
   *Required reviewers* : Matheo. *Deployment branches and tags* :
   étiquettes `mobile-v*` seulement. Les secrets et variables ci-dessous
   s'y posent, jamais au niveau du dépôt.
2. **Google Play** :
   - créer l'application (identifiant `fr.gamedashboard.app`, défini dans
     `apps/mobile/identifiant.ts`) et garder la signature par Google Play
     (*Play App Signing*) : la clé d'envoi ci-dessous se remplace alors
     auprès de Google si elle fuit ;
   - clé d'envoi :
     `keytool -genkeypair -keystore envoi.jks -alias envoi -keyalg RSA -keysize 4096 -validity 10000`,
     puis `base64 -w0 envoi.jks` dans `ANDROID_KEYSTORE_BASE64`, avec
     `ANDROID_KEYSTORE_MOT_DE_PASSE`, `ANDROID_CLE_ALIAS` et
     `ANDROID_CLE_MOT_DE_PASSE` ;
   - compte de service Google Cloud avec l'API Google Play Developer,
     invité dans la console avec la seule permission de publier sur les
     pistes de test de cette application ; sa clé JSON dans
     `PLAY_COMPTE_SERVICE` ;
   - variable `PLAY_STATUT` à `draft` tant que la fiche n'a jamais été
     publiée (Google refuse sinon), puis à retirer ;
   - le **tout premier AAB** se dépose à la main (piste de test interne) :
     Google refuse l'API avant. Le prendre dans les artefacts de la première
     exécution, dont l'envoi échoue pour cette raison.
3. **Apple** :
   - identifiant d'application `fr.gamedashboard.app` et fiche dans App
     Store Connect ;
   - certificat *Apple Distribution* exporté en `.p12` :
     `base64` dans `APPLE_CERTIFICAT_P12`, son mot de passe dans
     `APPLE_CERTIFICAT_MOT_DE_PASSE` ;
   - profil *App Store* de l'application : `base64` dans `APPLE_PROFIL`
     (le workflow refuse un profil qui vise une autre application) ;
   - clé de l'API App Store Connect, rôle *Developer* : contenu du `.p8`
     dans `APPLE_CLE_API`, son identifiant dans `APPLE_CLE_API_ID`,
     l'émetteur dans `APPLE_EMETTEUR_API` ;
   - variable `APPLE_EQUIPE` : l'identifiant d'équipe à dix caractères.
4. **Notifications poussées** (facultatives : sans elles, l'application se
   construit et relève la cloche de chaque panel) :
   - compte Expo de l'éditeur, projet `gamedashboard` ; son identifiant
     (UUID) dans la variable `EXPO_PROJET` ;
   - dans le projet Expo, *Push notifications* : activer la **sécurité
     renforcée**, déposer la clé APNs (`.p8`, Apple Developer › Keys,
     *Apple Push Notifications service*) et la clé du compte de service
     FCM v1 de Firebase ;
   - créer le jeton d'accès Expo : il ne va **que** dans `env/api.env`
     (`EXPO_ACCESS_TOKEN`) du relais de l'éditeur, jamais dans GitHub ;
   - Firebase : application Android `fr.gamedashboard.app`, son
     `google-services.json` en base64 dans le secret `GOOGLE_SERVICES_JSON` ;
   - Apple : cocher *Push Notifications* sur l'identifiant d'application,
     puis régénérer le profil (`APPLE_PROFIL`) ;
   - variable `RELAIS_NOTIFICATIONS` : l'origine du relais de l'éditeur
     (`https://…`), plusieurs séparées par des virgules ;
   - sur le relais : `PUSH_RELAY=1` et `EXPO_ACCESS_TOKEN` dans
     `env/api.env`. Les panels auto-hébergés posent `PUSH_RELAY_URL` à la
     même origine.

### Chaque version

```bash
git tag mobile-v1.0.0 && git push origin mobile-v1.0.0
```

Le workflow rejoue la CI, attend l'approbation de l'environnement
`magasins`, puis construit les deux applications. Le numéro de construction
est celui de l'exécution : il ne fait que croître, comme l'exigent les
magasins. Android se construit sur le runner habituel, dans le conteneur
Linux ; iOS sur un runner macOS de GitHub, seule exception à cette règle.
Un APK signé par la clé de débogage n'est jamais livré.

Chaque binaire est attesté avec son inventaire CycloneDX :

```bash
gh attestation verify gamedashboard-mobile-1.0.0.aab --repo SysMath/PowerDashboard
```

### Ce qui protège les clés

Les secrets n'existent que dans les jobs de l'environnement `magasins`,
jamais pour une PR, et n'atteignent un script que par une variable
d'environnement. Dans le conteneur Android, la clé d'envoi n'est donnée
qu'à la commande qui signe (`GD_LINUX_TRANSMETTRE`, `infra/ci/linux.sh`),
écrite hors du dépôt et effacée en sortie ; sous macOS, le certificat vit
dans un trousseau jetable, détruit même en échec. Le code des dépendances
tourne dans le conteneur où l'application se signe : c'est le cas de toute
construction, et la signature par Google Play et la publication à la main
bornent ce qu'une clé volée permettrait.
