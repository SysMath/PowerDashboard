# Incident de sécurité

**Quand** : un compte est utilisé par quelqu'un d'autre que son titulaire, une
clé ou un jeton a fuité, un `config.yml` a été modifié sans rotation, une
sauvegarde ou un `api.env` s'est retrouvé hors de la machine, ou une machine
est compromise.

**Ce qu'on risque** : deux erreurs opposées. Effacer les traces en voulant
réparer vite, ou laisser la porte ouverte pendant qu'on enquête. L'ordre est
donc toujours le même : **préserver, contenir, comprendre, rétablir,
prévenir**.

## 1. Préserver

Avant de toucher à quoi que ce soit :

```bash
sudo gamedashboard backup      # base + env/ : sessions, clés, journal, tels quels
sudo journalctl -u gamedashboard-api -u gamedashboard-web --since "-7 days" \
  > /root/incident-$(date +%Y%m%d-%H%M).log
```

Copier ces deux fichiers hors de la machine. Le journal d'activité ne se
retouche pas : aucune route n'écrit dedans à la main ni n'en efface de ligne.
C'est la pièce maîtresse, mais seulement s'il reste accessible.

Noter l'heure de début supposée : tout le reste se lit à partir d'elle.

## 2. Contenir

Selon la porte, un geste, parfois plusieurs.

| Ce qui a fuité | Geste | Où |
|---|---|---|
| Compte client ou revendeur | **Suspendre le compte** | Administration › Utilisateurs › le compte |
| Compte d'administration ou de support | Suspendre le compte, depuis un **autre** administrateur | idem |
| Clé d'API d'un client | La révoquer, ou suspendre le compte si le titulaire ne répond pas | Compte › Clés API (titulaire) |
| Clé applicative (facturation, boutique) | **Révoquer**, puis en émettre une nouvelle au système tiers | Administration › Clés applicatives |
| Secret de signature d'un rappel sortant | Le régénérer | Administration › Rappels sortants |
| `config.yml` d'un daemon, jeton de node | [Rotation du jeton de node](./rotation-jeton-node.md) | Administration › Nodes |
| `api.env`, `APP_SECRET_KEY`, sauvegarde **avec** sa clé (`backup.key`), ou archive `.tar` d'avant le chiffrement | [Rotation de la clé maître](./cle-maitre-secrets.md#1-rotation-de-la-clé-maître), puis rotation de **chaque** jeton de node | machine du panel |
| Sauvegarde `.tar.enc` seule, sans sa clé | Rien à rotation : elle ne se lit pas. Vérifier que `backup.key` n'est pas sortie avec elle | — |
| Serveur de jeu utilisé à mauvais escient | Suspendre le serveur | Administration › Serveurs › le serveur |

**Ce que fait la suspension d'un compte**, dès la validation : plus aucune
connexion (mot de passe, clé d'accès, SSO, lien de la facturation), sessions
et consoles fermées, clés d'API et accès SFTP refusés. Ses serveurs
**continuent de tourner** : les suspendre à part s'il le faut. Le dernier
administrateur actif ne peut pas être suspendu.

**Ce qu'elle ne fait pas** : les clés d'API, clés SSH et passkeys du compte
ne sont que **mises en sommeil**. Elles reviennent intactes à la réactivation,
y compris celles que l'intrus aurait ajoutées. Voir l'étape 4.

**Ce qui ne contient rien** :

- `gamedashboard password <email>` ne touche qu'au mot de passe : sessions,
  double authentification et clés d'API **survivent**. C'est une reprise
  d'accès, pas une mise à la porte ;
- « Révoquer toutes les sessions » ferme les sessions, mais pas les clés
  d'API ni le SFTP ;
- supprimer le compte emporte ses sessions, ses clés et ses moyens de
  connexion, c'est-à-dire ce qu'il faut examiner. Suspendre d'abord.

Une fuite de la base seule, sans `api.env`, ne livre ni mot de passe, ni
session, ni clé d'API : ils sont hachés. Les secrets relus par le panel
(jetons de node, secrets TOTP, mots de passe MySQL) sont chiffrés par la clé
maître. Si la base **et** `api.env` sont sortis ensemble, tout secret chiffré
est à considérer comme connu.

## 3. Comprendre

Administration › Journal, filtré sur le compte, le serveur ou l'adresse IP, à
partir de l'heure notée. L'export (CSV ou JSON) est réservé aux
administrateurs, et **l'export lui-même est consigné**.

Les **refus** y figurent aussi : `access.denied` (serveur, permission ou
espace d'administration refusés à un compte ou à une clé),
`application.key_rejected` (clé applicative présentée et refusée, par son
préfixe) et `node.token_rejected` (jeton de daemon refusé, par son
identifiant). Ils ne sont rattachés à aucun serveur — le serveur visé est
dans le détail de la ligne : les chercher par événement (préfixe
`access.`, `application.key`, `node.token`) ou par adresse, pas par
serveur. Un refus répété ne s'écrit qu'à sa 1ʳᵉ, 10ᵉ, 100ᵉ… occurrence en
dix minutes, avec le compte (`occurrences`), et trois cents lignes de refus
au plus par tranche de dix minutes : au-delà, seul le journal de l'API le
dit.

Questions à trancher :

- **Par où** : mot de passe deviné, session volée, clé d'API, SFTP,
  prise en main du compte par un administrateur ? En SFTP, le mot de passe
  suffit **même avec la double authentification** (le protocole ne sait pas
  demander de code, [ADR 0001](../adr/0001-wings-conserve.md)) : un mot de
  passe connu ouvre les fichiers sans passer par le second facteur. Seule
  exception : quand l'annuaire est obligatoire, le SFTP n'accepte que les
  clés SSH ; regarder alors les clés du compte.
- **Quoi** : serveurs touchés, fichiers lus ou modifiés, sous-utilisateurs
  invités, clés ajoutées, rôle changé ?
- **Depuis quand** : la première action de l'adresse ou de l'appareil
  inconnu, pas la première qu'on a remarquée.

Ce que le journal ne voit pas se cherche ailleurs : dans le journal de l'API
(copié à l'étape 1) pour les requêtes, et dans `journalctl -u wings` sur les
nodes pour le SFTP et la console.

Les moyens d'authentification ajoutés sur le compte depuis le début de
l'incident, en lecture seule (`sudo -u postgres psql gamedashboard`) :

```sql
\set compte '<uuid du compte>'
\set debut '2026-09-23 14:00+02'
select 'passkey' as quoi, id, label as nom, created_at from user_passkeys where user_id = :'compte' and created_at >= :'debut'
union all
select 'clé SSH', id, name, created_at from ssh_keys where user_id = :'compte' and created_at >= :'debut'
union all
select 'clé d''API', id, prefix, created_at from api_keys where user_id = :'compte' and created_at >= :'debut'
order by created_at;
```

## 4. Rétablir

Pour un compte, **pendant qu'il est encore suspendu** :

1. **Retirer ce que l'intrus a laissé.** Aucun écran d'administration ne
   touche aux moyens de connexion d'un autre compte : cela se fait en base,
   dans la même session `psql` qu'à l'étape 3. Les clés d'API sont
   révoquées, pas effacées, pour que le titulaire les voie fermées. Les
   passkeys et clés SSH repérées sont effacées une à une, par leur `id` :
   ```sql
   begin;
   update api_keys set revoked_at = now(), updated_at = now()
    where user_id = :'compte' and revoked_at is null;
   delete from user_passkeys where user_id = :'compte' and id = '<id>';
   delete from ssh_keys where user_id = :'compte' and id = '<id>';
   commit;
   ```
   Retirer aussi, depuis l'interface, les sous-utilisateurs invités et le rôle
   changé.
2. **Rendre caduc le mot de passe connu de l'intrus** :
   `sudo gamedashboard password <email>`. Le nouveau s'affiche une fois : ne
   le transmettre à personne, il ne sert qu'à fermer cette porte.
3. **Réactiver le compte**, puis lui envoyer un **lien de réinitialisation**
   (fiche du compte). Le titulaire choisit son mot de passe, l'administrateur
   ne le voit jamais, et la réinitialisation ferme toutes les sessions.
4. Demander au titulaire de vérifier Compte › Sécurité (double
   authentification, passkeys, sessions) et Compte › Clés API.

Pour les fichiers d'un serveur modifiés par l'intrus : restaurer une
sauvegarde **antérieure** au début de l'incident, depuis l'onglet Sauvegardes
du serveur.

Pour une machine compromise, panel ou node : ne pas la réparer, la
**reconstruire**. Installer sur une machine neuve, restaurer la base
([restauration](./restauration-base.md)), puis refaire les rotations de
l'étape 2 : la sauvegarde contient les secrets que l'intrus a pu lire.
**Attention** : restaurer une sauvegarde annule les suspensions et
révocations faites depuis. Les refaire.

## 5. Prévenir

- **Les titulaires concernés**, avec ce qui a été vu, ce qui a été fait, et
  ce qu'on attend d'eux.
- **La CNIL, sous 72 heures**, si des données personnelles ont pu être lues
  ou modifiées (RGPD, art. 33), et les personnes elles-mêmes si le risque
  pour elles est élevé (art. 34). Une adresse, une IP ou un journal de
  connexions sont des données personnelles.
- **Les systèmes tiers** dont une clé applicative a été révoquée : ils
  s'arrêtent net tant qu'ils n'ont pas la nouvelle.

Consigner l'incident (chronologie, cause, gestes, ce qui a manqué) à côté des
ADR, et corriger ce qui l'a permis, avec son test de non-régression.
