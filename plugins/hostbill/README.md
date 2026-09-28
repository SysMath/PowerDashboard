# Module HostBill pour GameDashboard

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

1. Copiez le dossier dans votre installation HostBill :

   ```
   includes/modules/Server/gamedashboard/
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
   | `servers.delete` | supprimer à la résiliation |

   `users.sso` est séparée de `users.write` à dessein : modifier une fiche et
   **entrer dans le compte** ne sont pas la même autorité. Si vous n'employez
   pas le bouton de connexion, ne l'accordez pas.

   La clé n'est montrée qu'une fois. Restreignez-la à l'adresse IP de votre
   serveur HostBill si vous le pouvez.

3. Dans HostBill, **Settings → Modules → Server modules**, activez
   *GameDashboard*, puis créez un serveur avec l'adresse du panel et la clé.
   Cliquez **Test connection** : le module vérifie l'adresse, la clé **et** les
   portées, sans rien créer.

4. Sur chaque produit, réglez l'egg à installer et les ressources — ou
   l'identifiant d'un plan du panel, qui les décide à leur place.

5. Dans le panel, **Réglages → Facturation et connexion des clients**,
   choisissez `HostBill` et renseignez l'adresse de votre espace client. La page
   de connexion du panel cessera alors de se présenter comme le chemin de vos
   clients, et les y renverra.

## Reprise d'un parc existant

Si vos clients ont déjà un compte sur le panel, le module les **rattache** au
lieu d'en créer un second : il cherche d'abord votre identifiant client, puis
l'adresse e-mail, et n'en crée un que s'il ne trouve rien.

## Changement de client d'un service

Ce module ne transfère pas le serveur quand un service change de client dans
HostBill : le serveur reste à l'ancien titulaire. Faites alors le geste dans le
panel, sur la fiche du serveur dans l'administration (changement de
propriétaire), ou par l'API applicative : `POST
/api/v1/application/servers/{serveur}/owner` avec `{"ownerId": "…"}` et une clé
portant `servers.owner`. Dans les deux cas, le panel retire les
sous-utilisateurs, les invitations et les rappels sortants du serveur,
renouvelle les mots de passe des bases et ferme les sessions SFTP et consoles
de l'ancien titulaire et des invités. Ce qui n'a pas pu être fait est rendu :
à l'écran d'administration, ou dans `data.cleanup` de la réponse de l'API
(`databasesNotRotated`, `sessionsNotClosed`).

## Échéances sur l'accueil du panel (facultatif)

Le panel peut aussi **lire** les services de chaque client et leurs échéances,
pour les montrer sur son accueil et prévenir dans la cloche avant une
suspension. Il n'écrit jamais rien chez vous.

1. **Settings → Security → API access** : créez un accès limité à
   `getClients`, `getClientDetails` et `getClientAccounts`, restreint à
   l'adresse IP du panel.
2. Dans le panel, **Réglages → Facturation et connexion des clients** :
   adresse de l'API `https://votre-hostbill/admin/api.php`, identifiant et
   clé, puis **Tester la liaison**.

## Ce qui a été éprouvé

Le client d'API (`includes/GameDashboardClient.php`) a été exécuté contre un
panel réel : création de compte, idempotence d'un rejeu, recherche par
identifiant externe, émission du lien de connexion, et les refus — client
inconnu, compte du personnel, clé sans la bonne portée.

Le module lui-même tourne dans un banc (`tests/module-logic.php`) qui simule la
classe parente et le client d'API. Sept cas y passent : ordre des gestes,
rattachement d'un parc existant, refus de suspendre sans serveur rattaché,
résiliation d'un serveur déjà absent, format du lien de connexion, et refus
lorsqu'aucune adresse e-mail n'est lisible.

Les noms de champs et le contrat du SSO ont été relus sur la documentation de
l'API HostBill (<https://api2.hostbillapp.com/>), ce qui a corrigé trois points :

- **l'adresse e-mail n'est pas dans les détails du compte.** `getAccountDetails`
  rend le nom, le prénom et la société, mais pas l'adresse : elle appartient à
  la fiche client. Le module la demande donc via `ApiWrapper`, la façon dont un
  module HostBill atteint l'API localement ;
- **le SSO rend un lien, il ne redirige pas.** L'appel `accountModuleSSO`
  « déclenche la méthode SSO du module » et répond `{"success": true, "link":
  "…"}`. Une première version posait un en-tête `Location` et sortait par
  `exit`, ce qui aurait rendu une page blanche à l'API ;
- **l'identifiant du service est `id`**, pas `service_id`.

Ce qui reste supposé : l'écart éventuel entre ce que l'API documente et ce que
HostBill passe réellement au module dans `$this->details`. Les variantes
connues sont acceptées, et tous ces accès restent regroupés dans
`hostbillValue()`. Si quelque chose se comporte mal à la première installation,
c'est presque certainement là.

## Revendeurs

**Un revendeur peut brancher sa propre boutique**, avec sa propre installation
de HostBill et ce module.

Il émet lui-même sa clé depuis son espace, sans passer par la plateforme :
**Espace revendeur → Clés applicatives**. La clé est alors **bornée à son
périmètre** — le champ n'est pas un formulaire qu'il remplit, c'est sa session
qui le fixe.

Concrètement, une clé de revendeur :

- ne voit que **ses** clients, c'est-à-dire ceux qui possèdent au moins un
  serveur qu'il héberge, et les comptes que sa boutique a créés ;
- ne peut ni lire, ni suspendre, ni supprimer le serveur d'un autre ;
- ne crée ou ne donne un serveur qu'à un compte client entièrement à lui,
  ou à un compte encore sans serveur **que sa boutique a créé** ; jamais au
  client d'un autre, même partagé, ni à un compte inscrit de lui-même ou
  ouvert par l'administration, ni à un compte suspendu, du personnel, ou
  encore sans serveur et invité chez un autre (son propre client invité
  ailleurs reçoit). Un client qui existe déjà dans le panel sans être à ce
  revendeur se rattache depuis l'administration, en lui donnant un serveur
  de ce revendeur ;
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

**« Le panel est injoignable »** — l'adresse est fausse, ou votre serveur
HostBill ne peut pas sortir vers le panel. Essayez `curl https://…/api/v1/status`
depuis le serveur HostBill.

**« Le panel a refusé la clé applicative »** — clé fausse, révoquée, ou
restreinte à une autre adresse IP.

**« Il lui manque des portées »** — le test de connexion nomme lesquelles.
Créez une nouvelle clé : les portées d'une clé existante ne se modifient pas.

**« Aucun compte ne correspond »** au moment du bouton de connexion — le compte
n'a pas été créé, ce qui signifie que la commande n'est pas passée par ce
module. Le panel refuse d'ouvrir une session pour un client qu'il ne connaît
pas : c'est délibéré, rien n'apparaît dans le panel qui n'ait été commandé.

**« Ce compte appartient au personnel du panel »** — vous avez rattaché un
compte administrateur à une fiche client. Une clé applicative ne peut pas ouvrir
une session d'administrateur, et cela ne se contourne pas.
