# 0008 — Le pare-feu par serveur est tenu par un agent séparé, qui tire ses règles du panel et les pose dans sa propre table nftables

- **État** : proposée
- **Date** : 2026-09
- **Références** : PLAN §5.3, §5.5, §6.5 (`firewall_rules`), §9 (`/server/[id]/network`),
  §10.3 ; [ADR 0001](./0001-wings-conserve.md) et son amendement,
  [ADR 0005](./0005-machine-muette.md) ; `packages/db/src/schema/infrastructure.ts`
  (`allocations`), `apps/api/src/modules/remote/remote-server.service.ts`
  (`allocations.mappings` rendu à Wings), `packages/contracts/src/wings-node-config.ts`,
  `infra/prod/installer-wings.sh` (étape « Pare-feu »), `docs/installation.md` §2

> Cette ADR est **proposée** : aucune ligne de code ne s'écrit avant que
> Matheo l'accepte et tranche les questions de la dernière section.

## Contexte

Le PLAN promet pour la v2 un « firewall par serveur (nftables sur le node) »
(§10.3), et réserve déjà la table `firewall_rules` (server_id, direction,
protocol, port_range, cidr, action) et un onglet dans `/server/[id]/network`.
Le besoin côté client est simple à dire : bannir une adresse qui inonde un
serveur, ou n'ouvrir un serveur privé qu'à quelques adresses.

Quatre contraintes rendent la question non triviale.

1. **Wings ne sait pas filtrer, et on ne le modifie pas** (ADR 0001). Il
   publie chaque allocation par Docker, en TCP **et** en UDP, sur l'adresse
   exacte de l'allocation (`allocations.mappings`, clé = IP, valeur = ports).
   Il n'a aucune route pour poser une règle réseau, et son jeton donne déjà
   tout pouvoir sur la machine (PLAN §5.5) : on ne lui ajoute rien.
2. **Docker contourne le pare-feu de l'hôte.** Un port publié est réécrit
   (DNAT) dans `PREROUTING` puis passe par `FORWARD`, jamais par `INPUT`. Une
   règle `ufw deny` ou une chaîne `INPUT` n'a donc **aucun effet** sur un
   serveur de jeu. C'est aussi vrai aujourd'hui : le conseil
   « `ufw allow 25565` » de `installer-wings.sh` et de `docs/installation.md`
   est inoffensif mais inutile, le port est joignable avec ou sans lui.
3. **Docker est en train de changer de moteur.** Jusqu'ici il écrit ses
   règles par `iptables` (le plus souvent `iptables-nft`, donc des tables
   `ip filter` / `ip nat` gérées par la couche de compatibilité). Docker
   Engine 29 propose un moteur nftables natif (`"firewall-backend":
   "nftables"`, encore expérimental), qui crée ses propres tables et **n'a
   plus de chaîne `DOCKER-USER`**. Une solution accrochée aux chaînes de
   Docker casserait au changement de moteur ; installer-wings.sh installe la
   dernière version de Docker, donc ce changement viendra sans prévenir.
4. **Le panel ne se connecte jamais aux machines.** Aujourd'hui, c'est Wings
   qui appelle le panel (`/api/remote/*`) et le panel qui appelle Wings par
   son API ; il n'a ni accès SSH, ni compte sur l'hôte. Le panel peut en
   outre tourner sur un hébergement cPanel mutualisé (Passenger, pas de
   processus de fond hors de l'API, entrée par `PANEL_ORIGIN` et le relais
   `API_RELAY`).

## Décision

**Un petit agent, installé à côté de Wings sur chaque node qui veut le
pare-feu, tire périodiquement du panel les règles de ses serveurs, les
valide, et les pose de façon atomique dans une table nftables qui lui
appartient seule (`inet gamedashboard`), en amont de la réécriture d'adresse
de Docker.** Il ne touche jamais aux tables de Docker ni à celles de
l'exploitant, et il ne filtre que le trafic destiné à une allocation.

### Ce que voit l'utilisateur

Onglet **Réseau › Pare-feu** de `/server/[id]/network` :

- **Politique par défaut** du serveur : « Tout autoriser » (valeur initiale,
  donc aucun changement pour les serveurs existants) ou « Tout refuser sauf
  les règles ».
- **Règles ordonnées**, la première qui correspond l'emporte :
  action (autoriser / refuser), source (une adresse ou un bloc CIDR, IPv4 ou
  IPv6, ou « toute adresse »), protocole (TCP, UDP ou les deux), port
  (un port ou une plage **pris parmi les allocations du serveur**, ou
  « tous mes ports »), et une note libre.
- **État d'application**, dit honnêtement comme en ADR 0005 : « appliqué »,
  « en attente » (la machine n'a pas encore relevé la révision), « machine
  sans pare-feu » (aucun agent sur ce node : les règles sont gardées, pas
  appliquées), « agent muet depuis … ».
- **Limites** : 64 règles par serveur, CIDR validé et normalisé (pas
  d'adresse d'hôte dans un bloc : `10.0.0.5/24` est refusé, pas corrigé),
  aucun port hors des allocations du serveur, pas d'autre protocole que TCP
  et UDP. Un bannissement coupe aussi les connexions déjà ouvertes (la règle
  vaut pour chaque paquet, pas seulement pour les nouvelles connexions) :
  c'est ce qu'on attend quand on bannit un joueur qui inonde le serveur.
- **Droits** : deux permissions de serveur, `firewall.read` et
  `firewall.update`, rangées dans le preset « Owner » et attribuables à un
  sous-utilisateur ; chaque modification est consignée au journal
  d'activité avec l'avant et l'après. L'administration voit et modifie tout,
  et peut couper la fonction par node.

La direction est **entrante seulement**. La colonne `direction` du PLAN
reste, pour ne pas fermer la porte au filtrage sortant (question 4).

### Ce que pose l'agent

Une table à lui, rechargée d'un bloc par `nft -f` (une transaction : l'ancien
jeu reste en place jusqu'à ce que le nouveau soit accepté en entier) :

```nft
table inet gamedashboard {
  # (protocole . adresse de l'allocation . port) → chaîne du serveur
  map alloc4    { type inet_proto . ipv4_addr . inet_service : verdict; }
  map alloc6    { type inet_proto . ipv6_addr . inet_service : verdict; }
  # allocations sur 0.0.0.0 : toute adresse locale
  map alloc_tout { type inet_proto . inet_service : verdict; }

  chain entree {
    # Avant le DNAT de Docker (priorité -100) : la destination est encore
    # l'allocation telle que le panel la connaît.
    type filter hook prerouting priority -150; policy accept;
    meta l4proto != { tcp, udp } accept
    meta nfproto ipv4 meta l4proto . ip daddr . th dport vmap @alloc4
    meta nfproto ipv6 meta l4proto . ip6 daddr . th dport vmap @alloc6
    fib daddr type local meta l4proto . th dport vmap @alloc_tout
  }

  chain srv_1a2b3c4d {                     # un serveur (préfixe de son UUID)
    ip saddr 198.51.100.7 drop             # règle 1 : refuser
    ip6 saddr 2001:db8:42::/48 accept      # règle 2 : autoriser
    drop                                   # politique « tout refuser »
  }                                        # (absente si « tout autoriser »)
}
```

Pourquoi ce placement :

- **Avant le DNAT, dans la chaîne `prerouting`** : on filtre sur l'adresse et
  le port de l'allocation, exactement ce que le panel stocke, sans avoir à
  deviner l'adresse du conteneur ni à relire `ct original`.
- **Une table séparée** : nftables évalue toutes les chaînes de base
  accrochées au même point, table par table. Un `drop` chez nous est
  définitif quoi que fassent Docker, `ufw` ou `firewalld` ; un `accept` chez
  nous n'ouvre rien qu'un autre aurait fermé. Docker ne vide que ses propres
  tables, il ne touche pas la nôtre, et cela vaut pour ses deux moteurs.
- **`goto` par la table de verdicts** : une recherche en temps constant quel
  que soit le nombre de serveurs ; la fin d'une chaîne de serveur retombe sur
  la politique `accept` de la chaîne de base.
- **Famille `inet`** : une seule table pour IPv4 et IPv6.
- **Rien d'autre n'est filtré** : SSH, l'API de Wings (8080), le SFTP (2022),
  le port 80 du certificat ne passent jamais par une chaîne de serveur. En
  plus, l'agent lit le `config.yml` de Wings et la configuration de `sshd`,
  et **refuse** toute allocation qui tomberait sur l'un de ces ports : même
  un panel compromis ne peut pas fermer la machine à son exploitant.

### Liaison avec le panel

- **Tiré, jamais poussé.** L'agent appelle `GET /api/node-agent/firewall`
  sur `PANEL_ORIGIN` (en-tête `If-None-Match` sur la révision, relevé toutes
  les 15 s, plus un appel immédiat au démarrage), puis rend compte de la
  révision appliquée (`POST /api/node-agent/firewall/applied`). Aucun port
  à ouvrir sur la machine, aucun nouvel appel sortant du panel, et le même
  chemin marche derrière cPanel : le préfixe `/api/node-agent/` s'ajoute au
  vhost `infra/prod/panel.conf` **et** au relais `apps/web/src/server/api-relay.ts`
  (règle de concordance existante).
- **Ce que le panel envoie** : des **données**, pas un script. La liste des
  allocations du node (adresse, port, serveur) et, par serveur, la politique
  et les règles. L'agent valide tout (types, CIDR, bornes, ports interdits)
  et rend lui-même le texte nftables à partir d'un gabarit fixe. Le panel ne
  peut donc exprimer qu'un filtrage d'entrée sur des ports d'allocation.
- **Un jeton propre à l'agent**, distinct de celui de Wings : une fuite de
  l'un ne donne pas l'autre. Il ne donne droit qu'à lire les règles de son
  node et à rendre compte. Le panel n'en garde qu'une empreinte (SHA-256) :
  contrairement au jeton de Wings (PLAN §5.5), le panel n'a jamais à le
  présenter, il peut donc être affiché une seule fois. Rotation depuis
  Administration › Nodes, comme le jeton de Wings.
- **Moindre privilège sur la machine** : service systemd à utilisateur
  dédié, `AmbientCapabilities=CAP_NET_ADMIN` et rien d'autre
  (`NoNewPrivileges`, `ProtectSystem=strict`, écriture seulement dans
  `/var/lib/gamedashboard-agent`, lecture de `/etc/pterodactyl/config.yml`).
  Il parle à nftables par netlink, sans lancer de shell.

### Mode de défaillance : « dernier état connu », jamais fermé

| Situation | Effet sur les serveurs de jeu |
|---|---|
| Panel injoignable, agent en vie | Les règles en place restent. L'agent réessaie. Le panel affiche « agent muet » passé 2 min. |
| Réponse du panel invalide | Rejetée en entier, les règles en place restent, l'erreur remonte au prochain compte rendu. |
| Agent arrêté ou planté | La table reste dans le noyau : les règles restent appliquées. |
| Redémarrage de la machine | Le service recharge le dernier jeu validé (`/var/lib/gamedashboard-agent/regles.nft`), `Before=docker.service` : aucun conteneur ne publie de port avant que les règles soient posées. |
| Redémarrage de Docker | Sans effet : notre table n'est pas la sienne. |
| Agent désinstallé | Le paquet supprime la table : retour à l'état d'aujourd'hui, tout ouvert. |
| Coupure d'urgence | `gamedashboard-agent desactiver` supprime la table sur-le-champ. |

Fermer tout en cas de doute couperait **tous** les joueurs d'un node à la
moindre panne du panel : pire que la menace qu'on traite. Ouvrir tout en cas
de doute effacerait un bannissement au premier redémarrage. Le dernier état
validé est le seul choix qui ne punit ni l'un ni l'autre.

### Le modèle de données

- `firewall_rules` telle que le PLAN la décrit, plus `position` (ordre) et
  `note` ; `port_range` en deux entiers `port_start`/`port_end`, `cidr` en
  type `cidr` de PostgreSQL (disponible en 9.6, donc sur l'hébergement
  cPanel) ; `direction` limitée à `in` pour l'instant.
- `servers.firewall_default` (`accept` | `drop`, défaut `accept`).
- `node_agents` : node, empreinte du jeton, version de l'agent, dernier
  appel, révision appliquée, dernière erreur. Sa présence **est** la capacité
  « pare-feu » du node ; personne ne coche une case qui pourrait mentir.
- Une révision par node, incrémentée à chaque changement de règle,
  d'allocation, de politique, ou de transfert de serveur (les règles
  appartiennent au serveur et le suivent d'un node à l'autre).
- Le catalogue d'API (`api-catalogue.ts`) reçoit les routes client et admin ;
  l'API applicative n'en a pas besoin en v2 (question 5).

## Options écartées

- **Ne rien faire et documenter le pare-feu de l'hôte.** Ne tient pas
  techniquement : `ufw` et la chaîne `INPUT` ne voient pas les ports publiés
  par Docker (contexte, point 2). Il faudrait apprendre à chaque exploitant
  la chaîne `DOCKER-USER`, qui disparaît avec le moteur nftables de Docker ;
  et le client n'aurait toujours rien dans le panel. Reste valable pour ce
  qui n'est pas « par serveur » (SSH, 8080, 2022) : ça reste le travail de
  l'exploitant et de `installer-wings.sh`.
- **Pousser les règles par SSH depuis le panel** (ou par le script
  d'installation rejoué). Le panel détiendrait une clé root sur chaque
  machine : un pouvoir plus large que le jeton de Wings, pour poser trois
  règles. Impossible depuis cPanel (pas de processus de fond, sortie SSH
  souvent filtrée). Et un changement ne s'appliquerait que quand le panel
  arrive à joindre la machine, sans état vérifiable.
- **Agent qui écoute** (le panel pousse sur un port de l'agent). Un port et
  un secret de plus exposés sur chaque node, une règle d'entrée de plus à
  ouvrir, et le panel sur cPanel ne peut pas initier d'appel fiable vers
  toutes les machines. Tirer depuis l'agent coûte au plus 15 s de latence.
- **S'accrocher aux chaînes de Docker** (`DOCKER-USER`, ou règles après DNAT
  sur `ct original daddr`). `DOCKER-USER` n'existe qu'avec le moteur
  iptables de Docker, et c'est une chaîne que Docker crée et peut recréer ;
  écrire dans ses tables, c'est se faire effacer ou effacer Docker au
  prochain redémarrage de l'un des deux.
- **Réseaux Docker par serveur avec leurs propres règles** : demanderait de
  changer la façon dont Wings crée ses conteneurs, donc de modifier Wings
  (ADR 0001).
- **Pare-feu de l'hébergeur par son API** (OVH, Hetzner, Scaleway…). Un
  connecteur par fournisseur, des quotas de règles bas, rien pour une
  machine chez soi ; l'agent marche partout où il y a un noyau Linux.
- **Des règles nftables rendues en texte par le panel et appliquées telles
  quelles** : agent plus simple, mais un panel compromis pourrait alors
  écrire n'importe quelle règle, y compris fermer SSH. L'agent qui valide des
  données et rend son propre gabarit borne ce que le panel peut faire.

## Conséquences

- **Un deuxième logiciel sur les machines de jeu**, le premier qui vienne de
  nous. Il a sa version, ses releases (archive signée et empreinte dans
  `release.yml`, comme le panel), sa mise à jour (`installer-wings.sh` le
  pose et le met à jour quand on le relance, option `--pare-feu`). Il est
  **facultatif** : un node sans agent marche comme aujourd'hui, et l'écran
  le dit.
- **La surface d'attaque change peu** : l'agent n'écoute rien, n'a que
  `CAP_NET_ADMIN`, et ne sait écrire que des filtres d'entrée sur des ports
  d'allocation. Le pire qu'un panel compromis puisse lui faire faire est
  bloquer les ports des serveurs de jeu, ce que le jeton de Wings permet
  déjà (arrêter les conteneurs). Le modèle de menace
  (`docs/securite/modele-de-menace.md`) reçoit l'agent comme nouvel actif.
- **Le relais cPanel et le vhost** reçoivent le préfixe `/api/node-agent/`
  (le test de concordance l'exige), avec un `limit_req` propre.
- **IPv6** : couvert par la famille `inet` dès le départ. Une allocation
  IPv6 filtre en `ip6` ; une allocation `0.0.0.0` ne publie, chez Docker,
  qu'en IPv4 ; le banc doit le confirmer sur Docker 29.
- **Docs à corriger en même temps** : `docs/installation.md` et
  `installer-wings.sh` laissent croire qu'`ufw` protège les ports de jeu.
- **Tests** :
  - panel : validation des règles (Zod dans `contracts`), permissions,
    révision incrémentée à chaque cause, rendu de la réponse à l'agent,
    concordance du relais, tests d'intégration sur PostgreSQL (9.6 compris :
    type `cidr`) ;
  - agent : tests de gabarit (données → texte attendu), refus des ports
    interdits et des données invalides, vérification de syntaxe par
    `nft -c -f` dans un espace de noms réseau jetable (`unshare -rn`) en CI ;
  - banc réel `infra/local/verifier-pare-feu.sh` : Wings + Docker + agent,
    un serveur démarré, un refus puis une autorisation vérifiés depuis un
    autre espace de noms, en IPv4 et IPv6, après `systemctl restart docker`,
    après redémarrage de la machine, **avec les deux moteurs de Docker**
    (iptables-nft et nftables). Comme les autres bancs, il ne tourne pas en
    session distante ; un runner Ubuntu hébergé (root et Docker) le peut.
- **Déploiement** : migration additive (rien ne change tant qu'aucune règle
  n'existe), panel d'abord, agent ensuite node par node ; l'onglet reste
  gris sur un node sans agent. Retour arrière : désinstaller l'agent.
- **À revoir si** Docker publie ses ports autrement qu'en DNAT (par exemple
  un proxy en espace utilisateur pour tout), si Wings gagne un filtrage
  natif, ou si l'on veut du filtrage sortant ou de la limitation de débit,
  qui demandent une chaîne `forward` et une autre discussion.

## Questions ouvertes pour Matheo

1. **Accepter l'architecture** : agent séparé qui tire ses règles, table
   `inet gamedashboard` en `prerouting` avant le DNAT, défaillance « dernier
   état connu ». *Recommandé.*
2. **Langage de l'agent** : Go (binaire statique de quelques Mo, rien à
   installer sur la machine, bibliothèque netlink `google/nftables`, même
   chaîne d'outils que Wings) *recommandé*, ou TypeScript (même langage que
   le reste, mais Node à installer sur chaque node ou un exécutable Node
   autonome d'environ 100 Mo).
3. **Qui a le droit** : permissions `firewall.*` données au propriétaire et
   attribuables aux sous-utilisateurs *recommandé*, ou réservées à
   l'administration et aux revendeurs.
4. **Filtrage sortant** (empêcher un conteneur de joindre le réseau interne
   de l'hébergeur, PLAN §5.3) : hors de cette ADR *recommandé*, à traiter
   dans une suivante, ou à inclure dès maintenant.
5. **API applicative** : laisser la facturation poser des règles (par
   exemple une liste d'adresses autorisées vendue en option), ou non en v2
   *recommandé*.
6. **Limitation de débit par source** (`limit rate`, anti-inondation
   simple) : plus tard *recommandé*, ou dès la première version.
