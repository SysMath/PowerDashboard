# Module WHMCS pour GameDashboard

Provisionne les serveurs de jeu et fait entrer vos clients dans le panel.

## Ce qu'il fait

- **Une commande payée** crée le compte client dans le panel, puis son serveur.
- **Un impayé** suspend le serveur ; le paiement le rétablit. Les fichiers
  restent en place dans les deux cas.
- **Une résiliation** supprime le serveur et ses fichiers.
- **Le bouton « Gérer mon serveur »** de l'espace client ouvre le panel avec la
  session du client déjà ouverte.

Vos clients n'ont **pas** de mot de passe sur le panel, et n'en auront jamais.
Ils s'authentifient ici, chez vous. La page de connexion du panel reste
réservée à votre équipe et aux personnes qu'un client invite sur son serveur.

## Installation

1. Copiez le dossier dans votre installation WHMCS :

   ```
   modules/servers/gamedashboard/
   ```

   Il doit contenir `gamedashboard.php`, `GameDashboardClient.php` et
   `clientarea.tpl`.

2. **Créez le champ personnalisé** sur chaque produit qui emploie ce module :

   *Setup → Products/Services → votre produit → Custom Fields*

   | Réglage | Valeur |
   | --- | --- |
   | Field Name | `GameDashboard Server ID` |
   | Field Type | Text Box |
   | Admin Only | coché |

   Le module y range l'identifiant du serveur. **Sans ce champ, la création
   fonctionne mais la suspension et la résiliation ne trouveront rien** — le
   module l'écrit alors dans le journal (*Utilities → Module Log*) au lieu
   d'échouer en silence, mais le serveur devra être rattaché à la main.

   Cochez *Admin Only* : cet identifiant ne regarde pas le client, et un champ
   modifiable par lui deviendrait un moyen de désigner le serveur d'autrui.

3. Dans le panel, ouvrez **Administration → Clés applicatives** et créez une clé
   avec ces portées, et pas davantage :

   | Portée | Pourquoi |
   | --- | --- |
   | `users.read` | retrouver un client déjà connu |
   | `users.write` | créer son compte à la commande |
   | `users.sso` | ouvrir sa session depuis votre espace client |
   | `servers.create` | créer le serveur |
   | `servers.suspend` | suspendre sur impayé |
   | `servers.delete` | supprimer à la résiliation |
   | `servers.owner` | donner le serveur au client actuel après un déplacement de service |

   `users.sso` est séparée de `users.write` à dessein : modifier une fiche et
   **entrer dans le compte** ne sont pas la même autorité. Si vous n'employez
   pas le bouton de connexion, ne l'accordez pas.

   La clé n'est montrée qu'une fois. Restreignez-la à l'adresse IP de votre
   serveur WHMCS si vous le pouvez.

4. **Setup → Products/Services → Servers → Add New Server** :

   | Champ | Valeur |
   | --- | --- |
   | Hostname | le nom d'hôte du panel, par exemple `panel.exemple.fr` |
   | Type | GameDashboard |
   | Access Hash | votre clé applicative |
   | Secure | coché |

   Renseignez le **nom d'hôte**, pas l'adresse IP : un certificat TLS répond
   d'un nom. Le module ne désactive jamais la vérification du certificat —
   votre clé voyage dans l'en-tête de chaque requête.

   Cliquez **Test Connection** : le module vérifie l'adresse, la clé **et** les
   portées, sans rien créer.

5. Sur chaque produit, onglet *Module Settings*, réglez l'egg à installer et les
   ressources — ou l'identifiant d'un plan du panel, qui les décide à leur place.

6. Dans le panel, **Réglages → Facturation et connexion des clients**,
   choisissez `WHMCS` et renseignez l'adresse de votre espace client. La page de
   connexion du panel cessera alors de se présenter comme le chemin de vos
   clients, et les y renverra.

## Changement de client d'un service

WHMCS ne prévient aucun module quand un service est déplacé vers un autre
client (*Move Product/Service*) : le serveur resterait à l'ancien titulaire,
qui garderait sa console, et le nouveau client ne le verrait pas.

Après un déplacement, ouvrez la fiche du service et cliquez **Donner le serveur
au client actuel**. Le module retrouve ou crée le compte du client qui porte
maintenant le service, puis lui donne le serveur ; le panel retire les
sous-utilisateurs, les invitations et les rappels sortants du serveur,
renouvelle les mots de passe des bases et ferme les sessions SFTP et consoles
de l'ancien titulaire et des invités. Si une base garde son ancien mot de passe
(hôte injoignable) ou si le node n'a pas pu fermer une session, le serveur est
quand même transféré et le bouton affiche ce qui reste à faire au lieu de
« success ».
Recliquer ne fait rien de plus.

Il faut la portée `servers.owner`. Une clé créée avant cette version ne l'a
pas : créez-en une nouvelle, le bouton échoue sinon en nommant la portée.

## Reprise d'un parc existant

Si vos clients ont déjà un compte sur le panel, le module les **rattache** au
lieu d'en créer un second : il cherche d'abord votre identifiant client WHMCS,
puis l'adresse e-mail, et n'en crée un que s'il ne trouve rien.

## Échéances sur l'accueil du panel (facultatif)

Le panel peut aussi **lire** les services de chaque client et leurs échéances,
pour les montrer sur son accueil et prévenir dans la cloche avant une
suspension. Il n'écrit jamais rien chez vous.

1. **Setup → Staff Management → Manage API Credentials** : créez des
   identifiants liés à un rôle qui n'autorise que `GetClientsDetails` et
   `GetClientsProducts`.
2. **Setup → General Settings → Security → API IP Access Restriction** :
   ajoutez l'adresse IP du panel. Sans elle, WHMCS refuse chaque appel.
3. Dans le panel, **Réglages → Facturation et connexion des clients** :
   adresse de l'API `https://votre-whmcs/includes/api.php`, identifiant et
   secret, puis **Tester la liaison**.

## Ce qui a été éprouvé

Le module tourne dans un banc (`tests/module-logic.php`) qui le fait dialoguer
avec un **panel de poche servi en HTTP**. Rien n'y est remplacé : le module et
son client d'API sont exécutés tels qu'ils sont livrés, en-têtes, encodage JSON,
codes de statut et clés d'idempotence compris. Ces cas y passent :

- client inconnu : le compte est créé **avant** le serveur ;
- reprise de parc : un compte existant est rattaché, jamais dupliqué ;
- client déjà connu : ni création ni rattachement ;
- la création rend exactement `'success'` — pas `true`, pas un tableau ;
- l'identifiant du serveur est rangé dans le champ personnalisé ;
- suspension sans serveur rattaché : refus explicite, **jamais un faux succès** ;
- suspension normale : le bon serveur ;
- résiliation d'un serveur déjà supprimé : réussit, sinon le service resterait
  facturable ;
- test de connexion : tableau, verdict juste, portées manquantes nommées ;
- clé refusée : le message nomme la clé plutôt qu'un code HTTP ;
- champ personnalisé absent : la création réussit et le journal le dit ;
- ouverture de session : le triplet `success` / `redirectTo` / `errorMsg` ;
- sans domaine, le serveur est nommé par son numéro et jamais « other » ;
- le bouton de l'espace client pointe vers l'adresse `dosinglesignon=1` ;
- le bouton « Donner le serveur au client actuel » : compte du client actuel,
  puis transfert du serveur et `'success'` ; sans serveur rattaché, un message
  et aucun appel ; clé sans `servers.owner`, un refus qui la nomme.

Le client d'API a par ailleurs été exécuté contre un panel **réel**.

Les noms de paramètres, les valeurs de retour et le déclenchement du SSO ont
été relus sur la documentation officielle
(<https://developers.whmcs.com/provisioning-modules>), ce qui a corrigé trois
suppositions : l'identifiant du client se lit dans `$params['userid']` et non
dans `clientsdetails`, `producttype` ne porte pas le nom du produit mais son
genre (`other`), et l'ouverture de session se déclenche par l'adresse
`dosinglesignon=1` plutôt que par un bouton personnalisé qui redirigerait
lui-même.

Ce banc ne prouve pas ce que WHMCS met réellement dans `$params` à l'exécution :
seule une première installation le confirmera.

## Revendeurs

**Un revendeur peut brancher sa propre boutique**, avec sa propre installation
de WHMCS et ce module.

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

**« Module Command Error » sans détail** — regardez *Utilities → Module Log*,
qui porte le vrai message.

**« Le panel est injoignable »** — nom d'hôte faux, ou votre serveur WHMCS ne
peut pas sortir. Essayez `curl https://…/api/v1/status` depuis le serveur WHMCS.

**« Le panel a refusé la clé applicative »** — clé fausse, révoquée, ou
restreinte à une autre adresse IP. Vérifiez qu'elle est bien dans *Access Hash*.

**« Il lui manque des portées »** — le test de connexion nomme lesquelles. Les
portées d'une clé ne se modifient pas : créez-en une nouvelle.

**« Aucun serveur GameDashboard n'est rattaché à ce service »** — le champ
personnalisé manquait à la création. Créez-le, puis renseignez-y l'identifiant
du serveur, visible dans le panel.

**« Aucun compte ne correspond »** au moment du bouton de connexion — le compte
n'a pas été créé, donc la commande n'est pas passée par ce module. Le panel
refuse d'ouvrir une session pour un client qu'il ne connaît pas : c'est
délibéré, rien n'apparaît dans le panel qui n'ait été commandé.

**« Ce compte appartient au personnel du panel »** — vous avez rattaché un
compte administrateur à une fiche client. Une clé applicative ne peut pas ouvrir
une session d'administrateur, et cela ne se contourne pas.
