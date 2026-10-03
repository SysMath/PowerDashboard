# Politique de confidentialité de l'application GameDashboard

*English version below.*

Cette page décrit ce que fait de vos données l'application mobile
GameDashboard, publiée sur l'App Store et Google Play. Elle est aussi
accessible depuis l'application : bouton « Politique de confidentialité ».

## Qui fait quoi

- **L'éditeur** publie l'application sous ses comptes de développeur. Il ne
  gère aucun serveur de jeu et ne détient aucun de vos comptes.
- **Le panel** auquel vous reliez l'application est exploité par votre
  hébergeur, ou par vous-même. C'est lui qui détient votre compte, vos
  serveurs, leurs fichiers et leurs journaux, et sa propre politique de
  confidentialité s'applique à ces données. L'application ne fait que lui
  parler, comme le ferait votre navigateur.

## Ce que l'éditeur ne collecte pas

- Aucun compte chez l'éditeur.
- Aucune statistique d'usage, aucune mesure d'audience, aucun rapport de
  plantage.
- Aucune publicité, aucun pistage, aucun identifiant publicitaire.
- Aucune vente ni aucun partage de données à des fins commerciales.

## Ce qui reste sur votre téléphone

- La liste des panels reliés (leur adresse et leur nom) et le secret de
  chaque liaison, dans le trousseau du système, lisibles seulement par ce
  téléphone et téléphone déverrouillé.
- Une clé propre à chaque liaison, créée dans la puce de sécurité du
  téléphone (Secure Enclave ou Keystore), qui n'en sort jamais.
- Les fichiers que vous téléchargez depuis un serveur, dans un dossier
  temporaire vidé au téléchargement suivant.

La biométrie (visage, empreinte) est vérifiée par le système :
l'application ne reçoit qu'une réponse « accepté » ou « refusé », jamais
votre visage ni votre empreinte. Le trousseau et la clé ne partent dans
aucune sauvegarde du téléphone.

## Ce qui va au panel que vous reliez

- À la liaison : le nom choisi pour le téléphone (modifiable avant
  l'envoi), sa plateforme (iOS ou Android), la version de l'application et
  la partie publique de sa clé.
- Ensuite, ce que vous faites dans l'application, comme sur le site du
  panel : démarrer un serveur, lire sa console, envoyer un fichier…
- Comme pour toute connexion, le panel voit l'adresse IP du téléphone.

Votre mot de passe ne passe jamais par l'application : vous vous connectez
dans le navigateur du téléphone, sur le site du panel. Vous pouvez retirer
le téléphone à tout moment depuis le panel (Compte › Sécurité ›
Application mobile) ou depuis l'application (« Délier ce téléphone »).

## Caméra

La caméra ne sert qu'à lire le code QR affiché par le panel. Aucune image
n'est enregistrée ni envoyée.

## Notifications poussées

Seulement si votre panel en envoie et si vous les autorisez sur le
téléphone. Elles passent par le service Expo Push (Expo, 650 Industries,
Inc.) puis par celui de la plateforme : Apple Push Notification service sur
iOS, Firebase Cloud Messaging de Google sur Android.

- **Ce qu'une notification contient** : le type d'événement (un serveur
  arrêté, une sauvegarde terminée…), le nom du serveur (64 caractères au
  plus), l'identifiant de la notification et celui du panel. Jamais
  d'adresse, de contenu de console, de fichier ni de détail de sécurité. Le
  texte affiché est fixe et rédigé par l'application.
- **Le jeton de notification** du téléphone, délivré par Expo, va :
  - soit au panel lui-même, quand celui-ci envoie directement ;
  - soit au relais de notifications de l'éditeur. Le relais garde le jeton
    et le panel auquel il est rattaché, pour pouvoir lui transmettre les
    notifications de ce panel, et ne donne au panel qu'une poignée dont il
    ne garde que l'empreinte. Il efface le jeton dès qu'Expo le dit périmé,
    par exemple quand l'application est désinstallée.
- Couper les notifications dans les réglages du téléphone, ou délier le
  téléphone (« Délier ce téléphone » dans l'application), fait oublier au
  panel le jeton ou la poignée : il ne vous écrit plus.

## Vos droits

Vos données de compte et de serveurs sont tenues par le panel : pour les
consulter, les corriger ou les effacer, adressez-vous à son exploitant.
Désinstaller l'application efface tout ce qu'elle gardait sur le téléphone.

Pour une question sur cette politique, ou sur le relais de notifications de
l'éditeur, écrivez à l'adresse de contact indiquée sur la fiche de
l'application dans le magasin.

## Changements

Cette politique est versionnée avec le code de l'application : son
historique est celui de ce fichier dans le dépôt.

---

# GameDashboard app privacy policy

This page describes what the GameDashboard mobile app, published on the App
Store and Google Play, does with your data. It is also reachable from the
app: the “Privacy policy” button.

## Who does what

- **The publisher** publishes the app under its developer accounts. It runs
  no game server and holds none of your accounts.
- **The panel** you link the app to is run by your host, or by yourself. It
  holds your account, your servers, their files and their logs, and its own
  privacy policy applies to that data. The app only talks to it, as your
  browser would.

## What the publisher does not collect

- No account with the publisher.
- No usage statistics, no analytics, no crash reports.
- No advertising, no tracking, no advertising identifier.
- No sale or sharing of data for commercial purposes.

## What stays on your phone

- The list of linked panels (their address and name) and the secret of
  each link, in the system keychain, readable only by this phone and only
  while it is unlocked.
- A key for each link, created in the phone's security chip (Secure Enclave
  or Keystore), which never leaves it.
- Files you download from a server, in a temporary folder emptied at the
  next download.

Biometrics (face, fingerprint) are checked by the system: the app only gets
an “accepted” or “refused” answer, never your face or fingerprint. The
keychain and the key are left out of any phone backup.

## What goes to the panel you link

- When linking: the name chosen for the phone (editable before it is sent),
  its platform (iOS or Android), the app version and the public part of its
  key.
- Then, what you do in the app, as on the panel's website: starting a
  server, reading its console, uploading a file…
- As with any connection, the panel sees the phone's IP address.

Your password never goes through the app: you sign in in the phone's
browser, on the panel's website. You can remove the phone at any time from
the panel (Account › Security › Mobile app) or from the app (“Unlink this
phone”).

## Camera

The camera is only used to read the QR code shown by the panel. No image is
saved or sent.

## Push notifications

Only if your panel sends them and you allow them on the phone. They go
through the Expo Push service (Expo, 650 Industries, Inc.), then through the
platform's service: Apple Push Notification service on iOS, Google's
Firebase Cloud Messaging on Android.

- **What a notification contains**: the kind of event (a server stopped, a
  backup finished…), the server name (64 characters at most), the
  notification's identifier and the panel's. Never an address, console
  output, file or security detail. The text shown is fixed and written by
  the app.
- **The phone's push token**, issued by Expo, goes:
  - either to the panel itself, when it sends directly;
  - or to the publisher's notification relay. The relay keeps the token and
    the panel it belongs to, so as to pass that panel's notifications on,
    and only gives the panel a handle of which it keeps only the hash. It
    deletes the token as soon as Expo reports it stale, for example when
    the app is uninstalled.
- Turning notifications off in the phone's settings, or unlinking the
  phone (“Unlink this phone” in the app), makes the panel forget the token
  or the handle: it no longer writes to you.

## Your rights

Your account and server data is held by the panel: to see, correct or erase
it, contact whoever runs it. Uninstalling the app erases everything it kept
on the phone.

For any question about this policy, or about the publisher's notification
relay, write to the contact address shown on the app's store listing.

## Changes

This policy is versioned with the app's code: its history is the history of
this file in the repository.
