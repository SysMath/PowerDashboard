/**
 * La fiche de l'application dans les deux magasins (ADR 0010, lot 7), en
 * français et en anglais. Elle se recopie dans App Store Connect et dans la
 * console de Google Play ; la garder ici la fait relire comme le code, et
 * `fiche.test.ts` vérifie les longueurs que chaque magasin impose.
 *
 * Aucune marque d'autrui : ni nom de jeu ni nom de logiciel tiers, que les
 * deux magasins refusent dans une fiche qui ne leur appartient pas (Apple,
 * règle 2.3.7 ; Google, règle sur les métadonnées).
 */

export interface Fiche {
  /** Nom affiché, les deux magasins : 30 caractères. */
  nom: string;
  /** Sous-titre d'Apple : 30 caractères. */
  sousTitre: string;
  /** Description courte de Google Play : 80 caractères. */
  descriptionCourte: string;
  /** Texte promotionnel d'Apple, modifiable sans nouvelle version : 170 caractères. */
  promotion: string;
  /** Description complète, les deux magasins : 4 000 caractères. */
  description: string;
  /** Mots-clés d'Apple, séparés par des virgules : 100 caractères. */
  motsCles: string;
  /** Nouveautés de la version : 500 caractères (limite de Google Play). */
  nouveautes: string;
}

export const LIMITES: Record<keyof Fiche, number> = {
  nom: 30,
  sousTitre: 30,
  descriptionCourte: 80,
  promotion: 170,
  description: 4000,
  motsCles: 100,
  nouveautes: 500,
};

const fr: Fiche = {
  nom: "GameDashboard",
  sousTitre: "Vos serveurs de jeu en poche",
  descriptionCourte:
    "Pilotez les serveurs de jeu de votre panel GameDashboard depuis votre téléphone.",
  promotion:
    "Démarrez, surveillez et sauvegardez vos serveurs de jeu où que vous soyez, sur votre propre panel GameDashboard.",
  description: `GameDashboard est l'application du panel de gestion de serveurs de jeu GameDashboard. Elle se relie au panel de votre hébergeur, ou au vôtre, et vous laisse agir sur vos serveurs depuis votre téléphone.

Un panel GameDashboard est nécessaire : l'application n'héberge aucun serveur et ne crée aucun compte. Vous la reliez à votre panel en scannant le code affiché par celui-ci, ou en tapant son adresse, puis en vous y connectant comme d'habitude.

Pas encore de panel ? « Essayer sans panel » ouvre une démonstration complète, sur des données fictives.

VOS SERVEURS
• État, mémoire, joueurs en ligne
• Démarrer, redémarrer, arrêter
• Console en direct
• Sauvegardes : créer, verrouiller, restaurer, supprimer
• Fichiers : parcourir, modifier, envoyer depuis le téléphone, télécharger, compresser, extraire
• Notifications du panel, et alertes sur le téléphone si votre panel les envoie

POUR LES REVENDEURS
• L'enveloppe accordée et ce qu'il en reste
• Les clients et leurs serveurs, à suspendre ou rétablir
• La consommation du mois, serveur par serveur

POUR LES ADMINISTRATEURS
• Ce qui ne va pas, d'un coup d'œil : machines injoignables, serveurs en échec, incidents ouverts
• Recherche dans tout le parc et dans les comptes
• Suspension d'un serveur ou d'un compte, déconnexion partout
• Incidents de la page d'état, mise à jour du panel, journal

SÉCURITÉ
• Chaque téléphone est un appareil que vous pouvez retirer depuis le panel
• La biométrie du téléphone (visage ou empreinte) ouvre l'application et confirme les gestes importants
• Votre mot de passe ne passe jamais par l'application : la connexion se fait dans le navigateur
• Plusieurs panels peuvent être reliés, chacun à part

Vos données restent entre votre téléphone et votre panel. L'éditeur ne voit ni vos serveurs, ni vos fichiers, ni votre compte.`,
  motsCles:
    "serveur,jeu,console,sauvegarde,panel,hébergement,administration,revendeur,joueurs,fichiers",
  nouveautes:
    "Première version : vos serveurs, leur console, leurs sauvegardes et leurs fichiers ; l'espace revendeur et l'administration simple ; la biométrie pour les gestes importants.",
};

const en: Fiche = {
  nom: "GameDashboard",
  sousTitre: "Your game servers, in hand",
  descriptionCourte: "Run the game servers of your GameDashboard panel from your phone.",
  promotion:
    "Start, watch and back up your game servers wherever you are, on your own GameDashboard panel.",
  description: `GameDashboard is the app for the GameDashboard game server panel. It links to your host's panel, or your own, and lets you act on your servers from your phone.

A GameDashboard panel is required: the app hosts no server and creates no account. You link it to your panel by scanning the code the panel shows, or by typing its address, then signing in as usual.

No panel yet? “Try without a panel” opens a full demo, on made-up data.

YOUR SERVERS
• Status, memory, players online
• Start, restart, stop
• Live console
• Backups: create, lock, restore, delete
• Files: browse, edit, upload from the phone, download, compress, extract
• Panel notifications, and alerts on the phone if your panel sends them

FOR RESELLERS
• Your allowance and what is left of it
• Your customers and their servers, to suspend or restore
• This month's usage, server by server

FOR ADMINISTRATORS
• What is wrong, at a glance: unreachable machines, failed servers, open incidents
• Search across all servers and accounts
• Suspend a server or an account, sign an account out everywhere
• Status page incidents, panel updates, activity log

SECURITY
• Each phone is a device you can remove from the panel
• The phone's biometrics (face or fingerprint) open the app and confirm important actions
• Your password never goes through the app: you sign in in the browser
• Several panels can be linked, each kept apart

Your data stays between your phone and your panel. The publisher sees neither your servers, nor your files, nor your account.`,
  motsCles: "server,game,console,backup,panel,hosting,admin,reseller,players,files",
  nouveautes:
    "First release: your servers, their console, backups and files; the reseller space and simple administration; biometrics for important actions.",
};

export const FICHES = { fr, en } as const;
