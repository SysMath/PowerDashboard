# Décisions d'architecture

Une ADR consigne une décision **déjà prise**, le contexte qui l'a imposée et ce
qu'elle coûte. Elle ne se réécrit pas : une décision qu'on renverse donne une
nouvelle ADR, qui remplace l'ancienne et le dit dans son en-tête. La décision
d'origine reste lisible, avec ses raisons. On comprend ainsi pourquoi elle a
tenu, puis pourquoi elle a cessé de tenir.

| N° | Décision | État |
|---|---|---|
| [0001](./0001-wings-conserve.md) | Wings est conservé tel quel, sans fork | Acceptée |
| [0002](./0002-argon2id.md) | Argon2id pour les mots de passe, bcrypt lu seulement | Acceptée |
| [0003](./0003-catalogue-api-source-unique.md) | Le catalogue d'API est la source unique de la spécification | Acceptée |
| [0004](./0004-sdk-ecrit.md) | Le SDK est écrit à la main, pas généré | Acceptée |
| [0005](./0005-machine-muette.md) | La machine injoignable est un état de premier rang | Acceptée |
| [0006](./0006-depot-sur-ext4.md) | Le dépôt vit sur ext4, pas sur `drvfs` | Acceptée |
| [0007](./0007-secrets-et-donnees-au-repos.md) | Données personnelles en clair, clé maître en fichier, sans coffre ni poivre : la machine protège le repos | Acceptée |
| [0008](./0008-pare-feu-nftables.md) | Le pare-feu par serveur est tenu par un agent séparé, dans sa propre table nftables | Proposée |
| [0009](./0009-instantanes-de-volumes.md) | Les instantanés portent sur tout le système de fichiers des serveurs d'un node, pris et restaurés par l'agent du node | Acceptée |

## Format

```markdown
# NNNN — Titre à l'indicatif, qui énonce la décision

- **État** : proposée · acceptée · remplacée par NNNN
- **Date** : AAAA-MM
- **Références** : sections de PLAN.md, fichiers où la décision se lit

## Contexte
Les forces en présence. Ce qui rendait la question inévitable.

## Décision
Une phrase, puis ce qu'elle implique concrètement.

## Options écartées
Chacune avec la raison précise de son rejet.

## Conséquences
Ce que la décision coûte, ce qu'elle impose aux contributeurs, et à quel
signe on saurait qu'il faut la revoir.
```

Le numéro est attribué dans l'ordre et jamais réutilisé. Le code qui applique
une décision la cite dans son commentaire. Si le code n'y renvoie jamais, la
décision n'existe que sur le papier.
