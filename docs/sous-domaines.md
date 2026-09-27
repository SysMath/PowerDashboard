# Sous-domaines des serveurs

Chaque client peut donner à son serveur une adresse du type
`survie.jeux.exemple.fr`. Le panel la publie dans une zone DNS Cloudflare, la
tient à jour quand l'adresse du serveur change, et la retire avec lui
(PLAN §10.3). Wings n'est pas concerné : tout se passe entre le panel et
Cloudflare.

## Régler la zone

Administration › Paramètres › **Sous-domaines des serveurs** :

1. **Fournisseur DNS** : Cloudflare.
2. **Domaine des serveurs** : le nom sous lequel les sous-domaines se créent,
   par exemple `jeux.exemple.fr`. Il doit être la zone elle-même ou l'un de ses
   sous-domaines.
3. **Identifiant de zone** : « Zone ID », dans la colonne de droite de la page
   d'accueil du domaine chez Cloudflare.
4. **Jeton d'API** : créé sous *My Profile › API Tokens › Create Token*, avec
   les droits **Zone › DNS › Edit** et **Zone › Zone › Read**, limité à cette
   seule zone. Jamais la clé globale du compte. Il est chiffré en base, lié à
   sa ligne, et n'est jamais relu par l'écran.
5. **Noms réservés** : ceux que les clients ne peuvent pas prendre, en plus de
   la liste du panel (`www`, `mail`, `panel`, `api`, `status`, `support`…).
   Y ajouter ce que l'hébergeur emploie déjà ou compte employer sous ce
   domaine : le panel refuse un nom que la zone porte déjà, pas un nom qu'elle
   portera demain.

Enregistrer, puis **Tester la zone** : le panel lit la zone avec le jeton,
vérifie que le domaine en fait partie et qu'il peut lire les enregistrements
DNS. Rien n'est écrit : le droit d'**écrire** ne s'éprouve qu'à la première
publication, et un jeton en lecture seule passe l'essai.

Mieux vaut un domaine distinct de celui du panel (`jeux.exemple.fr` à côté de
`panel.exemple.fr`, voire un domaine à part) : les noms choisis par les clients
ne se mêlent pas alors à ceux de l'hébergeur.

## Ce que le panel publie

Le client choisit son libellé dans l'écran **Réseau** du serveur. Le panel
refuse un nom réservé, un nom déjà pris par un autre serveur, et un nom que la
zone porte déjà (un site, un service posé à la main) : il ne remplace jamais
un enregistrement qu'il n'a pas créé.

| Adresse du port principal | Enregistrement |
| --- | --- |
| IPv4 (ou alias IPv4) | `A` |
| IPv6 | `AAAA` |
| Nom d'hôte (alias, ou nom du node quand le port écoute sur `0.0.0.0`) | `CNAME` |

Une adresse privée (réseau local, boucle, CGNAT, lien local, ULA) n'est jamais
publiée : la carte le dit au client, et le nom attend que le serveur reçoive
une adresse publique.

Un jeu que le panel reconnaît comme Minecraft Java (même règle que la sonde de
jeu : `game_query` de l'egg, sinon le nom de l'egg ; Bedrock exclu) reçoit en
plus `_minecraft._tcp.<nom>` en `SRV` : ses joueurs saisissent le nom seul. Les
autres jeux ne lisent pas le SRV, leurs joueurs saisissent le nom et le port.

Les enregistrements ne sont jamais relayés par le proxy de Cloudflare (il ne
transporte que du HTTP), durent 60 secondes, et portent la note
`GameDashboard, serveur <uuid>`. Cette note sert aussi au panel : un
enregistrement de même nom et de même type qui la porte est **repris** plutôt
que refusé (création dont la réponse s'est perdue, zone recréée avec copie de
ses enregistrements). Ne pas la poser à la main sur autre chose.

## Ce qui les tient à jour

- Changer de port principal ou terminer un transfert republie tout de suite,
  sans attendre la réponse de Cloudflare ; au plus une fois par minute et par
  serveur, le dernier changement de la minute étant publié à sa fin.
- Supprimer un serveur ou retirer son sous-domaine retire ses enregistrements.
  La ligne `server_subdomains` survit à la suppression du serveur tant qu'ils
  ne sont pas retirés : c'est elle qui sait lesquels retirer.
- Un balayage, toutes les cinq minutes, compare ce qui est publié à ce qui
  devrait l'être et rattrape le reste : zone en panne, port modifié par
  l'administration, egg changé. Il n'appelle Cloudflare que pour ce qui diffère.
- Changer de domaine ou de zone dans les réglages déménage les noms aux
  balayages suivants (cinquante par tour : mille noms prennent une centaine de
  minutes), **seulement si la nouvelle zone répond** et contient le
  domaine : une faute de frappe laisse les noms en place, en échec, jusqu'à
  correction. Le nouveau nom est publié avant que l'ancien soit retiré. Un nom
  déjà pris sous le nouveau domaine par un autre serveur est abandonné ; un
  nom que la nouvelle zone porte déjà (posé à la main) reste en échec et
  l'ancien nom continue de répondre.
- Pour changer de zone, le plus simple est un jeton valable sur l'ancienne et
  la nouvelle le temps d'un balayage. Avec un jeton limité à la nouvelle, les
  enregistrements de l'ancienne sont **oubliés** (le journal de l'API le dit) :
  à retirer à la main chez Cloudflare.
- Passer le fournisseur à « Aucun » arrête tout suivi, retraits compris :
  retirer d'abord les sous-domaines, ou nettoyer la zone ensuite.

Un échec s'affiche sur la carte du client dans une phrase à lui (nom déjà
employé, adresse non publique, zone indisponible), et se retente au balayage
suivant. Le détail donné par Cloudflare ne va qu'au journal de l'API, jeton
masqué ; le jeton lui-même doit n'être fait que de lettres, chiffres, `-` et
`_`, et le panel refuse le reste à l'enregistrement.

## Limites

Cloudflare admet 1 200 requêtes par tranche de 5 minutes **pour tout le
compte**. Un changement de nom en coûte jusqu'à huit pour Minecraft, cinq
sinon ; une première prise, six ou quatre ; un nom refusé parce que la zone le
porte déjà, deux. Chaque essai compte, réussi ou non. Le panel refuse donc
(HTTP 429) :

- plus d'un essai de nom (choix ou retrait) par minute pour un même serveur ;
- un nouveau nom tant que l'ancien n'est pas retiré de la zone ;
- plus de vingt essais par minute sur toute la plateforme (800 requêtes par
  5 minutes au plus, le reste pour le balayage).

Ce plafond est commun : un compte qui essaie des noms sur vingt serveurs à la
fois fait patienter les autres une minute.

Les republications (port principal changé, transfert conclu) n'entrent pas dans
ce plafond : elles sont bornées par serveur, une par minute (en général une
seule modification, deux pour Minecraft). Un compte à cent serveurs peut donc
en demander jusqu'à cent par minute, s'il change sans arrêt leur port
principal : la charge croît avec le nombre de serveurs payés, pas avec
l'insistance d'un client. Retirer un nom resté en échec coûte deux lectures de
plus : le panel y cherche un enregistrement créé dont la réponse s'est perdue.

Le balayage traite au plus cinquante noms par tour. Ces compteurs sont tenus
en mémoire : l'API tourne en un seul processus (production, cPanel) ; à
plusieurs, chacun aurait sa propre part.
