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
