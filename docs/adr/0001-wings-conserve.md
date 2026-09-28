# 0001 — Wings est conservé tel quel, sans fork

- **État** : acceptée
- **Date** : 2026-09
- **Références** : PLAN §4.3, §5.3, §5.5, §7.4, §7.5 ; `apps/api/src/modules/remote`,
  `apps/api/src/modules/wings`

## Contexte

Un hébergeur de serveurs de jeu exécute volontairement du code hostile : un
client téléverse un `.jar` arbitraire et on le lance. La sécurité réelle du
produit se joue donc dans l'isolation : traversée de chemin dans le
gestionnaire de fichiers, symlinks qui sortent du volume, zip-slip à
l'extraction, quotas contournés par hardlink, évasion de conteneur.

Wings, le daemon de Pterodactyl, a rencontré ces défauts un par un et les a
corrigés en dix ans d'exploitation. Un daemon neuf les rencontrerait tous à
nouveau, et ce sont ceux qui mènent à une compromission de l'hôte. Aucun
client ne choisit un hébergeur pour son superviseur de conteneurs : réécrire le
daemon coûterait le plus cher et ne différencierait rien.

## Décision

**Le panel est réécrit, le daemon ne l'est pas.** Wings reste le binaire
amont, non modifié et non forké. Le panel s'adapte à son contrat, jamais
l'inverse.

Concrètement :

- le panel sert les routes que Wings appelle (`/api/remote/*`) avec les formes
  exactes qu'il attend, y compris ses bizarreries. Exemple : `parts` vaut
  `null` et non `[]` dans le compte rendu d'une sauvegarde locale, parce que
  Go sérialise une tranche nil en `null` ;
- l'authentification SFTP, déléguée par Wings, est traitée comme du code
  d'isolation : un défaut de *notre* authentification donne accès aux fichiers ;
- le contrat s'éprouve contre un **Wings réel**, jamais contre un simulacre :
  bancs `infra/local/verifier-*.sh`.

## Options écartées

- **Réécrire le daemon** (en Go ou en TypeScript) : on repartirait de zéro sur
  toute la surface d'isolation, pour un gain que personne ne verrait.
- **Forker Wings** pour l'adapter au panel : chaque montée de version amont
  deviendrait une fusion, et les correctifs de sécurité arriveraient en
  retard, ou pas du tout.

## Conséquences

- **Le jeton de node est statique, et c'est le plafond de sécurité de la
  liaison.** Wings ne sait pas faire de mTLS. La compensation est décrite en
  PLAN §5.5 : un jeton par node, rotation, réseau d'administration isolé,
  chiffrement au repos. Voir le runbook
  [rotation du jeton de node](../runbooks/rotation-jeton-node.md).
- Le même jeton sert **dans les deux sens**, avec deux formes d'en-tête : le
  daemon présente `identifiant.jeton`, le panel présente le **jeton nu**.
  Les confondre donne un 403 qui ressemble à un jeton refusé.
- Certaines clés du `config.yml` (`system.data`, `allowed_mounts`, `remote`)
  portent `json:"-"` côté Wings : elles ne passent que par le fichier YAML,
  jamais par `POST /api/update`.
- **Le SFTP ne connaît pas de second facteur.** Wings transmet un nom et un
  mot de passe (ou une clé publique) à `POST /api/remote/sftp/auth`, et le
  protocole n'a aucune étape où demander un code. Un compte protégé par la
  double authentification entre donc en SFTP avec son **seul mot de passe**,
  comme chez Pterodactyl. Choix tenu (audit ASVS, NC-44) : le dire plutôt
  que refuser le mot de passe à ces comptes. Compensations : trois
  compteurs d'échecs (adresse, adresse + identifiant, identifiant seul),
  compte suspendu refusé, droit `files.sftp` exigé d'un sous-utilisateur, et
  les clés SSH proposées à l'écran — elles ne quittent pas la machine de
  leur porteur.
- **Annuaire obligatoire : SFTP par clé SSH seulement** (choix de Matheol,
  2026-09-26). La page de connexion refuse alors tout mot de passe local ;
  le SFTP le refuse aussi, pour tout le monde, clients venus de la
  facturation compris, sans même le vérifier (`SftpAuthService`). Sinon, un
  compte retiré de l'annuaire gardait par son mot de passe les fichiers de
  ses serveurs. Les clés SSH déjà posées restent valables : retirer
  quelqu'un de l'annuaire se complète par la suspension de son compte dans
  le panel (ou le retrait de ses clés). Le protocole ne rend qu'un échec
  d'authentification : l'écran SFTP de chaque serveur annonce la règle et
  mène à l'ajout d'une clé, et le réglage de l'annuaire en prévient
  l'administrateur avant la bascule.
- Les fonctions que Wings n'offre pas (sondes de jeu, par exemple) vivent
  dans le panel. On ne les demande pas au daemon.
- Le projet dépend du rythme de maintenance amont. Si Wings cessait d'être
  maintenu, le repli serait le fork communautaire actif, pas une réécriture.
  À réévaluer chaque année.
- ~~Une montée de version de Wings passe d'abord les bancs, node par node,
  jamais en masse.~~ Remplacé par l'amendement ci-dessous.

## Amendement — 2026-09

Décision du PLAN §12.4 (6) : **les machines de jeu suivent la dernière version
publiée de Wings.** `installer-wings.sh` l'installe et, relancé sur un node, le
met à jour.

La règle « les bancs d'abord » devient « les bancs à chaque nouvelle
version » : on les rejoue quand l'amont publie, et une dérive de contrat se
corrige côté panel, jamais dans Wings. Le compose de dev reste épinglé, pour
que les bancs soient reproductibles, et monte avec eux.

Risque accepté : un node mis à jour avant le passage des bancs tourne sur une
version qu'aucun banc n'a vue.
