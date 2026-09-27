# Documentation

| | |
|---|---|
| [Installer](./installation.md) | Du serveur vide au premier serveur de jeu, pas à pas, pour qui découvre le projet |
| [Hébergement cPanel](./hebergement-cpanel.md) | Faire tourner le panel sur un hébergement mutualisé (Setup Node.js App, PostgreSQL) depuis l'archive autonome, qui se met ensuite à jour d'elle-même depuis les releases |
| [Contribuer](./contribuer.md) | Installer, les règles du dépôt, les gestes courants, ce que la CI refuse |
| [Décisions d'architecture](./adr/README.md) | Pourquoi le projet est construit ainsi, une décision par fichier |
| [Runbooks](./runbooks/README.md) | Procédures d'exploitation : jetons de node, machine injoignable, clé maître des secrets, déplacement de serveur, restauration de la base, incident de sécurité |
| [Runner auto-hébergé](./runner-auto-heberge.md) | Faire tourner la CI et les releases sur notre propre machine |
| [Sous-domaines des serveurs](./sous-domaines.md) | Régler la zone Cloudflare où le panel publie les adresses des serveurs, et ce qu'il y écrit |
| [Reprise Pterodactyl](./reprise-pterodactyl.md) | Basculer un panel Pterodactyl existant, Wings compris |
| [Audit ASVS niveau 2](./securite/audit-asvs-l2.md) | Consigne de l'audit de sécurité de la V1, à confier à une session Claude |
| [Rapport ASVS niveau 2](./securite/rapport-asvs-l2.md) | Résultat de l'audit et suivi des corrections (§0) : non-conformités, commits et tests, sondes, tableau des exigences V1 à V14 |
| [Modèle de menace](./securite/modele-de-menace.md) | Acteurs, actifs, frontières de confiance, menaces principales et contrôles qui y répondent |

Le plan d'ensemble est dans [PLAN.md](../PLAN.md). Le démarrage rapide et
l'état des écrans sont dans le [README](../README.md).
