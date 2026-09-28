# Module ClientXCMS pour GameDashboard

Provisionne les serveurs de jeu et fait entrer vos clients dans le panel.

Pour ClientXCMS **Next Gen** (la réécriture sous Laravel). La v1 emploie un
autre système d'extensions et n'est pas couverte.

## Ce qu'il fait

- **Une commande payée** crée le compte client dans le panel, puis son serveur.
- **Un impayé** suspend le serveur ; le paiement le rétablit. Les fichiers
  restent en place dans les deux cas.
- **Une expiration** supprime le serveur et ses fichiers.
- **Le bouton « Gérer mon serveur »** de l'espace client ouvre le panel avec la
  session du client déjà ouverte.

Vos clients n'ont **pas** de mot de passe sur le panel, et n'en auront jamais.
Ils s'authentifient ici, chez vous. La page de connexion du panel reste
réservée à votre équipe et aux personnes qu'un client invite sur son serveur.

## Installation

1. Copiez le dossier dans votre installation :

   ```
   modules/gamedashboard/
   ```

2. Dans le panel, ouvrez **Administration → Clés applicatives** et créez une clé
   avec ces portées, et pas davantage :

   | Portée | Pourquoi |
   | --- | --- |
   | `users.read` | retrouver un client déjà connu |
   | `users.write` | créer son compte à la commande |
   | `users.sso` | ouvrir sa session depuis votre espace client |
   | `servers.create` | créer le serveur |
   | `servers.suspend` | suspendre sur impayé |
   | `servers.delete` | supprimer à l'expiration |
   | `servers.owner` | donner le serveur au nouveau client quand un service change de titulaire |

   `users.sso` est séparée de `users.write` à dessein : modifier une fiche et
   **entrer dans le compte** ne sont pas la même autorité. Si vous n'employez
   pas le bouton de connexion, ne l'accordez pas.

   La clé n'est montrée qu'une fois. Restreignez-la à l'adresse IP de votre
   serveur ClientXCMS si vous le pouvez.

3. **Administration → Extensions**, activez *GameDashboard*.

4. **Administration → Serveurs**, ajoutez un serveur de type *GameDashboard* :

   | Champ | Valeur |
   | --- | --- |
   | Nom d'hôte | celui du panel, par exemple `panel.exemple.fr` |
   | Mot de passe | votre clé applicative |

   Renseignez le **nom d'hôte**, pas l'adresse IP : un certificat TLS répond
   d'un nom. Le module ne désactive jamais la vérification du certificat —
   votre clé voyage dans l'en-tête de chaque requête. Elle est stockée dans le
   champ mot de passe parce que ClientXCMS l'y chiffre.

   Le bouton de test vérifie l'adresse, la clé **et** les portées, sans rien
   créer.

5. Créez un produit de type *GameDashboard* et réglez l'egg à installer ainsi
   que les ressources — ou l'identifiant d'un plan du panel, qui les décide à
   leur place.

6. Dans le panel, **Réglages → Facturation et connexion des clients**,
   choisissez `ClientXCMS` et renseignez l'adresse de votre espace client. La
   page de connexion du panel cessera alors de se présenter comme le chemin de
   vos clients, et les y renverra.

## Reprise d'un parc existant

Si vos clients ont déjà un compte sur le panel, le module les **rattache** au
lieu d'en créer un second : il cherche d'abord votre identifiant client, puis
l'adresse e-mail, et n'en crée un que s'il ne trouve rien.

## Changement de titulaire d'un service

Quand un service change de client dans ClientXCMS, le module retrouve ou crée
le compte du nouveau client dans le panel, puis **lui donne le serveur**. Le
panel efface au passage ce que l'ancien titulaire avait installé autour :
sous-utilisateurs et invitations, rappels sortants, mots de passe des bases
(renouvelés), sessions SFTP et consoles ouvertes ; son journal n'est plus
visible que de l'administration. Si une base garde son ancien mot de passe
(hôte injoignable) ou si le node n'a pas pu fermer une session, le changement
réussit quand même et son message le dit. Un service dont le serveur
n'a pas encore été livré n'a rien à transférer : seul le compte est préparé.

Il faut pour cela la portée `servers.owner`. Une clé créée avant cette version
ne l'a pas, et les portées d'une clé ne se modifient pas : créez-en une
nouvelle. Sans elle, le changement échoue en nommant la portée manquante, et
rien n'est transféré.

## Ce que ce module ne fait pas

Le changement de mot de passe, les options additionnelles et l'import de
services existants ne sont pas surchargés : ils gardent le comportement par
défaut de ClientXCMS.

## Échéances sur l'accueil du panel (facultatif)

Le panel peut aussi **lire** les services de chaque client et leurs échéances,
pour les montrer sur son accueil et prévenir dans la cloche avant une
suspension. Il n'écrit jamais rien chez vous.

1. Dans l'administration de ClientXCMS, créez une clé d'API limitée aux
   capacités `customers:index`, `customers:show` et `services:index`.
2. Dans le panel, **Réglages → Facturation et connexion des clients** :
   adresse de l'API = l'adresse de votre site ClientXCMS, identifiant laissé
   vide, clé = le jeton, puis **Tester la liaison**.

## Ce qui a été éprouvé

Le module tourne dans un banc (`modules/gamedashboard/tests/module-logic.php`)
qui redéclare le minimum de classes ClientXCMS dont il dépend, puis exécute le
module tel qu'il sera livré. Seize cas y passent :

- client inconnu : le compte est créé **avant** le serveur ;
- reprise de parc : un compte existant est rattaché, jamais dupliqué ;
- client déjà connu : ni création ni rattachement ;
- l'identifiant du serveur est rangé dans les données du service ;
- suspension sans serveur rattaché : refus explicite, **jamais un faux succès** ;
- suspension normale : le bon serveur ;
- expiration d'un serveur déjà supprimé : succès, sinon le service resterait
  facturable ;
- test de connexion : verdict juste, portées manquantes nommées ;
- le lien de connexion est émis pour le **titulaire** du service ;
- changement de titulaire : compte du nouveau client, puis transfert du
  serveur ; transfert direct vers un client déjà connu ; rien à transférer
  sans serveur livré ; clé sans `servers.owner` ou serveur absent du panel :
  échec explicite, jamais un faux succès.

Le client d'API a par ailleurs été exécuté contre un panel **réel**.

Le contrat implémenté — `ServerTypeInterface`, `AbstractServerType`,
`ServiceStateChangeDTO`, `ConnectionResponse`, les champs de `Service` et de
`Server` — a été relu dans les dépôts publics de ClientXCMS, et non supposé.

Ce banc ne prouve pas le comportement de Laravel à l'exécution : seule une
première installation le confirmera.

## Une remarque sur la licence

Le code source de ClientXCMS porte une licence qui réserve l'usage commercial :
« any use in a project that generates profit […] requires prior authorization
from CLIENTXCMS ». Ce module **ne contient aucune ligne de leur code** — il
implémente leurs interfaces, ce qui est l'objet même de leur système
d'extensions, et ils proposent d'ailleurs de soumettre des extensions. Si votre
usage est commercial, la question à leur poser porte sur ClientXCMS lui-même,
pas sur ce module.

## Revendeurs

**Un revendeur peut brancher sa propre boutique**, avec sa propre installation
de ClientXCMS et ce module.

Il émet lui-même sa clé depuis son espace, sans passer par la plateforme :
**Espace revendeur → Clés applicatives**. La clé est alors **bornée à son
périmètre** — le champ n'est pas un formulaire qu'il remplit, c'est sa session
qui le fixe.

Concrètement, une clé de revendeur :

- ne voit que **ses** clients, c'est-à-dire ceux qui possèdent au moins un
  serveur qu'il héberge ;
- ne peut ni lire, ni suspendre, ni supprimer le serveur d'un autre ;
- ne crée ou ne donne un serveur qu'à un compte client entièrement à lui,
  ou à un compte encore sans serveur ; jamais au client d'un autre, même
  partagé, ni à un compte suspendu, du personnel, ou encore sans serveur et
  invité chez un autre (son propre client invité ailleurs reçoit) ;
- ne modifie la fiche que d'un client entièrement à lui : l'identifiant
  externe d'un client partagé est celui de l'autre facturation ;
- ne peut pas ouvrir de session au nom d'un client qui n'est pas le sien ;
- ne peut pas s'accorder les portées de la plateforme — les enveloppes de
  revente et la configuration d'un node lui sont refusées **à l'émission**,
  pas au premier appel.

Le rattachement se lit sur les serveurs, et c'est voulu : un compte
n'appartient à personne, ce sont ses serveurs qui relèvent d'un revendeur. Un
client tout neuf, créé à la commande mais pas encore servi, n'est donc à
personne — sa session s'ouvrira au premier serveur livré. On refuse trop,
jamais trop peu.

Le lien de connexion porte aussi le **domaine du revendeur** quand celui-ci en
a déclaré un et l'a fait vérifier : le client arrive chez la marque qu'il
connaît, et non chez la plateforme.

## Dépannage

**« Aucun serveur GameDashboard n'est configuré pour ce produit »** — le produit
n'est rattaché à aucun serveur de ce type.

**« Le panel a refusé la clé applicative »** — clé fausse, révoquée, ou
restreinte à une autre adresse IP. Vérifiez qu'elle est dans le champ mot de
passe du serveur.

**« Il lui manque des portées »** — le test de connexion nomme lesquelles. Les
portées d'une clé ne se modifient pas : créez-en une nouvelle.

**« Aucun serveur GameDashboard n'est rattaché à ce service »** — la création
n'a pas abouti, ou le service a été créé avant l'installation du module.
Renseignez `gamedashboard_server_id` dans les données du service.

**« Aucun compte ne correspond »** au moment du bouton de connexion — le compte
n'a pas été créé, donc la commande n'est pas passée par ce module. Le panel
refuse d'ouvrir une session pour un client qu'il ne connaît pas : c'est
délibéré, rien n'apparaît dans le panel qui n'ait été commandé.
