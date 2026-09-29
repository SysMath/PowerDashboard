# 0009 — Les instantanés portent sur tout le système de fichiers des serveurs d'un node, pris et restaurés par l'agent du node, sans toucher au répertoire que Wings gère

- **État** : proposée
- **Date** : 2026-09
- **Références** : PLAN §5.5, §6.5 (`backups`), §10.3 ; [ADR 0001](./0001-wings-conserve.md)
  et son amendement, [ADR 0005](./0005-machine-muette.md),
  [ADR 0008](./0008-pare-feu-nftables.md) (agent du node) ;
  `packages/db/src/schema/features.ts` (`backups`),
  `apps/api/src/modules/client/backups.service.ts` (état `restoring`),
  `apps/api/src/modules/remote/sftp-auth.service.ts` (SFTP fermé pendant
  `restoring`), `infra/prod/installer-wings.sh`, `docs/installation.md` ;
  Wings v1.13.3 : `server/manager.go`, `server/filesystem/filesystem.go`
  (`TruncateRootDirectory`), `router/router_server.go` (suppression),
  `router/router_transfer.go`, `environment/docker/power.go`
  (`OnBeforeStart`), `internal/ufs/fs_unix.go` (`safePath`)

> Cette ADR est **proposée** : aucune ligne de code ne s'écrit avant que
> Matheo l'accepte et tranche les questions de la dernière section.

## Contexte

Le PLAN promet pour la v2 des « snapshots de volumes (btrfs/zfs) pour
backups instantanés » (§10.3). Le besoin côté client : revenir en quelques
secondes à l'état d'avant une mise à jour de modpack, un greffon qui corrompt
le monde, une fausse manipulation dans le gestionnaire de fichiers, sans
attendre qu'une archive de plusieurs gigaoctets se télécharge depuis S3 et se
décompresse.

Les sauvegardes d'aujourd'hui ne le permettent pas, et ce n'est pas leur
rôle. Wings lit le dossier du serveur **pendant qu'il tourne** et l'écrit en
`tar.gz` (localement ou vers S3 par liens signés) : c'est lent, chaque
sauvegarde coûte la taille entière du serveur, et l'archive n'est même pas
cohérente au sens d'un arrêt brutal, puisque les fichiers changent pendant
qu'on les lit. En échange, elle quitte la machine, ce qu'un instantané ne
fera jamais.

Quatre contraintes cadrent la réponse.

1. **Wings ne sait rien des instantanés, et on ne le modifie pas**
   (ADR 0001). Il n'a aucune route pour en prendre ou en restaurer. Il range
   chaque serveur dans `system.data/<uuid>` (par défaut
   `/var/lib/pterodactyl/volumes/<uuid>`), qu'il monte dans le conteneur, et
   il **gère lui-même le cycle de vie de ce dossier** :
   - à la création, il le crée comme un simple dossier (`os.MkdirAll`,
     `server/filesystem/filesystem.go`) ;
   - à une restauration de sauvegarde avec « supprimer les fichiers
     existants », il le supprime entièrement puis le recrée
     (`TruncateRootDirectory` : `os.RemoveAll` puis `os.Mkdir`) ;
   - à la suppression du serveur, il le supprime (`os.RemoveAll`,
     `router/router_server.go`), comme au bout d'un transfert
     (`router/router_transfer.go`).
2. **Le panel ne se connecte jamais aux machines** (ADR 0008, contexte 4) :
   ni SSH, ni compte sur l'hôte, et il peut tourner sur un hébergement cPanel
   sans processus de fond.
3. **Les machines existantes sont en ext4 ou XFS.** btrfs et ZFS
   demandent de préparer le disque ; la fonction ne peut être que
   **facultative**, node par node.
4. **Plusieurs clients partagent un node.** Un instantané ne doit jamais
   donner à l'un les fichiers d'un autre, ni lui permettre de remplir le
   disque de tous.

## Décision

**Le dossier `system.data` de Wings est, sur un node qui le veut, un seul
sous-volume btrfs ou un seul dataset ZFS. L'agent du node (ADR 0008) en prend
des instantanés en lecture seule, du système de fichiers entier, sur ordre du
panel et selon une cadence réglée par node. Restaurer un serveur, c'est
recopier son seul sous-dossier depuis l'instantané vers son dossier vivant,
serveur arrêté, sans jamais remplacer ni recréer ce dossier.** Les
sauvegardes de Wings, locales ou S3, restent inchangées et restent la seule
copie hors de la machine.

### Pourquoi le système de fichiers entier, et pas un volume par serveur

Un sous-volume (ou un dataset) par serveur semble plus naturel : instantané,
quota et suppression par serveur. Mais c'est Wings qui crée, vide et supprime
`volumes/<uuid>`, et il le fait comme un dossier ordinaire (contexte, point 1) :

- un serveur neuf naît en dossier simple ; il faudrait le « convertir » en
  sous-volume, donc déplacer ses fichiers, serveur arrêté, à chaque serveur ;
- une restauration de sauvegarde « en vidant » remplace silencieusement le
  sous-volume btrfs par un dossier simple (plus aucun instantané possible),
  et échoue sur ZFS (`os.RemoveAll` ne peut pas supprimer un point de
  montage : `EBUSY`), donc casse une fonction qui marche aujourd'hui ;
- une suppression ou un transfert laisse le dataset ZFS et ses instantanés
  derrière lui, sans que personne ne le sache.

Chacun de ces cas se contourne, mais seulement en courant après Wings à
chaque version. Avec un seul système de fichiers pour tout `system.data`,
**Wings ne voit que des dossiers ordinaires, comme aujourd'hui** : rien de ce
qu'il fait n'est changé, rien de ce qu'il fera ne peut nous surprendre.

### Ce que voit l'utilisateur

Un onglet **Instantanés** à côté de **Sauvegardes**, jamais mélangé avec
elles, parce que ce n'est pas la même promesse :

- **La liste** des instantanés du node qui contiennent ce serveur :
  automatiques (« toutes les heures, gardés 24 h », « tous les jours, gardés
  7 jours », selon le réglage du node), manuels, et « de sûreté » (pris juste
  avant une restauration). Chaque ligne dit sa date et sa cause.
- **« Prendre un instantané »** : pris dans les 15 secondes (relevé de
  l'agent), en une fraction de seconde sur la machine, quelle que soit la
  taille du serveur.
- **« Épingler »** : l'instantané échappe à la rotation automatique, dans la
  limite du serveur et jamais au-delà de la durée maximale du node
  (question 7).
- **« Restaurer »** : le serveur s'arrête, son dossier revient exactement à
  l'état de l'instantané (fichiers ajoutés depuis supprimés, fichiers
  modifiés rendus), puis il reste arrêté. Un instantané de sûreté est pris
  juste avant : **une restauration se défait**.
- **L'avertissement, écrit dans l'onglet** : « Un instantané vit sur le même
  disque que votre serveur. Il ne remplace pas une sauvegarde. »
- **État d'application**, comme en ADR 0005 et 0008 : « machine sans
  instantanés » (pas d'agent, ou `system.data` n'est ni btrfs ni ZFS : la
  fonction est grisée), « agent muet depuis … », « espace disque
  insuffisant : instantanés suspendus ».
- **Droits** : `snapshots.read`, `snapshots.create`, `snapshots.restore`,
  rangées dans le preset « Owner », attribuables aux sous-utilisateurs
  (question 4) ; chaque action consignée au journal d'activité.
  L'administration voit tout, règle la cadence, la rétention et le seuil
  d'espace libre par node, et peut couper la fonction par node.

### Ce que fait l'agent

- **Prendre** : btrfs, `btrfs subvolume snapshot -r <system.data>
  <dossier des instantanés>/gd-<horodatage>` ; ZFS, `zfs snapshot
  <dataset>@gd-<horodatage>`. Atomique pour tout le node : chaque serveur y
  est dans l'état d'un arrêt brutal au même instant, ce que le `tar` de Wings
  ne donne pas. L'agent rend compte au panel des dossiers `<uuid>` que
  l'instantané contient : le panel ne propose un instantané qu'aux serveurs
  qui y figurent **et** qui sont toujours sur ce node.
- **Regrouper** : les demandes manuelles arrivées dans la même minute
  partagent un seul instantané. Cent clients qui cliquent en même temps font
  un instantané, pas cent.
- **Restaurer** un serveur, sur ordre du panel, seulement quand Wings le
  donne arrêté :
  1. instantané de sûreté du node (même mécanisme, cause « sûreté ») ;
  2. vider le **contenu** de `volumes/<uuid>`, puis y recopier
     `<instantané>/<uuid>/` en conservant propriétaires, droits, dates et
     liens symboliques tels quels (jamais suivis). Sur btrfs, la copie se
     fait par clonage d'extents (`cp -a --reflink=always`) : rien n'est
     réellement copié, quelques secondes même pour un gros monde. Sur ZFS,
     c'est une vraie copie depuis `.zfs/snapshot/`, à la vitesse du disque,
     sauf si le clonage de blocs d'OpenZFS (≥ 2.2) est activé ;
  3. rendre compte (réussite, ou erreur et étape). L'opération est
     **rejouable** : si elle échoue au milieu, la rejouer vide et recopie à
     nouveau, et l'instantané de sûreté garde l'état d'avant.

  Le dossier `volumes/<uuid>` lui-même (son inode) **n'est jamais supprimé,
  recréé ni renommé** : c'est la seule chose que Wings, son SFTP et Docker
  connaissent, et elle ne change pas. On ne s'appuie donc sur aucun détail
  interne de Wings. (Au passage, Wings v1.13.3 rouvre la racine du serveur à
  chaque opération de fichier, `internal/ufs/fs_unix.go` `safePath`, et
  recrée le conteneur à chaque démarrage, `environment/docker/power.go`
  `OnBeforeStart` : même un échange de dossiers marcherait aujourd'hui. On ne
  bâtit pas dessus, ce n'est pas un contrat.)
- **Supprimer et faire tourner** : un instantané est détruit quand la
  rotation du node ne le garde plus **et** qu'aucun serveur ne l'épingle.
  L'agent applique aussi, **de lui-même**, deux gardes que le panel ne peut
  pas lever : aucun instantané au-delà de la durée maximale du node, et plus
  aucun nouvel instantané sous le seuil d'espace libre (15 % par défaut) ;
  sous ce seuil, il détruit d'abord les plus anciens non épinglés et le
  signale.
- **Où les instantanés vivent** : btrfs, sur le même système de fichiers,
  **hors** de `system.data` (un instantané btrfs est un sous-volume du même
  système) ; ZFS, dans le dataset, avec `snapdir=hidden`. Dans les deux cas,
  aucun conteneur ni aucun chemin de Wings n'y mène : un conteneur ne voit
  que `volumes/<uuid>`, le SFTP et le gestionnaire de fichiers de Wings sont
  bornés au même dossier, et `.zfs` n'existe qu'à la racine du dataset, hors
  de tout dossier de serveur.
- **Rien d'autre** : `backup_directory` de Wings (sauvegardes locales) doit
  être **hors** du sous-volume ou du dataset, sans quoi chaque instantané
  retiendrait des archives entières. L'agent le vérifie et refuse de
  s'activer sinon.

### Liaison avec le panel

Même chemin que le pare-feu (ADR 0008), même agent, même jeton :

- **Tiré, jamais poussé** : `GET /api/node-agent/snapshots` (réglages du
  node et ordres en attente : prendre, restaurer tel serveur depuis tel
  instantané, détruire), puis `POST /api/node-agent/snapshots/report`
  (instantanés présents, dossiers qu'ils contiennent, taille quand ZFS la
  donne, espace libre, résultat de chaque ordre). Aucun port ouvert sur la
  machine ; le préfixe `/api/node-agent/`, que l'ADR 0008 ajoute au vhost et
  au relais cPanel, suffit.
- **Des données, pas des commandes** : un ordre porte un identifiant, un
  type fermé, un UUID de serveur et un nom d'instantané. L'agent vérifie le
  format de l'UUID, que `volumes/<uuid>` existe, et que le nom désigne un
  instantané qu'il a lui-même créé (préfixe `gd-`). Il ne reçoit jamais de
  chemin. Chaque ordre est idempotent : rejoué, il ne refait rien de plus.
- **Restauration orchestrée par le panel** : état `restoring` du serveur
  (déjà utilisé par les sauvegardes, NC-44 : démarrage, gestionnaire de
  fichiers et nouvelles connexions SFTP refusés), arrêt demandé à Wings par
  son API habituelle, ordre donné à l'agent seulement quand Wings rapporte
  le serveur arrêté ; sinon l'opération est abandonnée et le serveur rendu.

### Le modèle de données (esquisse)

- `volume_snapshots` : node, nom donné par l'agent, prise, cause
  (`auto` | `manuel` | `surete`), serveurs contenus (`uuid[]`), taille
  (ZFS seulement), état, expiration.
- `volume_snapshot_pins` : serveur, instantané, libellé, auteur ; sa
  présence est l'épinglage.
- `servers.snapshot_limit` : nombre d'instantanés épinglés (question 5).
- Réglages par node : cadence, rétention, durée maximale, seuil d'espace
  libre. La capacité « instantanés » du node est **rapportée par l'agent**
  (btrfs, ZFS ou rien), jamais cochée à la main.
- Le catalogue d'API (`api-catalogue.ts`) reçoit les routes client et admin.
  Rien dans l'API applicative en v2 (question 5), et **rien qui touche à la
  facturation** : la fonction n'a ni prix, ni option vendue dans le panel.

## Effet sur les sauvegardes S3 existantes

- **Rien ne change dans leur fonctionnement** : `BackupsService`, les
  adaptateurs `wings` et `s3`, les liens signés, la rétention, le
  verrouillage et `backup_limit` restent tels quels. Un instantané ne compte
  pas dans `backup_limit` et n'apparaît pas dans la liste des sauvegardes.
- **Les deux se complètent** : l'instantané pour revenir vite en arrière sur
  la même machine, la sauvegarde pour survivre à la perte du disque, de la
  machine ou à une compromission de l'hôte. L'écran et la documentation le
  disent ; aucun réglage ne permet de remplacer l'une par l'autre.
- **Une restauration de sauvegarde gagne un instantané de sûreté** sur un
  node qui en a : on peut défaire une restauration de sauvegarde ratée, ce
  qui n'est pas possible aujourd'hui avec « supprimer les fichiers
  existants ».
- **Les restaurations de sauvegarde ne cassent rien** : `TruncateRootDirectory`
  supprime et recrée un dossier ordinaire dans un système de fichiers
  ordinaire pour Wings ; c'est la raison du choix d'un système de fichiers
  unique.
- **Pas de sauvegarde S3 tirée d'un instantané en v2** : Wings archive
  toujours le dossier vivant et ne peut pas être pointé sur un instantané
  sans modification. Obtenir des archives cohérentes demanderait que l'agent
  produise et téléverse lui-même un `tar.gz` au format que Wings sait
  restaurer (lien signé, `application/x-gzip`) : un second chemin de
  sauvegarde, à traiter plus tard si le besoin se confirme (question 6).
- **Transfert d'un serveur** : ses instantanés restent sur l'ancien node, où
  ils ne peuvent plus servir. Le panel les retire de sa liste à la fin du
  transfert ; ils disparaissent avec la rotation de l'ancien node. Les
  sauvegardes S3, elles, suivent le serveur comme aujourd'hui.

## Sécurité

- **Pas de nouveau pouvoir pour le panel** : le pire qu'un panel compromis
  puisse faire par l'agent est ramener un serveur à un état ancien (défait
  par l'instantané de sûreté) ou détruire des instantanés. Le jeton de Wings
  permet déjà de supprimer tous les fichiers de tous les serveurs.
- **Pas de fuite entre clients** : une restauration ne recopie que
  `<instantané>/<uuid>/` vers `volumes/<uuid>/`, pour l'UUID de l'ordre,
  vérifié ; le panel ne propose un instantané qu'aux serveurs qu'il contient
  et qui sont encore sur ce node ; les liens symboliques sont recopiés, pas
  suivis ; les instantanés ne sont joignables ni depuis un conteneur, ni par
  le SFTP, ni par le gestionnaire de fichiers.
- **Remplissage du disque** : un instantané retient les blocs que les
  serveurs suppriment ou réécrivent. Les gardes sont chez l'agent
  (regroupement par minute, seuil d'espace libre, durée maximale, destruction
  des plus anciens), côté panel une limite d'épinglés par serveur et une
  demande manuelle par serveur toutes les 5 minutes.
- **Privilèges de l'agent** : lire et écrire tous les fichiers de tous les
  serveurs, et piloter btrfs ou ZFS, c'est l'équivalent de root sur ces
  données. La partie « instantanés » tourne donc dans **son propre service
  systemd**, séparé de celui du pare-feu (qui garde `CAP_NET_ADMIN` seul) :
  même binaire, `ProtectSystem=strict`, écriture limitée à `system.data` et
  au dossier des instantanés, `NoNewPrivileges`, aucune écoute réseau. Une
  faille du pare-feu ne donne pas les fichiers, et inversement.
- **Données d'un serveur supprimé** : elles restent dans les instantanés du
  node jusqu'à ce que le dernier qui les contient expire, au plus la durée
  maximale du node (question 7). Un instantané étant en lecture seule (et
  immuable sous ZFS), on ne les en retire pas avant. La politique de
  confidentialité et le modèle de menace (`docs/securite/modele-de-menace.md`)
  le disent.
- **Pas de chiffrement propre** : un instantané a exactement la protection
  du disque où il vit (ADR 0007 : la machine protège le repos).

## Options écartées

- **Un sous-volume btrfs ou un dataset ZFS par serveur.** Écarté pour les
  raisons de la décision : Wings crée, vide, supprime et transfère ce dossier
  comme un dossier ordinaire ; il faudrait le convertir à chaque création,
  on perdrait silencieusement le sous-volume à chaque restauration « en
  vidant » (btrfs) ou on ferait échouer cette restauration (ZFS), et les
  datasets survivraient aux suppressions. Il donnerait la taille des
  instantanés par serveur et l'effacement immédiat à la suppression ;
  c'est le prix du choix, écrit dans les limites.
- **Faire prendre les instantanés par Wings.** Impossible sans le modifier
  (ADR 0001) : il n'a ni route ni crochet pour cela.
- **Changer le montage des conteneurs** (pilote de volume Docker btrfs/ZFS) :
  Wings monte un dossier de l'hôte, pas un volume Docker ; changer cela, c'est
  modifier Wings.
- **Instantanés LVM thin** : ils marchent sous ext4 et XFS, mais au niveau du
  bloc, pour tout le volume logique ; restaurer un serveur demande de monter
  l'instantané, et un pool thin plein fait passer tous les volumes en erreur,
  la pire panne possible pour un node de jeu. Le PLAN vise btrfs et ZFS.
- **Copies par clonage d'extents sous XFS** (`cp --reflink` d'un dossier) :
  pas d'atomicité (les fichiers changent pendant le parcours) et un coût
  proportionnel au nombre de fichiers. Pourrait devenir un repli pour les
  nodes en XFS, plus tard.
- **Des sauvegardes locales de Wings plus fréquentes** : chacune coûte la
  taille entière du serveur, en temps et en disque, et reste incohérente.
- **Restaurer par échange de dossiers** (copier à côté, puis échanger avec
  `renameat2`) : atomique et marche avec Wings v1.13.3, mais seulement parce
  que Wings rouvre la racine à chaque opération ; c'est un détail interne,
  pas un contrat. La recopie dans le dossier vivant n'en dépend pas.
- **Pousser par SSH, ou agent qui écoute** : écartés pour les mêmes raisons
  qu'en ADR 0008.

## Conséquences

- **Dépend de l'agent de l'ADR 0008.** Si l'ADR 0008 était refusée, celle-ci
  apporterait l'agent elle-même, avec les mêmes règles (tiré, jeton propre,
  données validées). Le langage choisi pour l'agent vaut pour les deux.
- **Préparer le disque** : `installer-wings.sh` gagne une option
  `--instantanes` qui vérifie (sans jamais formater) que `system.data` est un
  sous-volume btrfs ou la racine d'un dataset ZFS et que `backup_directory`
  est ailleurs, puis installe le service. `docs/installation.md` décrit la
  préparation d'une machine neuve et le déplacement d'une machine existante
  (Wings arrêté, copie, `config.yml` inchangé si le chemin reste le même).
- **La taille disque vue par le client ne compte pas les instantanés** :
  Wings mesure le dossier vivant ; l'espace que retiennent les instantanés
  est à la charge du node, borné par la rétention et le seuil.
- **Tests** :
  - panel : permissions, ordres et idempotence, un instantané proposé
    seulement aux serveurs qu'il contient et encore sur le node, état
    `restoring` posé et relâché, retrait des instantanés au transfert, tests
    d'intégration PostgreSQL (9.6 compris : `uuid[]`) ;
  - agent : validation des ordres, refus d'un UUID ou d'un nom étranger,
    gardes d'espace et de durée, restauration rejouée après une coupure, sur
    une image btrfs en boucle et un pool ZFS sur fichier (root requis : runner
    Ubuntu hébergé ; ZFS y reste à confirmer) ;
  - banc réel `infra/local/verifier-instantanes.sh` : Wings + Docker +
    agent, un serveur qui écrit, instantané, modification, restauration,
    contenu vérifié octet par octet ; puis une restauration de sauvegarde
    « en vidant », une suppression et un transfert, pour prouver que Wings ne
    voit toujours que des dossiers ordinaires. À rejouer à chaque nouvelle
    version de Wings. Comme les autres bancs, il ne tourne pas en session
    distante.
- **Déploiement** : migration additive, panel d'abord, agent ensuite node par
  node ; l'onglet reste gris ailleurs. Retour arrière : couper le service ;
  les instantanés restent sur le disque jusqu'à ce que l'exploitant les
  détruise (`gamedashboard-agent instantanes purger`).
- **À revoir si** Wings gagne des instantanés natifs ou un crochet autour de
  la création des dossiers, s'il cesse de ranger les serveurs sous
  `system.data/<uuid>`, ou si l'on veut des instantanés facturés à la taille
  par serveur, qui demanderaient un volume par serveur.

## Questions ouvertes pour Matheo

1. **Accepter l'architecture** : un seul sous-volume ou dataset pour tout
   `system.data`, instantanés du node entier, restauration par recopie dans
   le dossier vivant, portée par l'agent de l'ADR 0008. *Recommandé.*
2. **Systèmes pris en charge** : btrfs et ZFS dès la première version
   *recommandé*, ou btrfs seul d'abord.
3. **Cadence** : automatiques par node (toutes les heures gardés 24 h, tous
   les jours gardés 7 jours, réglable) plus manuels par le client
   *recommandé*, ou manuels seulement.
4. **Qui a le droit** : permissions `snapshots.*` au propriétaire,
   attribuables aux sous-utilisateurs *recommandé*, ou réservées à
   l'administration.
5. **Limite par serveur** : `snapshot_limit` (épinglés) réglée par
   l'administration seulement en v2 *recommandé*, ou aussi par l'API
   applicative dès maintenant.
6. **Sauvegardes S3 cohérentes tirées d'un instantané** (l'agent téléverse
   lui-même) : plus tard *recommandé*, ou dès la première version.
7. **Durée maximale d'un instantané, épinglé compris** (donc délai
   d'effacement des données d'un serveur supprimé) : 30 jours *recommandé*,
   ou 7 jours.
