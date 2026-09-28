/**
 * Le catalogue des routes publiques du panel.
 *
 * **Source unique**, et c'est tout son intérêt : l'écran « API » le rend pour
 * un lecteur humain, et le générateur OpenAPI en tire la spécification que
 * lisent les outils. Le tenir en double, une fois pour l'écran et une fois
 * pour la spécification, garantissait qu'un jour les deux ne diraient plus la
 * même chose — et que personne ne saurait laquelle croire.
 *
 * Il vit dans `contracts` et non dans l'interface pour cette raison : ni le
 * panel ni le générateur n'a à dépendre de l'autre.
 */

/** Les verbes employés par l'API. Redéclaré ici : `contracts` ne dépend pas de l'interface. */
export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface ApiRoute {
  method: HttpMethod;
  path: string;
  summary: string;
  /** Portée requise sur la clé. `null` quand aucune portée particulière n'est exigée. */
  scope: string | null;
  group: string;
}

/** Routes accessibles avec une clé personnelle, au nom de l'utilisateur. */
export const CLIENT_ROUTES: ApiRoute[] = [
  {
    method: "GET",
    path: "/servers",
    summary: "Lister les serveurs auxquels la clé donne accès.",
    scope: null,
    group: "Serveurs",
  },
  {
    method: "GET",
    path: "/servers/{server}",
    summary: "Détail d'un serveur : limites, allocation, egg, état.",
    scope: null,
    group: "Serveurs",
  },
  {
    method: "GET",
    path: "/servers/{server}/resources",
    summary: "Dernier relevé CPU, mémoire, disque, réseau et joueurs.",
    scope: "console.read",
    group: "Serveurs",
  },
  {
    method: "GET",
    path: "/servers/{server}/metrics?range={plage}",
    summary:
      "Historique agrégé CPU, mémoire, disque, réseau et joueurs sur 1h, 24h, 7d ou 30d. Un pas sans mesure vaut null, jamais zéro.",
    scope: "console.read",
    group: "Serveurs",
  },
  {
    method: "POST",
    path: "/servers/{server}/power",
    summary: "Envoyer un signal start, stop, restart ou kill.",
    scope: "power.*",
    group: "Serveurs",
  },
  {
    method: "POST",
    path: "/servers/{server}/command",
    summary: "Envoyer une commande à la console du serveur.",
    scope: "console.send",
    group: "Serveurs",
  },
  {
    method: "GET",
    path: "/servers/{server}/commands",
    summary:
      "Commandes du jeu déclarées par l'egg, pour l'autocomplétion de la console (arguments entre chevrons).",
    scope: "console.read",
    group: "Serveurs",
  },
  {
    method: "GET",
    path: "/servers/{server}/players",
    summary: "Joueurs connectés (dernière sonde, échantillon) et actions proposées par l'egg.",
    scope: "players.read",
    group: "Serveurs",
  },
  {
    method: "POST",
    path: "/servers/{server}/players",
    summary:
      "Expulser, bannir, gracier un joueur, gérer la liste blanche ou les opérateurs (op exige aussi console.send).",
    scope: "players.manage",
    group: "Serveurs",
  },
  {
    method: "POST",
    path: "/servers/{server}/websocket",
    summary: "Obtenir un jeton websocket de dix minutes pour la console.",
    scope: "console.read",
    group: "Serveurs",
  },
  {
    method: "GET",
    path: "/servers/{server}/files?directory={chemin}",
    summary: "Lister le contenu d'un répertoire.",
    scope: "files.read",
    group: "Fichiers",
  },
  {
    method: "GET",
    path: "/servers/{server}/files/contents",
    summary: "Lire le contenu brut d'un fichier.",
    scope: "files.read",
    group: "Fichiers",
  },
  {
    method: "GET",
    path: "/servers/{server}/files/download?file={chemin}",
    summary:
      "Adresse de téléchargement d'un fichier, à usage unique. Les octets viennent du daemon, pas du panel.",
    scope: "files.read",
    group: "Fichiers",
  },
  {
    method: "POST",
    path: "/servers/{server}/files/upload-grant",
    summary:
      "Autorisation de déposer des fichiers. Rend une adresse et un jeton à présenter au daemon.",
    scope: "files.write",
    group: "Fichiers",
  },
  {
    method: "POST",
    path: "/servers/{server}/files/compress",
    summary: "Compresse une sélection en une archive, dans le dossier indiqué.",
    scope: "files.archive",
    group: "Fichiers",
  },
  {
    method: "POST",
    path: "/servers/{server}/files/decompress",
    summary: "Extrait une archive sur place.",
    scope: "files.archive",
    group: "Fichiers",
  },
  {
    method: "POST",
    path: "/servers/{server}/files/write",
    summary: "Écrire un fichier. Le corps de la requête est le contenu brut.",
    scope: "files.write",
    group: "Fichiers",
  },
  {
    method: "POST",
    path: "/servers/{server}/files/rename",
    summary: "Renommer ou déplacer un fichier ou un dossier.",
    scope: "files.write",
    group: "Fichiers",
  },
  {
    method: "POST",
    path: "/servers/{server}/files/chmod",
    summary:
      "Changer les permissions d'entrées : `{ root, files: [{ file, mode }] }`, mode octal de 000 à 777 en chaîne.",
    scope: "files.write",
    group: "Fichiers",
  },
  {
    method: "POST",
    path: "/servers/{server}/files/delete",
    summary: "Supprimer définitivement des fichiers ou dossiers.",
    scope: "files.delete",
    group: "Fichiers",
  },
  {
    method: "GET",
    path: "/servers/{server}/backups",
    summary: "Lister les sauvegardes et le quota restant.",
    scope: "backups.read",
    group: "Sauvegardes",
  },
  {
    method: "POST",
    path: "/servers/{server}/backups",
    summary: "Déclencher une sauvegarde. Accepte un en-tête d'idempotence.",
    scope: "backups.create",
    group: "Sauvegardes",
  },
  {
    method: "POST",
    path: "/servers/{server}/backups/{backup}/restore",
    summary:
      "Restaurer une sauvegarde sur le serveur. Le serveur reste fermé (démarrage, fichiers, SFTP) jusqu'au compte rendu du daemon ; refusé (409) sur un serveur déjà occupé ou pour une sauvegarde en cours ou ratée.",
    scope: "backups.restore",
    group: "Sauvegardes",
  },
  {
    method: "DELETE",
    path: "/servers/{server}/backups/{backup}",
    summary:
      "Supprimer une sauvegarde non verrouillée. Refusé (409) pendant une restauration sur ce serveur, quelle que soit l'archive.",
    scope: "backups.delete",
    group: "Sauvegardes",
  },
  {
    method: "GET",
    path: "/servers/{server}/databases",
    summary: "Lister les bases de données du serveur.",
    scope: "databases.read",
    group: "Bases de données",
  },
  {
    method: "POST",
    path: "/servers/{server}/databases",
    summary: "Créer une base et son utilisateur dédié.",
    scope: "databases.create",
    group: "Bases de données",
  },
  {
    method: "POST",
    path: "/servers/{server}/databases/{db}/rotate",
    summary: "Régénérer le mot de passe de la base.",
    scope: "databases.update",
    group: "Bases de données",
  },
  {
    method: "GET",
    path: "/servers/{server}/schedules",
    summary: "Lister les tâches planifiées et leur prochaine exécution.",
    scope: "schedules.read",
    group: "Planification",
  },
  {
    method: "POST",
    path: "/servers/{server}/schedules/{schedule}/run",
    summary: "Exécuter une tâche immédiatement.",
    scope: "schedules.update",
    group: "Planification",
  },
  {
    method: "GET",
    path: "/servers/{server}/subusers/presets",
    summary:
      "Presets de permissions proposés à l'invitation, tels que l'administration les a définis.",
    scope: "subusers.read",
    group: "Accès",
  },
  {
    method: "GET",
    path: "/servers/{server}/engine?q={recherche}",
    summary:
      "Moteur du serveur : plateformes proposées, modpacks Modrinth et CurseForge, moteur posé par le panel (meta.current) avec la mise à jour de pack relevée par la veille, sort de chaque catalogue (meta.packSources) et dernière installation lancée (meta.install : status running, done avec son compte rendu report, ou failed avec sa raison error ; startedAt, finishedAt).",
    scope: "files.read",
    group: "Moteur",
  },
  {
    method: "POST",
    path: "/servers/{server}/engine/install",
    summary:
      "Installer une plateforme ou un modpack, ou mettre à jour le pack en place (même optionId, autre versionId) : { optionId, versionId, backupFirst? }. Répond 202 aussitôt : l'installation se poursuit en tâche de fond, son état et son compte rendu (fichiers posés, manquants, gardés, chargeur posé) se lisent sur GET engine (meta.install). Un pack Forge ou NeoForge fait poser son chargeur par une réinstallation de l'egg Minecraft Java (variables LOADER, LOADER_VERSION, MINECRAFT_VERSION réglées d'après le manifeste, versions vérifiées sur le dépôt officiel) ; son échec est dit dans le compte rendu, le suivi des fichiers du pack reste. Refus immédiats : version, chargeur ou archive refusés, installation déjà en cours ou serveur occupé (409) ; version de plateforme retirée par l'éditeur (404), éditeur muet ou réponse inattendue (502), avant tout arrêt du serveur. Arrête le serveur ; backupFirst (portée backups.create) prend une sauvegarde ordinaire et l'attend avant toute écriture, et son échec redémarre le serveur s'il tournait. Exige aussi files.delete et power.stop.",
    scope: "files.write",
    group: "Moteur",
  },
  {
    method: "GET",
    path: "/servers/{server}/activity",
    summary: "Journal d'audit du serveur, paginé par curseur.",
    scope: "activity.read",
    group: "Audit",
  },
];

/**
 * Routes d'authentification, servies **uniquement à une session de navigateur**.
 *
 * Elles sont documentées à part parce qu'aucune clé d'API ne les atteint, quelle
 * que soit sa portée : les portées décrivent des permissions de serveur, aucune
 * ne parle de la sécurité du compte. Une clé volée ne doit pas pouvoir fermer
 * les sessions de son propriétaire ni retirer sa double authentification.
 *
 * Les lister sous « clé personnelle » les ferait essayer, et la garde
 * répondrait 403 sans qu'on comprenne pourquoi.
 */
export const SESSION_ROUTES: ApiRoute[] = [
  {
    method: "GET",
    path: "/auth/me",
    /*
     * Le profil du titulaire, qu'il vienne d'une session ou d'une clé.
     *
     * Rangé ici et non parmi les routes « client » : il ne vit pas sous ce
     * préfixe. La documentation l'y annonçait pourtant, sur un `/account` qui
     * n'a jamais existé — et l'intégrateur le découvrait en recevant un 404.
     */
    summary: "Profil du titulaire de la clé ou de la session.",
    scope: null,
    group: "Compte",
  },
  {
    method: "POST",
    path: "/auth/login",
    summary: "Mot de passe. Refusé quand l'authentification unique est active.",
    scope: null,
    group: "Connexion",
  },
  {
    method: "POST",
    path: "/auth/login/2fa",
    summary: "Second facteur : code TOTP ou code de secours.",
    scope: null,
    group: "Connexion",
  },
  {
    method: "POST",
    path: "/auth/login/2fa/passkey/options",
    summary: "Options de la cérémonie WebAuthn, à partir du défi de connexion.",
    scope: null,
    group: "Connexion",
  },
  {
    method: "POST",
    path: "/auth/login/2fa/passkey",
    summary: "Assertion d'une clé d'accès. Ouvre la session.",
    scope: null,
    group: "Connexion",
  },
  {
    method: "GET",
    path: "/auth/sso",
    summary: "L'authentification unique est-elle active, et sous quel nom.",
    scope: null,
    group: "Connexion",
  },
  {
    method: "POST",
    path: "/auth/sso/start",
    summary: "Ouvre une cérémonie et rend l'URL du fournisseur, l'état et le vérificateur.",
    scope: null,
    group: "Connexion",
  },
  {
    method: "POST",
    path: "/auth/sso/callback",
    summary: "Échange le code, reconnaît le compte, ouvre la session.",
    scope: null,
    group: "Connexion",
  },
  {
    method: "GET",
    path: "/auth/google",
    summary: "Le bouton « Se connecter avec Google » est-il proposé.",
    scope: null,
    group: "Connexion",
  },
  {
    method: "POST",
    path: "/auth/google/start",
    summary: "Ouvre une cérémonie chez Google et rend son URL, l'état et le vérificateur.",
    scope: null,
    group: "Connexion",
  },
  {
    method: "POST",
    path: "/auth/google/callback",
    summary:
      "Échange le code, reconnaît le compte, ouvre la session. Ne crée un compte que si les inscriptions sont ouvertes.",
    scope: null,
    group: "Connexion",
  },
  {
    method: "POST",
    path: "/auth/logout",
    summary: "Révoque la session courante et retire le cookie.",
    scope: null,
    group: "Connexion",
  },
  {
    method: "GET",
    path: "/auth/sessions",
    summary: "Appareils connectés au compte, la dernière activité en tête.",
    scope: null,
    group: "Sessions",
  },
  {
    method: "DELETE",
    path: "/auth/sessions/{session}",
    summary: "Ferme une session. Sur la sienne, c'est une déconnexion.",
    scope: null,
    group: "Sessions",
  },
  {
    method: "DELETE",
    path: "/auth/sessions",
    summary: "Ferme toutes les autres sessions, en gardant celle qui le demande.",
    scope: null,
    group: "Sessions",
  },
  {
    method: "POST",
    path: "/auth/password",
    summary: "Change le mot de passe. L'ancien est exigé ; les autres sessions tombent.",
    scope: null,
    group: "Compte",
  },
  {
    method: "GET",
    path: "/auth/2fa",
    summary: "État : TOTP, nombre de clés d'accès, codes de secours restants.",
    scope: null,
    group: "Double authentification",
  },
  {
    method: "POST",
    path: "/auth/2fa/setup",
    summary: "Prépare un secret TOTP et rend son URI otpauth. Mot de passe exigé.",
    scope: null,
    group: "Double authentification",
  },
  {
    method: "POST",
    path: "/auth/2fa/enable",
    summary: "Confirme le secret par un premier code et rend les codes de secours.",
    scope: null,
    group: "Double authentification",
  },
  {
    method: "POST",
    path: "/auth/2fa/recovery-codes",
    summary: "Régénère les codes de secours. Mot de passe exigé.",
    scope: null,
    group: "Double authentification",
  },
  {
    method: "DELETE",
    path: "/auth/2fa",
    summary: "Retire le TOTP. Les clés d'accès ne sont pas touchées.",
    scope: null,
    group: "Double authentification",
  },
  {
    method: "GET",
    path: "/auth/2fa/passkeys",
    summary: "Clés d'accès enregistrées, sans leur clé publique.",
    scope: null,
    group: "Clés d'accès",
  },
  {
    method: "POST",
    path: "/auth/2fa/passkeys/options",
    summary: "Options d'enregistrement WebAuthn et défi scellé. Mot de passe exigé.",
    scope: null,
    group: "Clés d'accès",
  },
  {
    method: "POST",
    path: "/auth/2fa/passkeys",
    summary: "Vérifie l'enregistrement et range la clé.",
    scope: null,
    group: "Clés d'accès",
  },
  {
    method: "DELETE",
    path: "/auth/2fa/passkeys/{passkey}",
    summary: "Supprime une clé d'accès. Mot de passe exigé.",
    scope: null,
    group: "Clés d'accès",
  },
];

/**
 * Routes de l'API applicative, celles qu'un système tiers appelle.
 *
 * La facturation ne vit pas dans ce projet : la boutique encaisse, puis
 * demande ici. Cette liste est tenue à jour avec le contrôleur — une route
 * documentée qui n'existe pas coûte plus cher qu'une route non documentée,
 * parce qu'on la code contre pendant une journée avant de s'en apercevoir.
 */
export const APPLICATION_ROUTES: ApiRoute[] = [
  {
    method: "GET",
    path: "/domains/certificates",
    summary:
      "Domaines vérifiés et état de leur certificat TLS. « pending » dit s'il y a " +
      "quelque chose à faire : aucun certificat, expiration à moins de trente jours, " +
      "ou échec vieux d'une heure. Suivent les domaines déclarés non vérifiés " +
      "(« verified » à faux, jamais « pending », actifs depuis moins de trente jours, " +
      "deux cents au plus), à qui l'agent ne pose qu'une page d'attente.",
    scope: "domains.certificates",
    group: "Certificats",
  },
  {
    method: "POST",
    path: "/domains/{domain}/certificate",
    summary:
      "Rendre compte d'une tentative. « issuedAt » et « expiresAt » à la réussite, " +
      "« failure » à l'échec — et les deux ensemble quand un renouvellement échoue " +
      "alors que l'ancien certificat tient encore.",
    scope: "domains.certificates",
    group: "Certificats",
  },
  {
    method: "GET",
    path: "/identity",
    summary: "Vérifier la clé, l'adresse IP et les portées accordées. Ne crée rien.",
    scope: null,
    group: "Mise en service",
  },
  {
    method: "GET",
    path: "/users?externalId={id}",
    summary: "Retrouver un compte par identifiant externe, adresse e-mail ou identifiant local.",
    scope: "users.read",
    group: "Comptes",
  },
  {
    method: "GET",
    path: "/users/{user}",
    summary: "Détail d'un compte et nombre de serveurs possédés.",
    scope: "users.read",
    group: "Comptes",
  },
  {
    method: "POST",
    path: "/users",
    summary:
      "Créer un compte client. Aucun mot de passe n'est accepté : la connexion passe par le SSO.",
    scope: "users.write",
    group: "Comptes",
  },
  {
    method: "PATCH",
    path: "/users/{user}",
    summary: "Corriger nom, prénom ou identifiant externe. Ni rôle, ni adresse, ni mot de passe.",
    scope: "users.write",
    group: "Comptes",
  },
  {
    method: "DELETE",
    path: "/users/{user}",
    summary: "Supprimer un compte. Refusé tant qu'il possède des serveurs.",
    scope: "users.delete",
    group: "Comptes",
  },
  {
    method: "POST",
    path: "/users/sso-link",
    summary:
      "Lien de connexion d'un client, désigné par userId ou externalId. Vaut deux minutes, sert une fois ; refusé pour le personnel.",
    scope: "users.sso",
    group: "Comptes",
  },
  {
    method: "GET",
    path: "/servers?ownerId={user}",
    summary: "Lister les serveurs, éventuellement ceux d'un seul client.",
    scope: "servers.read",
    group: "Serveurs",
  },
  {
    method: "GET",
    path: "/servers/{server}",
    summary: "Détail d'un serveur : node, egg, ressources, état, motif de suspension.",
    scope: "servers.read",
    group: "Serveurs",
  },
  {
    method: "POST",
    path: "/servers",
    summary:
      "Créer un serveur pour un client, par offre + localisation ou par node + ressources. Accepte " +
      "Idempotency-Key. Une clé de revendeur ne le donne qu'à un compte client non suspendu, " +
      "entièrement chez elle ou encore sans serveur ; sans serveur, il ne doit être invité sur " +
      "aucun serveur d'ailleurs.",
    scope: "servers.create",
    group: "Serveurs",
  },
  {
    method: "PATCH",
    path: "/servers/{server}",
    summary:
      "Changer les limites d'un serveur (mémoire, disque, CPU, swap, allocations, sauvegardes, bases). Seuls les champs envoyés changent.",
    scope: "servers.resize",
    group: "Serveurs",
  },
  {
    method: "POST",
    path: "/servers/{server}/owner",
    summary:
      "Changer le titulaire d'un serveur (corps : ownerId). Les sous-utilisateurs et le revendeur " +
      "hébergeur restent ; les consoles ouvertes de l'ancien titulaire sont fermées. Une clé de " +
      "revendeur ne peut le donner qu'à un compte client non suspendu, entièrement chez elle ou " +
      "encore sans serveur ; sans serveur, il ne doit être invité sur aucun serveur d'ailleurs. " +
      "Son propre client suspendu est refusé en 403, avec la raison ; tout autre refus rend 404.",
    scope: "servers.owner",
    group: "Serveurs",
  },
  {
    method: "POST",
    path: "/servers/{server}/suspension",
    summary: "Suspendre sur impayé, ou rétablir après régularisation.",
    scope: "servers.suspend",
    group: "Serveurs",
  },
  {
    method: "DELETE",
    path: "/servers/{server}",
    summary: "Supprimer un serveur et son volume. Le node doit répondre.",
    scope: "servers.delete",
    group: "Serveurs",
  },
  {
    method: "GET",
    path: "/resellers/{user}/quota",
    summary: "Enveloppe de ressources d'un revendeur et ce qu'il en consomme.",
    scope: "resellers.read",
    group: "Revendeurs",
  },
  {
    method: "PUT",
    path: "/resellers/{user}/quota",
    summary:
      "Poser l'enveloppe d'un revendeur. `null` vaut sans limite, les trois champs sont exigés.",
    scope: "resellers.write",
    group: "Revendeurs",
  },
  {
    method: "GET",
    path: "/nodes",
    summary:
      "Nodes de la plateforme et capacité restante. Les nodes des revendeurs en sont exclus.",
    scope: "infrastructure.read",
    group: "Infrastructure",
  },
  {
    method: "GET",
    path: "/locations",
    summary: "Localisations ouvertes à la commande, avec le stock de ports.",
    scope: "infrastructure.read",
    group: "Infrastructure",
  },
  {
    method: "GET",
    path: "/plans",
    summary: "Offres du catalogue, telles que l'assistant du panel les propose.",
    scope: "infrastructure.read",
    group: "Catalogue",
  },
  {
    method: "GET",
    path: "/eggs",
    summary: "Jeux activés, avec leur famille.",
    scope: "infrastructure.read",
    group: "Catalogue",
  },
];
export interface RealtimeEvent {
  name: string;
  direction: "in" | "out";
  summary: string;
  scope: string | null;
}

export const REALTIME_EVENTS: RealtimeEvent[] = [
  {
    name: "status",
    direction: "out",
    summary: "Changement d'état du serveur.",
    scope: "console.read",
  },
  {
    name: "console.output",
    direction: "out",
    summary: "Lignes de console, groupées toutes les 50 ms.",
    scope: "console.read",
  },
  {
    name: "stats",
    direction: "out",
    summary: "Relevé de ressources, chaque seconde.",
    scope: "console.read",
  },
  {
    name: "install.output",
    direction: "out",
    summary: "Sortie du script d'installation.",
    scope: "console.read",
  },
  {
    name: "backup.progress",
    direction: "out",
    summary: "Avancement d'une sauvegarde en cours.",
    scope: "backups.read",
  },
  /*
   * Aucun événement entrant : le jeton de console ne sert qu'à lire. Commandes
   * et signaux d'alimentation passent par `POST /servers/{server}/command` et
   * `POST /servers/{server}/power`, qui vérifient que le serveur peut obéir et
   * consignent le geste. Les annoncer ici promettait une porte que le daemon
   * refuse désormais (audit ASVS, NC-14).
   */
];
