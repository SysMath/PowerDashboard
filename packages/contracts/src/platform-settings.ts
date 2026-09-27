/**
 * Réglages de la plateforme (§6.6, table `settings`).
 *
 * Le catalogue est déclaré ici, une fois, et les deux côtés s'y réfèrent : un
 * réglage écrit sous une clé que l'API ne connaît pas serait accepté par la
 * base — `settings` est un simple couple clé/valeur — et ne serait jamais lu
 * par personne. La déclaration est donc ce qui rend la table exploitable.
 */

import type { BrandImageKind, BrandingOverrides } from "./branding";

export type SettingKind = "text" | "number" | "boolean" | "secret" | "choice";

export interface SettingDescriptor {
  key: string;
  kind: SettingKind;
  label: string;
  description?: string;
  /** Valeur servie tant que rien n'a été enregistré. Jamais pour un secret. */
  fallback?: string | number | boolean;
  placeholder?: string;
  /**
   * Valeurs admises d'un réglage `choice`, et rien d'autre.
   *
   * L'API refuse tout ce qui n'y figure pas. Un champ libre aurait suffi à
   * l'écran, mais pas en vérité : « quel système de facturation » décide du
   * comportement du panel, et une faute de frappe y produirait une plateforme
   * qui se croit configurée et ne l'est pas. La liste vit donc dans le contrat,
   * où l'interface et l'API la lisent toutes deux.
   */
  choices?: readonly { value: string; label: string; description?: string }[];
  /**
   * Forme imposée à un réglage textuel, vérifiée **à l'écriture** par l'API.
   *
   * - `url` : `https://` ou chemin interne (`isSafeBrandUrl`), comme la marque
   *   des revendeurs. Ces valeurs finissent dans un `src` ou un `href`.
   * - `hex` : couleur hexadécimale (`normalizeHex`). Elle finit dans une
   *   variable CSS, où une chaîne libre injecterait des déclarations.
   * - `outbound` : adresse que **le panel appelle lui-même** — `https://`, et
   *   jamais une destination interne (boucle locale, réseau privé, service
   *   de métadonnées). L'API le vérifie en résolvant le nom
   *   (`assertPublicDestination`, rapport ASVS NC-56).
   * - `domain` : nom de domaine, ramené en minuscules et sans point final
   *   (`normalizeDnsDomain`). Il finit dans les enregistrements DNS publiés.
   * - `token` : jeton d'API d'un seul tenant (`A-Z a-z 0-9 _ -`), pour un
   *   secret. Un saut de ligne collé avec lui finissait dans un en-tête HTTP
   *   invalide, dont le message d'erreur recopiait le jeton en clair.
   */
  format?: "url" | "hex" | "outbound" | "email" | "domain" | "token";
  /**
   * L'adresse peut aussi s'obtenir **par envoi de fichier** : l'écran propose
   * un bouton qui range l'image (PNG, JPEG, WebP ou ICO) et remplit le champ
   * de son chemin interne. Voir `BRAND_IMAGE_KINDS`.
   */
  upload?: BrandImageKind;
}

export interface SettingGroup {
  key: string;
  label: string;
  description?: string;
  settings: SettingDescriptor[];
}

/**
 * Un réglage `secret` n'est **jamais relu**.
 *
 * L'API renvoie un booléen « configuré ou non » à sa place, et une chaîne vide
 * à l'écriture signifie « ne change rien ». Renvoyer la valeur permettrait à
 * qui obtient un accès administrateur de repartir avec le mot de passe SMTP et
 * les clés S3 — c'est-à-dire bien au-delà du panel.
 */
export const PLATFORM_SETTINGS: readonly SettingGroup[] = [
  {
    key: "brand",
    label: "Marque",
    description: "Appliquée à l'ensemble du panel et aux e-mails.",
    settings: [
      { key: "brand.name", kind: "text", label: "Nom de la plateforme", fallback: "GameDashboard" },
      {
        key: "brand.domain",
        kind: "text",
        label: "Domaine du panel",
        placeholder: "game.gamedashboard.fr",
      },
      {
        key: "brand.accent",
        kind: "text",
        label: "Couleur d'accent",
        description: "Notation hexadécimale, employée pour les boutons et les liens.",
        fallback: "#7c3aed",
        format: "hex",
      },
      /*
       * Les mêmes champs que la marque d'un revendeur, et avec les mêmes
       * règles : un revendeur les surcharge sur son domaine, champ par champ,
       * et ceux qu'il laisse vides retombent sur ceux-ci.
       *
       * Aucun repli déclaré ici : un logo vide retombe sur celui du produit
       * (`DEFAULT_BRANDING`), un lien vide n'est simplement pas proposé.
       */
      {
        key: "brand.logoUrl",
        kind: "text",
        label: "Logo",
        description:
          "Adresse https:// ou chemin interne (/…), ou image envoyée. Vide : logo GameDashboard.",
        placeholder: "https://cdn.exemple.fr/logo.webp",
        format: "url",
        upload: "logo",
      },
      {
        key: "brand.faviconUrl",
        kind: "text",
        label: "Icône d'onglet (favicon)",
        description: "Vide : le logo sert aussi d'icône d'onglet.",
        placeholder: "/brand/favicon.png",
        format: "url",
        upload: "favicon",
      },
      {
        key: "brand.supportUrl",
        kind: "text",
        label: "Lien d'assistance",
        description: "Proposé aux clients. Vide : aucun lien affiché.",
        placeholder: "https://aide.exemple.fr",
        format: "url",
      },
      {
        key: "brand.termsUrl",
        kind: "text",
        label: "Conditions générales",
        description: "Lien proposé sur la page d'inscription.",
        placeholder: "https://exemple.fr/cgu",
        format: "url",
      },
      {
        key: "brand.footerText",
        kind: "text",
        label: "Texte de pied de page",
        description: "Affiché au bas de la page de connexion.",
        placeholder: "© Exemple SAS",
      },
      {
        key: "brand.loginTagline",
        kind: "text",
        label: "Accroche de connexion",
        description: "Courte phrase en tête de la page de connexion.",
      },
      {
        key: "brand.replyTo",
        kind: "text",
        label: "Adresse de réponse des e-mails",
        description:
          "Où arrivent les réponses des clients. Les e-mails partent toujours de l'adresse SMTP.",
        placeholder: "support@exemple.fr",
        format: "email",
      },
    ],
  },
  {
    key: "smtp",
    label: "Envoi d'e-mails",
    description: "Serveur SMTP utilisé pour les notifications et les invitations.",
    settings: [
      { key: "smtp.host", kind: "text", label: "Hôte SMTP", placeholder: "smtp.gamedashboard.fr" },
      { key: "smtp.port", kind: "number", label: "Port", fallback: 587 },
      { key: "smtp.username", kind: "text", label: "Utilisateur" },
      { key: "smtp.password", kind: "secret", label: "Mot de passe" },
      {
        key: "smtp.from",
        kind: "text",
        label: "Adresse d'expédition",
        placeholder: "no-reply@gamedashboard.fr",
      },
    ],
  },
  {
    key: "marketplace",
    label: "Catalogue d'extensions",
    description:
      "Modrinth et SpigotMC ne demandent rien. CurseForge exige une clé, qu'on obtient gratuitement sur son portail développeur.",
    settings: [
      {
        key: "marketplace.curseforgeKey",
        kind: "secret",
        label: "Clé d'API CurseForge",
        /*
         * La clé vivait **uniquement** dans une variable d'environnement.
         *
         * Conséquence : la seule façon d'activer CurseForge était d'ouvrir un
         * fichier sur la machine et de redémarrer le service — hors de portée
         * de qui administre depuis le panel, et impossible à faire pour un
         * revendeur. Le panel proposait donc une source qu'il ne donnait aucun
         * moyen de mettre en service.
         *
         * La variable d'environnement reste lue en second : les installations
         * qui s'en servent déjà ne doivent pas tomber en panne au déploiement.
         */
        description:
          "Format « $2a$10$… ». Laissez vide pour employer la variable d'environnement CURSEFORGE_API_KEY, si elle est posée.",
      },
    ],
  },
  {
    key: "servers",
    label: "Serveurs de jeu",
    description: "Réglages appliqués aux serveurs à leur création.",
    settings: [
      {
        /*
         * Le tueur de mémoire n'appartient pas au client.
         *
         * Le désactiver laisse un conteneur consommer au-delà de sa limite
         * sans jamais être arrêté : ce n'est pas un confort de jeu, c'est une
         * décision qui engage la machine entière et donc les voisins du
         * serveur. Elle revient à l'hébergeur, qui en répond.
         *
         * Ce réglage donne l'état **par défaut** des serveurs créés ensuite ;
         * un serveur déjà en place se change depuis sa fiche d'administration.
         */
        key: "servers.oomKiller",
        kind: "boolean",
        label: "Tueur de mémoire (OOM killer) actif par défaut",
        description:
          "Activé, un conteneur qui dépasse sa limite est arrêté net — la partie en cours est perdue, mais la machine est protégée. Désactivé, il ralentit sans jamais s'arrêter, et peut entraîner ses voisins.",
        fallback: true,
      },
    ],
  },
  {
    key: "sso",
    label: "Annuaire externe (équipe et sous-utilisateurs)",
    description:
      "**Ceci n'est pas le chemin de vos clients** — ils entrent par la facturation, réglée " +
      "au-dessus. Cette section concerne la page de connexion : elle permet à votre équipe et " +
      "aux personnes invitées sur un serveur de s'authentifier chez un fournisseur OAuth 2.0 " +
      "— Keycloak, Authentik, Azure, Google — au lieu d'un mot de passe local. Laissez-la " +
      "vide si vous n'en avez pas : la connexion par mot de passe suffit.",
    settings: [
      {
        key: "sso.enabled",
        kind: "boolean",
        label: "Rendre l'annuaire obligatoire",
        description:
          "Activée, la connexion par mot de passe est refusée sur la page de connexion — " +
          "**y compris pour les personnes invitées sur un serveur**, qui n'existent pas " +
          "forcément dans votre annuaire. Vérifiez que le fournisseur les couvre avant de " +
          "basculer : personne ne pourra plus entrer autrement. Vos clients, eux, ne sont pas " +
          "concernés : leur chemin est la facturation.",
        fallback: false,
      },
      {
        key: "sso.label",
        kind: "text",
        label: "Nom du fournisseur",
        description: "Affiché sur le bouton de connexion.",
        fallback: "Compte GameDashboard",
      },
      {
        key: "sso.authorizeUrl",
        kind: "text",
        label: "URL d'autorisation",
        placeholder: "https://gamedashboard.fr/oauth/authorize",
      },
      {
        key: "sso.tokenUrl",
        kind: "text",
        label: "URL du jeton",
        placeholder: "https://gamedashboard.fr/oauth/token",
      },
      {
        key: "sso.userinfoUrl",
        kind: "text",
        label: "URL du profil",
        description: "Doit rendre au moins un identifiant stable et une adresse e-mail.",
        placeholder: "https://gamedashboard.fr/oauth/userinfo",
      },
      { key: "sso.clientId", kind: "text", label: "Identifiant client" },
      { key: "sso.clientSecret", kind: "secret", label: "Secret client" },
      {
        key: "sso.scopes",
        kind: "text",
        label: "Portées demandées",
        description: "Séparées par des espaces.",
        fallback: "openid profile email",
      },
    ],
  },
  {
    /*
     * Une porte de plus, pas un annuaire (PLAN §12.4, décision 4) : le mot de
     * passe reste possible, et les adresses de Google sont fixes — seuls
     * l'identifiant et le secret du client se règlent.
     */
    key: "google",
    label: "Connexion avec Google",
    description:
      "Un bouton « Se connecter avec Google » sous le formulaire de connexion, pour qui préfère " +
      "son compte Google au mot de passe, qui reste possible. Un compte du panel est reconnu " +
      "par son adresse, vérifiée par Google ; un compte n'est créé que si les inscriptions sont " +
      "ouvertes. Sans effet quand l'annuaire externe est obligatoire : il est alors le seul " +
      "chemin.",
    settings: [
      {
        key: "google.enabled",
        kind: "boolean",
        label: "Proposer le bouton",
        fallback: false,
      },
      {
        key: "google.clientId",
        kind: "text",
        label: "Identifiant client",
        description:
          "Console Google Cloud › API et services › Identifiants › ID client OAuth, de type " +
          "« Application Web ». URI de redirection autorisé : l'adresse du panel suivie de " +
          "/auth/google/callback, et la même chose pour chaque domaine vérifié de revendeur.",
        placeholder: "123456789-abc.apps.googleusercontent.com",
      },
      { key: "google.clientSecret", kind: "secret", label: "Secret client" },
    ],
  },
  {
    key: "backups",
    label: "Stockage des sauvegardes",
    description:
      "Compartiment compatible S3 où les sauvegardes sont déposées. Laissé vide, elles restent sur le disque du node — et disparaissent avec la machine qu'elles protègent.",
    settings: [
      {
        key: "s3.endpoint",
        kind: "text",
        label: "Point d'accès",
        /*
         * Wings télécharge l'archive lui-même pour la restaurer, et refuse
         * toute adresse privée qu'on ne lui a pas autorisée : sans cette
         * phrase, un MinIO du réseau local sauvegarde sans erreur et ne
         * restaure jamais.
         */
        description:
          "Adresse du service, sans le nom du compartiment. À laisser vide pour Amazon S3 lui-même. Une adresse privée (MinIO sur le réseau local) doit être autorisée sur chaque machine de jeu : restore_host_allowlist, section system.backups du config.yml de Wings.",
        placeholder: "https://s3.fr-par.scw.cloud",
      },
      { key: "s3.bucket", kind: "text", label: "Compartiment" },
      { key: "s3.region", kind: "text", label: "Région", fallback: "gra" },
      { key: "s3.accessKey", kind: "text", label: "Clé d'accès" },
      { key: "s3.secretKey", kind: "secret", label: "Clé secrète" },
      {
        key: "s3.prefix",
        kind: "text",
        label: "Préfixe",
        description: "Dossier de tête, pour partager un compartiment entre plusieurs usages.",
        placeholder: "backups",
      },
      {
        /*
         * Beaucoup de services compatibles S3 n'acceptent pas l'adressage par
         * sous-domaine — MinIO, Ceph, ou un compartiment dont le nom porte un
         * point. Le réglage existe parce que se tromper ici produit une erreur
         * TLS incompréhensible plutôt qu'un message parlant.
         */
        key: "s3.pathStyle",
        kind: "boolean",
        label: "Adressage par chemin",
        description:
          "À activer pour MinIO, Ceph, ou tout compartiment dont le nom contient un point.",
        fallback: false,
      },
    ],
  },
  {
    key: "security",
    label: "Sécurité et accès",
    settings: [
      {
        key: "security.registrationOpen",
        kind: "boolean",
        label: "Inscriptions ouvertes",
        description: "Permet la création de compte depuis la page publique.",
        fallback: false,
      },
      {
        key: "security.staffRequires2fa",
        kind: "boolean",
        label: "2FA obligatoire pour le personnel",
        description:
          "Les rôles administrateur, support et revendeur doivent activer une seconde preuve " +
          "avant d'entrer dans leur espace. Actif par défaut : c'est le compte le plus " +
          "puissant de la plateforme qui est en jeu.",
        /*
         * **Exigée au départ** (rapport ASVS, NC-10, décision de Matheo).
         *
         * Le défaut inverse tenait à une crainte : verrouiller l'administration
         * d'un panel neuf, dont le premier compte n'a évidemment pas encore de
         * seconde preuve. Elle ne tient pas. L'enrôlement vit dans l'espace de
         * **compte** (`/account/security`), que `StaffTwoFactorGuard` ne ferme
         * pas ; l'administration, elle, explique le refus et y renvoie d'un
         * clic. Le premier administrateur active sa seconde preuve, puis entre.
         *
         * Le défaut fermé laissait en revanche le compte le plus puissant
         * derrière un seul mot de passe tant que personne n'allait cocher une
         * case — ce qui, sur un panel que personne ne relit, veut dire jamais.
         *
         * Une installation existante sans ligne en base passe à l'exigence à la
         * mise à jour : son personnel sans seconde preuve voit la même
         * explication, et l'enrôle depuis son compte.
         */
        fallback: true,
      },
      {
        key: "security.captchaOnLogin",
        kind: "boolean",
        label: "Captcha à la connexion",
        description:
          "Sur connexion, inscription et demande de réinitialisation. Sans les deux clés ci-dessous, ce réglage ne protège rien : le panel refuse de faire semblant et laisse passer.",
        fallback: false,
      },
      {
        key: "security.captchaSiteKey",
        kind: "text",
        label: "Clé de site Turnstile",
        description: "Publique : elle part dans la page pour afficher le contrôle.",
        placeholder: "0x4AAAAAAA…",
      },
      {
        key: "security.captchaSecretKey",
        kind: "secret",
        label: "Clé secrète Turnstile",
        description: "Sert à vérifier le jeton auprès de Cloudflare. Ne quitte jamais le panel.",
      },
    ],
  },
  {
    key: "instatus",
    label: "Page de statut Instatus",
    description:
      "Reprend les maintenances et incidents publiés sur votre page Instatus. Sans elle, le panel ne montre que ce que son propre heartbeat sait — l'état des machines, pas les travaux annoncés à l'avance.",
    settings: [
      {
        key: "instatus.pageUrl",
        kind: "text",
        label: "Adresse de la page",
        description:
          "La page publique. Le panel y lit « summary.json », qui ne demande aucune clé — la lecture reste donc possible même si la clé d'API expire.",
        placeholder: "https://status.gamedashboard.fr",
        // Le panel lit cette page lui-même, et publie ce qu'il lit dans la
        // bannière de chaque page : une adresse interne en ferait une fenêtre
        // sur son propre réseau.
        format: "outbound",
      },
      {
        key: "instatus.showBanner",
        kind: "boolean",
        label: "Afficher la bannière aux clients",
        description:
          "Une maintenance planifiée ou un incident ouvert apparaît en haut du panel, avec un lien vers la page.",
        fallback: true,
      },
    ],
  },
  {
    key: "billing",
    label: "Facturation et connexion des clients",
    description:
      "**C'est par ici que vos clients entrent.** Ils n'ont pas de mot de passe sur ce panel : " +
      "ils commandent et paient chez votre système de facturation, où un plugin leur montre un " +
      "bouton « Gérer mon serveur ». Le plugin crée le compte à la commande, puis demande au " +
      "panel un lien de connexion valable deux minutes. La page de connexion reste réservée à " +
      "votre équipe et aux personnes invitées sur un serveur.",
    settings: [
      {
        key: "billing.provider",
        kind: "choice",
        label: "Système de facturation",
        description:
          "Décide du plugin à installer chez vous et du nom affiché sur le panel. Le panel n'encaisse rien : il exécute ce que la facturation lui demande.",
        fallback: "none",
        choices: [
          {
            value: "none",
            label: "Aucun",
            description:
              "Personne ne peut entrer par la facturation. Les comptes se créent depuis l'administration, et chacun se connecte par mot de passe.",
          },
          { value: "hostbill", label: "HostBill" },
          { value: "whmcs", label: "WHMCS" },
          { value: "clientxcms", label: "ClientXCMS" },
          {
            value: "custom",
            label: "Sur mesure",
            description:
              "Votre propre boutique, qui appelle directement l'API applicative. Aucun plugin à installer : la documentation des routes est sur la page « API ».",
          },
        ],
      },
      {
        key: "billing.clientUrl",
        kind: "text",
        label: "Espace client",
        description:
          "Vers où renvoyer pour payer une facture, ou pour se connecter quand un lien a expiré. Sans cette adresse, le panel affiche l'échéance sans proposer de la régler.",
        placeholder: "https://facturation.exemple.fr/clientarea.php",
      },
      {
        key: "billing.apiUrl",
        kind: "text",
        label: "Adresse de l'API",
        description:
          "Facultative, et **en lecture seule** : elle sert au panel à montrer à chaque client ses services et ses échéances. Le sens inverse — créer, suspendre, supprimer — passe par le plugin. " +
          "HostBill : « …/admin/api.php ». WHMCS : « …/includes/api.php », en autorisant l'adresse IP du panel dans ses restrictions d'API. ClientXCMS : l'adresse du site.",
        placeholder: "https://facturation.exemple.fr/admin/api.php",
      },
      {
        key: "billing.apiId",
        kind: "text",
        label: "Identifiant d'API",
        description:
          "HostBill : créé sous « API access ». WHMCS : l'identifiant des « API Credentials ». ClientXCMS : à laisser vide, la clé suffit.",
      },
      {
        key: "billing.apiKey",
        kind: "secret",
        label: "Clé d'API",
        description:
          "Donne accès à l'ensemble des clients de la facturation : à réserver à un compte d'API en lecture. " +
          "ClientXCMS : un jeton limité aux capacités « customers:index », « customers:show » et « services:index ».",
      },
    ],
  },
  {
    key: "dns",
    label: "Sous-domaines des serveurs",
    description:
      "Chaque client peut donner à son serveur une adresse du type « monserveur.jeux.exemple.fr ». " +
      "Le panel la publie dans votre zone DNS et la tient à jour quand le port ou la machine du serveur change ; " +
      "elle disparaît avec le serveur. Minecraft Java reçoit aussi un enregistrement SRV : ses joueurs n'ont pas à saisir de port.",
    settings: [
      {
        key: "dns.provider",
        kind: "choice",
        label: "Fournisseur DNS",
        fallback: "none",
        choices: [
          {
            value: "none",
            label: "Aucun",
            description: "Les clients ne peuvent pas choisir de sous-domaine.",
          },
          { value: "cloudflare", label: "Cloudflare" },
        ],
      },
      {
        key: "dns.domain",
        kind: "text",
        label: "Domaine des serveurs",
        description:
          "Les sous-domaines se créent sous ce nom. Il doit appartenir à la zone ci-dessous : la zone elle-même, ou l'un de ses sous-domaines.",
        placeholder: "jeux.exemple.fr",
        format: "domain",
      },
      {
        key: "dns.zoneId",
        kind: "text",
        label: "Identifiant de zone",
        description:
          "Cloudflare : « Zone ID », dans la colonne de droite de la page d'accueil du domaine.",
        placeholder: "023e105f4ecef8ad9ca31a8372d0c353",
      },
      {
        key: "dns.apiToken",
        kind: "secret",
        format: "token",
        label: "Jeton d'API",
        description:
          "Cloudflare : un jeton limité à cette seule zone, avec les droits « Zone › DNS › Modifier » et « Zone › Zone › Lire ». " +
          "Jamais la clé globale du compte.",
      },
      {
        key: "dns.reservedLabels",
        kind: "text",
        label: "Noms réservés",
        description:
          "Refusés aux clients, en plus de ceux du panel (www, mail, panel, api, status, support…). Séparés par des virgules.",
        placeholder: "boutique, discord, forum",
      },
    ],
  },
];

/**
 * Ancre d'un groupe de réglages dans la page d'administration.
 *
 * Construite ici, et jamais écrite à la main ailleurs : le bandeau d'accueil
 * pointait vers `#reglages-hostbill` alors que le groupe s'appelle `billing`
 * depuis que la facturation n'est plus propre à HostBill. Le lien ouvrait la
 * page sans y descendre, et rien ne le signalait.
 */
export function settingsAnchor(groupKey: string): string {
  return `reglages-${groupKey}`;
}

/** Index plat, pour valider une clé reçue sans parcourir les groupes. */
export const SETTING_BY_KEY: ReadonlyMap<string, SettingDescriptor> = new Map(
  PLATFORM_SETTINGS.flatMap((group) => group.settings.map((s) => [s.key, s] as const)),
);

/**
 * Où chaque champ de la marque de la plateforme est rangé dans les réglages.
 *
 * Typé sur `BrandingOverrides` : un champ ajouté à la marque des revendeurs
 * sans son pendant ici ne compile pas. C'est ce qui manquait quand la
 * plateforme ne lisait que son nom et son accent.
 */
export const PLATFORM_BRAND_SETTINGS: Readonly<Record<keyof BrandingOverrides, string>> = {
  name: "brand.name",
  logoUrl: "brand.logoUrl",
  faviconUrl: "brand.faviconUrl",
  accent: "brand.accent",
  supportUrl: "brand.supportUrl",
  termsUrl: "brand.termsUrl",
  footerText: "brand.footerText",
  loginTagline: "brand.loginTagline",
  replyTo: "brand.replyTo",
};

export function isSecretSetting(key: string): boolean {
  return SETTING_BY_KEY.get(key)?.kind === "secret";
}

/**
 * Drapeaux de fonctionnalité connus.
 *
 * Distincts des réglages : un drapeau se déploie progressivement (pourcentage,
 * audience) et se retire d'un geste, là où un réglage décrit une configuration
 * durable. Les confondre ferait chercher le bouton d'urgence dans un
 * formulaire de configuration.
 */
/**
 * État d'un drapeau dont personne n'a encore décidé — **par drapeau**.
 *
 * Un défaut unique ne convenait pas, parce que les deux drapeaux ne posent pas
 * la même question. Le catalogue d'extensions ne fait qu'ouvrir un écran de
 * recherche : le fermer par défaut ferait disparaître une fonction en service
 * à la première mise à jour, sans que personne l'ait demandé.
 *
 * La création en libre-service, elle, **engage des ressources**. Ouverte par
 * défaut, une plateforme fraîchement installée laisse n'importe quel compte
 * créer des serveurs avant que l'exploitant ait fixé ses quotas — et
 * l'installation se découvre pleine avant d'avoir été configurée. Un défaut
 * qui coûte cher quand il se trompe se choisit fermé.
 *
 * Ce défaut est lu par l'écran **et** par les gardes : une seule source, sans
 * quoi l'interrupteur affiché et la porte réelle finiraient par se contredire.
 */
export const FEATURE_FLAGS: readonly {
  key: string;
  label: string;
  description: string;
  /** État tant que rien n'a été enregistré pour ce drapeau. */
  default: boolean;
}[] = [
  {
    key: "marketplace",
    label: "Catalogue d'extensions",
    // Quatre sources, pas une. Ne nommer que Modrinth laissait croire que
    // CurseForge et SpigotMC n'étaient pas servis — alors qu'ils le sont, et
    // que c'est justement la présence de CurseForge qui décide un exploitant
    // Minecraft moddé.
    description: "Recherche et installation depuis Modrinth, CurseForge et SpigotMC.",
    default: true,
  },
  {
    key: "server-creation",
    label: "Création de serveur en libre-service",
    description: "Ouvre l'assistant de création aux clients.",
    default: false,
  },
];

/**
 * Défaut d'un drapeau donné.
 *
 * Un drapeau inconnu rend **faux** : il ne décrit aucune fonction déclarée, et
 * une clé mal orthographiée dans une garde doit fermer la porte, pas l'ouvrir.
 */
export function featureFlagDefault(key: string): boolean {
  return FEATURE_FLAGS.find((flag) => flag.key === key)?.default ?? false;
}
