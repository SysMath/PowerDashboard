/**
 * Vocabulaire du journal d'audit (§5.4).
 *
 * Les noms d'événements sont stockés tels quels en base, pour toujours : ce
 * sont des identifiants, pas des messages. Les renommer réécrirait l'histoire,
 * ou plus exactement la rendrait illisible — les anciennes lignes garderaient
 * l'ancien nom, et plus rien ne les rattacherait aux nouvelles.
 *
 * La traduction en français vit donc à part, et peut changer librement.
 */

export const ACTIVITY_CATEGORIES = [
  "power",
  "console",
  "files",
  "backups",
  "databases",
  "network",
  "access",
  "schedules",
  "settings",
  "account",
] as const;

export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];

interface ActivityDescriptor {
  category: ActivityCategory;
  label: string;
}

/**
 * Événements connus.
 *
 * Un événement absent de cette table reste **affiché** : le journal est en
 * ajout seul et doit rester lisible même après une mise à jour qui aurait
 * introduit un nom que cette version ne connaît pas. Il apparaît alors sous
 * son identifiant brut, ce qui est laid mais honnête — masquer la ligne
 * reviendrait à effacer une trace d'audit à l'affichage.
 */
export const ACTIVITY_EVENTS: Record<string, ActivityDescriptor> = {
  "server.power": { category: "power", label: "Alimentation" },
  "server.command": { category: "console", label: "Commande envoyée" },
  // Vue joueurs : l'action et le joueur sont dans les propriétés de la ligne.
  "server.player": { category: "console", label: "Joueur modéré" },
  "server.rename": { category: "settings", label: "Serveur renommé" },
  "server.variables": { category: "settings", label: "Variables de démarrage modifiées" },
  "server.behaviour": { category: "settings", label: "Comportement modifié" },
  "server.reinstall": { category: "settings", label: "Réinstallation lancée" },
  /*
   * Le moteur, et le contrat qui va avec.
   *
   * Les trois sont distincts à dessein. Qui relit ce journal pour savoir
   * pourquoi un serveur ne démarre plus cherche « acceptation », pas
   * « moteur installé » — et l'acceptation et son retrait ne doivent pas
   * se confondre non plus, puisque l'un autorise et l'autre empêche.
   */
  "engine.install": { category: "settings", label: "Moteur du serveur remplacé" },
  // L'installation part en tâche de fond : son échec arrive après la réponse,
  // et le journal est le seul endroit où il reste une fois l'écran fermé.
  "engine.install_failed": { category: "settings", label: "Changement de moteur échoué" },
  "server.eula_accepted": { category: "settings", label: "Contrat de licence accepté" },
  "server.eula_reset": {
    category: "settings",
    label: "Acceptation du contrat retirée (moteur remplacé)",
  },

  "files.write": { category: "files", label: "Fichier enregistré" },
  "files.rename": { category: "files", label: "Fichier renommé" },
  "files.chmod": { category: "files", label: "Permissions de fichier modifiées" },
  "files.delete": { category: "files", label: "Fichier supprimé" },
  "files.create-directory": { category: "files", label: "Dossier créé" },
  "files.compress": { category: "files", label: "Archive créée" },
  "files.decompress": { category: "files", label: "Archive extraite" },
  // L'autorisation, et non l'envoi : le fichier part du navigateur vers le
  // daemon sans repasser par le panel, qui ne peut donc attester que du droit
  // qu'il a accordé. Le nommer « fichier envoyé » affirmerait ce qu'on ignore.
  "files.upload-grant": { category: "files", label: "Envoi de fichier autorisé" },
  /*
   * Distinct de `files.upload-grant`, et les deux se justifient.
   *
   * L'autorisation dit « quelqu'un a demandé à déposer » — elle est écrite
   * même si rien n'arrive ensuite, parce que le dépôt se fait alors
   * directement chez le daemon, que le panel ne voit pas.
   *
   * Celui-ci dit « un fichier est arrivé, et voici lequel » : c'est le chemin
   * reprenable, où le panel assemble lui-même et sait donc ce qu'il a écrit.
   */
  "files.upload": { category: "files", label: "Fichier envoyé" },
  "files.download": { category: "files", label: "Fichier téléchargé" },
  // Envoyés par le daemon : ils décrivent ce qui s'est passé hors du panel.
  "server:sftp.write": { category: "files", label: "Fichier écrit par SFTP" },
  "server:sftp.delete": { category: "files", label: "Fichier supprimé par SFTP" },
  "server:sftp.create": { category: "files", label: "Fichier créé par SFTP" },
  "server:sftp.create-directory": { category: "files", label: "Dossier créé par SFTP" },
  "server:sftp.rename": { category: "files", label: "Fichier renommé par SFTP" },

  "backup.create": { category: "backups", label: "Sauvegarde lancée" },
  "backup.restore": { category: "backups", label: "Sauvegarde restaurée" },
  // Rapportés par le daemon en fin de restauration (NC-44).
  "backup.restore_completed": { category: "backups", label: "Restauration terminée" },
  "backup.restore_failed": { category: "backups", label: "Restauration échouée" },
  "backup.delete": { category: "backups", label: "Sauvegarde supprimée" },
  "backup.lock": { category: "backups", label: "Verrou de sauvegarde modifié" },
  /**
   * Emporter une archive, c'est emporter tout le serveur — fichiers de
   * configuration, mots de passe RCON et clés d'API compris. La route le
   * consignait déjà, et disait en commentaire que c'était « exactement le genre
   * de geste qu'on veut retrouver dans un journal ». Il s'y retrouvait sous son
   * identifiant brut.
   */
  "backup.download": { category: "backups", label: "Sauvegarde téléchargée" },

  "database.create": { category: "databases", label: "Base de données créée" },
  "database.rotate": { category: "databases", label: "Mot de passe de base régénéré" },
  "database.password": { category: "databases", label: "Mot de passe de base consulté" },
  "database.delete": { category: "databases", label: "Base de données supprimée" },

  "allocation.claim": { category: "network", label: "Port attribué" },
  "allocation.primary": { category: "network", label: "Port principal changé" },
  "allocation.notes": { category: "network", label: "Port annoté" },
  "allocation.release": { category: "network", label: "Port libéré" },

  "subuser.invite": { category: "access", label: "Sous-utilisateur invité" },
  "subuser.invite_sent": { category: "access", label: "Invitation envoyée par courriel" },
  "subuser.invite_accepted": { category: "access", label: "Invitation acceptée" },
  "subuser.invite_revoked": { category: "access", label: "Invitation annulée" },
  "subuser.update": { category: "access", label: "Permissions modifiées" },
  "subuser.delete": { category: "access", label: "Accès retiré" },

  "schedule.create": { category: "schedules", label: "Tâche planifiée créée" },
  "schedule.update": { category: "schedules", label: "Tâche planifiée modifiée" },
  "schedule.active": { category: "schedules", label: "Tâche activée ou mise en pause" },
  "schedule.run": { category: "schedules", label: "Exécution immédiate demandée" },
  "schedule.delete": { category: "schedules", label: "Tâche planifiée supprimée" },
  "schedule.failed": { category: "schedules", label: "Exécution planifiée en échec" },

  "marketplace.install": { category: "files", label: "Extension installée" },
  "marketplace.uninstall": { category: "files", label: "Extension désinstallée" },

  /*
   * Rappels sortants déclarés par le client sur son serveur.
   *
   * Classés en `settings` et non en `access` : ils ne donnent aucun droit sur
   * le serveur. Ils envoient de l'information vers l'extérieur, ce qui est une
   * question de configuration — et, pour la régénération du secret, de sécurité
   * du destinataire, pas de l'accès au panel.
   */
  "webhook.create": { category: "settings", label: "Rappel sortant déclaré" },
  "webhook.update": { category: "settings", label: "Rappel sortant modifié" },
  "webhook.rotate": { category: "settings", label: "Secret de rappel renouvelé" },
  "webhook.delete": { category: "settings", label: "Rappel sortant supprimé" },

  /**
   * Événements de compte, sans serveur rattaché.
   *
   * Aucun écran ne les liste encore — le journal visible est celui d'un
   * serveur. Ils sont consignés quand même : le jour où un compte est
   * compromis, la question posée est « quand le mot de passe a-t-il changé, et
   * depuis quelle adresse », et une trace qui commence le jour où on ouvre
   * l'écran ne répond à rien.
   */
  // Toute ouverture de session, quel qu'en soit le chemin. Le pays y est noté
  // quand un frontal de confiance l'a fourni : c'est ce qui permet de
  // reconnaître un « nouveau pays » sans colonne dédiée.
  "account.login": { category: "account", label: "Connexion" },
  // Une preuve refusée, avec l'étape (mot de passe, second facteur, clé
  // d'accès, confirmation) et jamais le secret essayé. Seulement sur un compte
  // existant : une adresse inconnue n'a pas d'historique où la ranger.
  "account.login_failed": { category: "account", label: "Échec de connexion" },
  // Consigné au franchissement du seuil, pas à chaque tentative refusée.
  "account.locked": { category: "account", label: "Connexions suspendues après trop d'échecs" },
  "account.password": { category: "account", label: "Mot de passe modifié" },
  "account.2fa_enabled": { category: "account", label: "Double authentification activée" },
  "account.2fa_disabled": { category: "account", label: "Double authentification désactivée" },
  "account.recovery_code_used": { category: "account", label: "Code de secours utilisé" },
  "account.passkey_added": { category: "account", label: "Clé d'accès enregistrée" },
  "account.passkey_removed": { category: "account", label: "Clé d'accès supprimée" },
  "account.sso_login": { category: "account", label: "Connexion par authentification unique" },
  "account.sso_created": { category: "account", label: "Compte créé par authentification unique" },
  "account.google_login": { category: "account", label: "Connexion avec Google" },
  "account.google_created": { category: "account", label: "Compte créé avec Google" },
  "account.registered": { category: "account", label: "Compte créé" },
  "account.password_reset_requested": {
    category: "account",
    label: "Réinitialisation de mot de passe demandée",
  },
  "account.ssh_key_added": { category: "account", label: "Clé SSH ajoutée" },
  "account.ssh_key_removed": { category: "account", label: "Clé SSH retirée" },
  "account.password_reset": { category: "account", label: "Mot de passe réinitialisé" },
  "account.email_verified": { category: "account", label: "Adresse confirmée" },
  // Consigné sur le compte **du client**, et non sur celui de l'agent : la
  // question posée après coup est « qui est entré chez moi », pas « qu'ai-je
  // fait de ma journée ».
  "account.impersonation_started": {
    category: "account",
    label: "Prise en main par un membre du personnel",
  },
  "account.impersonation_ended": { category: "account", label: "Fin de la prise en main" },

  /**
   * Refus consignés (NC-12), au journal de la plateforme seulement.
   *
   * Les gardes refusaient en silence : un jeton de node volé essayé
   * d'ailleurs, un compte qui parcourt les identifiants de serveur, une clé
   * révoquée encore présentée — rien ne s'en voyait. Un refus répété ne
   * s'écrit qu'à sa 1ʳᵉ, 10ᵉ, 100ᵉ… occurrence (`occurrences`).
   */
  "access.denied": { category: "access", label: "Accès refusé" },
  "application.key_rejected": { category: "access", label: "Clé applicative refusée" },
  "node.token_rejected": { category: "access", label: "Jeton de node refusé" },

  /**
   * Gestes d'administration de la plateforme.
   *
   * Classés en `access` quand ils créent ou retirent un moyen d'entrer, en
   * `settings` quand ils changent une configuration. La distinction sert au
   * filtre du journal : on cherche rarement « qui a touché à quelque chose »,
   * presque toujours « qui a obtenu un accès ».
   */
  "admin.incident_opened": { category: "settings", label: "Incident ouvert" },
  "admin.incident_updated": { category: "settings", label: "Incident mis à jour" },

  /**
   * Mise à jour autonome d'un hébergement cPanel (apps/api/src/modules/updates) :
   * les gestes de l'administration, et ce que le panel fait de lui-même.
   */
  "admin.update_check_requested": {
    category: "settings",
    label: "Recherche de mise à jour demandée",
  },
  "admin.update_rolled_back": { category: "settings", label: "Retour à la version précédente" },
  "admin.update_installed": { category: "settings", label: "Mise à jour installée" },
  "admin.update_refused": { category: "settings", label: "Mise à jour mise de côté" },

  /*
   * Chaque route d'écriture de l'administration, consignée (rapport ASVS,
   * NC-11). Rôle, suppression de compte, réglages de la plateforme,
   * suspension : aucun de ces gestes ne laissait de trace, et « qui a
   * désactivé la seconde preuve du personnel » n'avait pas de réponse.
   */
  "admin.settings_saved": { category: "settings", label: "Réglages de la plateforme enregistrés" },
  "admin.brand_image_uploaded": {
    category: "settings",
    label: "Logo ou favicon de la plateforme envoyé",
  },
  "admin.feature_flag_set": { category: "settings", label: "Fonctionnalité activée ou coupée" },
  "admin.announcement_saved": { category: "settings", label: "Annonce publiée ou modifiée" },
  "admin.announcement_deleted": { category: "settings", label: "Annonce supprimée" },
  // Un montage ouvre au conteneur un dossier de la machine hôte : c'est un
  // accès, pas une configuration.
  "admin.mount_created": { category: "access", label: "Montage créé" },
  "admin.mount_updated": { category: "access", label: "Montage modifié" },
  "admin.mount_deleted": { category: "access", label: "Montage supprimé" },
  "admin.mount_attached": { category: "access", label: "Montage attaché au serveur" },
  "admin.mount_detached": { category: "access", label: "Montage détaché du serveur" },
  "admin.database_host_tested": { category: "databases", label: "Hôte de bases éprouvé" },
  "admin.database_host_created": { category: "databases", label: "Hôte de bases déclaré" },
  "admin.database_host_updated": { category: "databases", label: "Hôte de bases modifié" },
  "admin.database_host_deleted": { category: "databases", label: "Hôte de bases supprimé" },
  "admin.user_created": { category: "account", label: "Compte créé par l'administration" },
  "admin.user_role_changed": { category: "access", label: "Rôle d'un compte changé" },
  "admin.reseller_quota_set": {
    category: "account",
    label: "Enveloppe de revendeur posée par l'administration",
  },
  "admin.user_sessions_revoked": {
    category: "access",
    label: "Sessions d'un compte fermées par l'administration",
  },
  "admin.user_deleted": { category: "account", label: "Compte supprimé par l'administration" },
  "admin.server_runtime_changed": {
    category: "settings",
    label: "Image ou commande de démarrage changée par l'administration",
  },
  "admin.server_egg_changed": {
    category: "settings",
    label: "Jeu du serveur changé par l'administration",
  },
  "admin.server_transfer_started": { category: "settings", label: "Transfert du serveur lancé" },
  "admin.server_variable_set": {
    category: "settings",
    label: "Variable du serveur écrite par l'administration",
  },
  "admin.server_suspended": { category: "power", label: "Serveur suspendu par l'administration" },
  "admin.server_resumed": { category: "power", label: "Serveur rétabli par l'administration" },
  "admin.server_deleted": { category: "settings", label: "Serveur supprimé par l'administration" },
  "admin.node_category_created": { category: "settings", label: "Catégorie de nodes créée" },
  "admin.node_category_removed": { category: "settings", label: "Catégorie de nodes supprimée" },
  "admin.node_subcategory_created": {
    category: "settings",
    label: "Sous-catégorie de nodes créée",
  },
  "admin.node_subcategory_removed": {
    category: "settings",
    label: "Sous-catégorie de nodes supprimée",
  },
  "admin.location_created": { category: "settings", label: "Localisation créée" },
  "admin.location_removed": { category: "settings", label: "Localisation supprimée" },
  // Activer un egg, c'est déclarer avoir relu son script d'installation
  // (§8.3) ; un dépôt suivi fournit des scripts exécutés sur les nodes.
  "admin.egg_enabled_set": { category: "settings", label: "Egg activé ou désactivé" },
  "admin.egg_imported": { category: "settings", label: "Egg importé" },
  "admin.egg_source_added": { category: "settings", label: "Dépôt d'eggs ajouté" },
  "admin.egg_source_removed": { category: "settings", label: "Dépôt d'eggs retiré" },
  "admin.egg_source_synced": { category: "settings", label: "Dépôt d'eggs synchronisé" },
  "admin.webhook_active_set": {
    category: "settings",
    label: "Rappel sortant activé ou suspendu",
  },

  /**
   * Ce que fait le système de facturation, par l'API applicative.
   *
   * Ces neuf-là n'avaient aucun libellé : le contrôle de couverture cherchait
   * `this.log(a, b, "événement")` et ne voyait pas `this.trace(request,
   * "événement")`, si bien que toute l'API applicative lui échappait. Le
   * journal affichait donc `application.user_created` tel quel à l'écran.
   *
   * Ce sont pourtant les lignes qu'on relit le plus : quand un client affirme
   * n'avoir rien commandé, ou qu'un serveur a disparu, c'est ici qu'on
   * retrouve ce que la boutique a demandé et quand.
   */
  "application.user_created": { category: "account", label: "Compte créé par la facturation" },
  "application.user_updated": { category: "account", label: "Compte modifié par la facturation" },
  "application.user_deleted": { category: "account", label: "Compte supprimé par la facturation" },
  "application.server_created": { category: "settings", label: "Serveur créé par la facturation" },
  "admin.server_resized": {
    category: "settings",
    label: "Limites du serveur changées par l'administration",
  },
  "application.server_resized": {
    category: "settings",
    label: "Limites du serveur changées par la facturation",
  },
  "application.server_deleted": {
    category: "settings",
    label: "Serveur supprimé par la facturation",
  },
  "application.server_suspended": {
    category: "power",
    label: "Serveur suspendu par la facturation",
  },
  "application.server_resumed": { category: "power", label: "Serveur rétabli par la facturation" },
  "application.reseller_quota_set": {
    category: "account",
    label: "Enveloppe de revendeur posée par la facturation",
  },
  /**
   * L'entrée d'un client dans le panel, depuis son espace de facturation.
   *
   * C'est **le** chemin d'entrée ordinaire : le client n'a pas de mot de passe
   * ici. La ligne dit qu'un lien a été émis — pas qu'il a servi, la session
   * s'ouvrant, elle, par le chemin commun à toutes les connexions.
   */
  "application.sso_link_issued": {
    category: "access",
    label: "Lien de connexion émis pour un client",
  },

  "admin.application_key_created": { category: "access", label: "Clé applicative créée" },
  "admin.application_key_revoked": { category: "access", label: "Clé applicative révoquée" },
  "admin.node_bootstrap_key_issued": {
    category: "access",
    label: "Clé d'amorçage de node émise",
  },
  "admin.webhook_created": { category: "settings", label: "Rappel sortant créé" },
  "admin.webhook_deleted": { category: "settings", label: "Rappel sortant supprimé" },
  "admin.webhook_secret_rotated": {
    category: "settings",
    label: "Secret de rappel sortant renouvelé",
  },
  "admin.server_owner_changed": {
    category: "account",
    label: "Propriétaire d'un serveur changé",
  },
  "admin.smtp_tested": { category: "settings", label: "Envoi de courrier éprouvé" },
  "admin.billing_tested": { category: "settings", label: "Liaison avec la facturation éprouvée" },
  "admin.audit_exported": { category: "access", label: "Journal de la plateforme exporté" },
  "admin.subuser_presets_saved": {
    category: "access",
    label: "Presets de sous-utilisateurs redéfinis",
  },
  "admin.subuser_presets_reset": {
    category: "access",
    label: "Presets de sous-utilisateurs rétablis",
  },
  "admin.egg_updated": { category: "settings", label: "Egg modifié" },
  "node.configuration_read": { category: "settings", label: "Configuration de node consultée" },
  "node.settings_updated": { category: "settings", label: "Réglages d'un node modifiés" },
  "node.binding_changed": {
    category: "settings",
    label: "Adresse ou ports d'un node changés (confirmés par le daemon)",
  },
  "node.binding_pending_restart": {
    category: "settings",
    label: "Adresse ou ports d'un node : configuration écrite, Wings à redémarrer",
  },
  "node.binding_refused": {
    category: "settings",
    label: "Adresse ou ports d'un node : daemon injoignable, rien changé",
  },
  "node.allocations_removed": { category: "network", label: "Ports retirés du stock d'un node" },
  "node.allocations_added": { category: "network", label: "Ports ajoutés au stock d'un node" },
  "node.created": { category: "settings", label: "Node déclaré" },
  "node.removed": { category: "settings", label: "Node supprimé" },
  "node.maintenance_set": { category: "settings", label: "Maintenance d'un node activée ou levée" },
  "node.share_set": { category: "settings", label: "Part d'un node accordée à un revendeur" },
  "node.share_removed": { category: "settings", label: "Part d'un node retirée à un revendeur" },
  "node.owner_changed": {
    category: "access",
    label: "Node attribué à un revendeur ou rendu à la plateforme",
  },
  // Nommés par une condition, ils échappaient au contrôle de couverture et
  // s'affichaient sous leur identifiant brut.
  "node.token_rotated": { category: "access", label: "Jeton d'un node renouvelé" },
  "node.token_rotation_failed": {
    category: "access",
    label: "Renouvellement du jeton d'un node : daemon injoignable, rien changé",
  },
  "admin.user_updated": { category: "account", label: "Compte modifié par l'administration" },
  "admin.user_password_reset_sent": {
    category: "access",
    label: "Lien de réinitialisation envoyé par l'administration",
  },
  "admin.user_suspended": { category: "access", label: "Compte suspendu" },
  "admin.user_unsuspended": { category: "access", label: "Compte réactivé" },
  "application.domain_certificate_reported": {
    category: "network",
    label: "Certificat de domaine : tentative rapportée",
  },
  "server.docker_image": { category: "settings", label: "Image Docker changée" },

  /** Événements d'un revendeur sur son propre parc. */
  "reseller.server_suspended": {
    category: "power",
    label: "Serveur suspendu par son revendeur",
  },
  "reseller.server_resumed": {
    category: "power",
    label: "Serveur rétabli par son revendeur",
  },
  "reseller.server_resized": {
    category: "settings",
    label: "Limites du serveur changées par son revendeur",
  },
  "reseller.server_deleted": {
    category: "settings",
    label: "Serveur supprimé par son revendeur",
  },
  "reseller.platform_access_set": {
    category: "account",
    label: "Accès de la plateforme au parc du revendeur modifié",
  },
  "reseller.key_created": { category: "access", label: "Clé applicative émise par le revendeur" },
  "reseller.key_revoked": {
    category: "access",
    label: "Clé applicative révoquée par le revendeur",
  },
  "reseller.webhook_created": {
    category: "settings",
    label: "Rappel sortant déclaré par le revendeur",
  },
  "reseller.webhook_deleted": {
    category: "settings",
    label: "Rappel sortant supprimé par le revendeur",
  },
  "reseller.webhook_secret_rotated": {
    category: "settings",
    label: "Secret de rappel du revendeur renouvelé",
  },
  "reseller.webhook_active_set": {
    category: "settings",
    label: "Rappel sortant du revendeur activé ou suspendu",
  },
  "reseller.branding_saved": { category: "settings", label: "Marque du revendeur enregistrée" },
  "reseller.branding_image_uploaded": {
    category: "settings",
    label: "Logo ou favicon du revendeur envoyé",
  },
  "reseller.domain_declared": { category: "network", label: "Domaine de revendeur déclaré" },
  "reseller.domain_verified": { category: "network", label: "Domaine de revendeur vérifié" },
  "reseller.domain_check_failed": {
    category: "network",
    label: "Vérification du domaine de revendeur en échec",
  },
};

export function describeActivity(event: string): ActivityDescriptor {
  return ACTIVITY_EVENTS[event] ?? { category: "settings", label: event };
}

export const ACTIVITY_CATEGORY_LABELS: Record<ActivityCategory, string> = {
  power: "Alimentation",
  console: "Console",
  files: "Fichiers",
  backups: "Sauvegardes",
  databases: "Bases de données",
  network: "Réseau",
  access: "Accès",
  schedules: "Planification",
  settings: "Paramètres",
  account: "Compte",
};
