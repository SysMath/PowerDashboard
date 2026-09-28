<?php

/**
 * Module serveur WHMCS pour GameDashboard.
 *
 * Même travail que le module HostBill, dans le vocabulaire de WHMCS : des
 * **fonctions** préfixées du nom du module, et non une classe. Le client d'API
 * est le même fichier, à l'octet près — un contrôle du dépôt refuse qu'il
 * diverge d'un plugin à l'autre.
 *
 * Deux métiers, comme partout :
 *
 * 1. **le provisionnement** — une commande payée crée le compte puis le
 *    serveur, un impayé suspend, une résiliation supprime ;
 * 2. **la connexion** — le bouton « Gérer mon serveur » de l'espace client
 *    demande un lien à usage unique et y redirige. Vos clients n'ont pas de
 *    mot de passe sur le panel : ils s'authentifient ici.
 *
 * **L'ordre compte à la création** : le compte d'abord, le serveur ensuite. Le
 * panel refuse de créer un serveur sans propriétaire, et refuse d'ouvrir une
 * session pour un client qu'il ne connaît pas.
 *
 * ---
 *
 * WHMCS attend des retours précis, et ils ne se ressemblent pas d'une fonction
 * à l'autre : `'success'` ou un message pour les actions de provisionnement,
 * un tableau `['success' => bool, 'error' => string]` pour le test de
 * connexion. Rendre le mauvais type fait afficher « Module Command Error »
 * sans autre détail, ce qui est la pire manière d'échouer.
 */

if (!defined('WHMCS')) {
    die('Ce fichier ne s\'ouvre pas directement.');
}

require_once __DIR__ . '/GameDashboardClient.php';

use WHMCS\Database\Capsule;

/** Portées que le module emploie, et rien de plus. */
const GAMEDASHBOARD_SCOPES = [
    'users.read',
    'users.write',
    'users.sso',
    'servers.create',
    'servers.suspend',
    'servers.delete',
];

/** Champ personnalisé où l'identifiant du serveur est rangé. */
const GAMEDASHBOARD_CHAMP_SERVEUR = 'GameDashboard Server ID';

function gamedashboard_MetaData()
{
    return [
        'DisplayName' => 'GameDashboard',
        'APIVersion' => '1.1',
        // Le panel est un serveur distant qu'on déclare une fois : adresse et
        // clé applicative vivent dans la fiche serveur, pas dans le produit.
        'RequiresServer' => true,
        'DefaultNonSSLPort' => '443',
        'DefaultSSLPort' => '443',
        'ServiceSingleSignOnLabel' => 'Gérer mon serveur',
    ];
}

/**
 * Les réglages du **produit** : ce qui change d'une offre à l'autre.
 *
 * L'adresse du panel et la clé n'y sont pas : elles appartiennent au serveur,
 * et les répéter sur chaque produit multiplierait les endroits à corriger le
 * jour où la clé tourne.
 */
function gamedashboard_ConfigOptions()
{
    return [
        'Identifiant de l\'offre (egg)' => [
            'Type' => 'text',
            'Size' => '40',
            'Description' => 'Visible dans le panel sous Administration → Eggs.',
        ],
        'Identifiant du plan' => [
            'Type' => 'text',
            'Size' => '40',
            'Description' => 'Facultatif. Renseigné, il décide des ressources et les champs ci-dessous sont ignorés.',
        ],
        'Mémoire (Mo)' => ['Type' => 'text', 'Size' => '10', 'Default' => '2048'],
        'Disque (Mo)' => ['Type' => 'text', 'Size' => '10', 'Default' => '10240'],
        'CPU (%)' => ['Type' => 'text', 'Size' => '10', 'Default' => '100'],
        'Sauvegardes' => ['Type' => 'text', 'Size' => '10', 'Default' => '2'],
        'Bases de données' => ['Type' => 'text', 'Size' => '10', 'Default' => '1'],
        'Ports supplémentaires' => ['Type' => 'text', 'Size' => '10', 'Default' => '0'],
    ];
}

/**
 * Vérifie l'adresse, la clé **et** les portées, sans rien créer.
 *
 * Un essai par une vraie commande laisserait un serveur à supprimer à la main,
 * et ne dirait pas lequel des trois réglages est en cause.
 */
function gamedashboard_TestConnection(array $params)
{
    try {
        $identite = gamedashboard_client($params)->identity();
        $portees = $identite['data']['scopes'] ?? [];
        $manquantes = array_diff(GAMEDASHBOARD_SCOPES, is_array($portees) ? $portees : []);

        if ($manquantes !== []) {
            return [
                'success' => false,
                'error' => 'La clé fonctionne mais il lui manque des portées : '
                    . implode(', ', $manquantes)
                    . '. Les portées d\'une clé ne se modifient pas : créez-en une nouvelle.',
            ];
        }

        return ['success' => true, 'error' => ''];
    } catch (GameDashboardError $e) {
        return ['success' => false, 'error' => $e->getMessage()];
    }
}

/**
 * Une commande payée : le compte, puis le serveur.
 *
 * Les **clés d'idempotence** viennent de l'identifiant du service et de celui
 * du client, qui ne changent jamais. WHMCS rejoue volontiers — un
 * administrateur qui reclique sur « Create », une file de tâches reprise — et
 * sans elles chaque rejeu créerait un serveur de plus, facturé une fois.
 */
function gamedashboard_CreateAccount(array $params)
{
    try {
        $client = gamedashboard_client($params);
        $idClient = gamedashboard_client_id($params);
        $idService = (string) ($params['serviceid'] ?? '');

        if ($idClient === '' || $idService === '') {
            return 'Impossible d\'identifier le client ou le service dans WHMCS.';
        }

        $compte = gamedashboard_ensure_user($client, $params, $idClient);
        if (!isset($compte['id'])) {
            return 'Le panel n\'a pas rendu de compte exploitable.';
        }

        $charge = [
            'ownerId' => (string) $compte['id'],
            'eggId' => trim((string) ($params['configoption1'] ?? '')),
            'name' => gamedashboard_server_name($params),
        ];

        $plan = trim((string) ($params['configoption2'] ?? ''));
        if ($plan !== '') {
            $charge['planId'] = $plan;
        } else {
            $charge['resources'] = [
                'memoryMb' => (int) ($params['configoption3'] ?? 0),
                'diskMb' => (int) ($params['configoption4'] ?? 0),
                'cpuPct' => (int) ($params['configoption5'] ?? 0),
                'swapMb' => 0,
                'allocations' => (int) ($params['configoption8'] ?? 0),
                'backups' => (int) ($params['configoption6'] ?? 0),
                'databases' => (int) ($params['configoption7'] ?? 0),
            ];
        }

        $reponse = $client->createServer($charge, 'whmcs-service-' . $idService);
        $idServeur = (string) ($reponse['data']['id'] ?? '');

        /*
         * L'identifiant du serveur est rangé côté WHMCS.
         *
         * Sans lui, suspendre et supprimer devraient retrouver le serveur par
         * son nom — que le client peut changer depuis le panel. On suspendrait
         * alors le mauvais, ou plus probablement aucun, en silence.
         */
        gamedashboard_set_server_id($params, $idServeur);

        return 'success';
    } catch (GameDashboardError $e) {
        return $e->getMessage();
    }
}

/**
 * Retrouve ou crée le compte du client dans le panel.
 *
 * Trois cas, dans cet ordre :
 *
 * 1. le panel connaît déjà cet identifiant WHMCS — c'est lui ;
 * 2. il connaît l'adresse mais pas l'identifiant : **on rattache** plutôt que
 *    de créer un doublon. C'est le cas de toute reprise de parc ;
 * 3. il ne connaît rien : on crée.
 */
function gamedashboard_ensure_user(GameDashboardClient $client, array $params, string $idClient): array
{
    $trouve = $client->findUserByExternalId($idClient);
    if ($trouve !== null) {
        return $trouve;
    }

    $email = (string) ($params['clientsdetails']['email'] ?? '');

    $parEmail = $client->findUserByEmail($email);
    if ($parEmail !== null) {
        $client->linkExternalId((string) $parEmail['id'], $idClient);
        return $parEmail;
    }

    $cree = $client->createUser(
        $email,
        (string) ($params['clientsdetails']['firstname'] ?? ''),
        (string) ($params['clientsdetails']['lastname'] ?? ''),
        $idClient,
        'whmcs-client-' . $idClient
    );

    return $cree['data'] ?? [];
}

/** Impayé : le serveur s'arrête, les fichiers restent. */
function gamedashboard_SuspendAccount(array $params)
{
    return gamedashboard_set_suspension($params, true, 'Suspendu par la facturation (impayé).');
}

/** Paiement reçu : le serveur redevient utilisable. */
function gamedashboard_UnsuspendAccount(array $params)
{
    return gamedashboard_set_suspension($params, false, '');
}

function gamedashboard_set_suspension(array $params, bool $suspendu, string $raison)
{
    try {
        $id = gamedashboard_server_id($params);
        if ($id === '') {
            /*
             * Rien à suspendre : on le dit, plutôt que de rendre « success ».
             *
             * Un service marqué suspendu dans WHMCS alors que le serveur
             * tourne encore est la panne la plus coûteuse de cette
             * intégration : le client continue de jouer sans payer, et rien ne
             * le signale à personne.
             */
            return 'Aucun serveur GameDashboard n\'est rattaché à ce service.';
        }

        gamedashboard_client($params)->setSuspended($id, $suspendu, $raison);
        return 'success';
    } catch (GameDashboardError $e) {
        return $e->getMessage();
    }
}

/**
 * Résiliation : le serveur et ses fichiers disparaissent.
 *
 * Un serveur déjà absent du panel n'est **pas** une erreur : il a pu être
 * supprimé à la main. Rendre un échec bloquerait la résiliation dans WHMCS et
 * laisserait un service facturable sans rien derrière.
 */
function gamedashboard_TerminateAccount(array $params)
{
    try {
        $id = gamedashboard_server_id($params);
        if ($id === '') {
            return 'success';
        }

        try {
            gamedashboard_client($params)->deleteServer($id);
        } catch (GameDashboardNotFound $e) {
            // Déjà parti. La résiliation continue.
        }

        gamedashboard_set_server_id($params, '');
        return 'success';
    } catch (GameDashboardError $e) {
        return $e->getMessage();
    }
}

/**
 * Les boutons de la fiche du service, côté administration.
 *
 * WHMCS n'appelle aucun module quand un service change de client (« Move
 * Product/Service ») : le serveur restait au titulaire d'origine, qui gardait
 * sa console, et le nouveau client ne le voyait pas. Ce bouton rattrape le
 * déplacement, en un clic, à lancer après chaque transfert.
 *
 * Le libellé est la clé, le suffixe de la fonction la valeur : WHMCS appelle
 * `gamedashboard_<valeur>($params)` et attend `'success'` ou un message.
 */
function gamedashboard_AdminCustomButtonArray()
{
    return [
        'Donner le serveur au client actuel' => 'ReassignOwner',
    ];
}

/**
 * Donne le serveur au client qui porte **aujourd'hui** le service dans WHMCS.
 *
 * `$params['userid']` est déjà le nouveau client après un déplacement : c'est
 * lui qu'on retrouve ou crée dans le panel, comme à la commande, puis à qui
 * l'on donne le serveur. Relancer le bouton ne fait rien de plus.
 */
function gamedashboard_ReassignOwner(array $params)
{
    try {
        $id = gamedashboard_server_id($params);
        if ($id === '') {
            return 'Aucun serveur GameDashboard n\'est rattaché à ce service.';
        }

        $idClient = gamedashboard_client_id($params);
        if ($idClient === '') {
            return 'Impossible d\'identifier le client dans WHMCS.';
        }

        $client = gamedashboard_client($params);
        $compte = gamedashboard_ensure_user($client, $params, $idClient);
        if (!isset($compte['id'])) {
            return 'Le panel n\'a pas rendu de compte exploitable.';
        }

        $client->setServerOwner($id, (string) $compte['id']);
        return 'success';
    } catch (GameDashboardError $e) {
        return $e->getMessage();
    }
}

/**
 * L'ouverture de session, telle que WHMCS l'attend.
 *
 * **C'est WHMCS qui redirige**, pas nous : la fonction rend l'URL et il s'en
 * charge. Une première version posait un en-tête `Location` et sortait par
 * `exit` — un motif emprunté à HostBill, qui n'est pas celui d'ici et aurait
 * court-circuité la journalisation et la gestion d'erreur de WHMCS.
 *
 * Le triplet de retour est imposé : `success`, `redirectTo`, `errorMsg`.
 * Rendre autre chose afficherait un échec sans raison affichée.
 *
 * Le lien n'est ni affiché, ni mis en cache, ni journalisé : il vaut deux
 * minutes et ouvre une session.
 */
function gamedashboard_ServiceSingleSignOn(array $params)
{
    try {
        $url = gamedashboard_client($params)->ssoLink(gamedashboard_client_id($params));
        return ['success' => true, 'redirectTo' => $url];
    } catch (GameDashboardError $e) {
        logModuleCall('gamedashboard', __FUNCTION__, $params, $e->getMessage());
        return ['success' => false, 'errorMsg' => $e->getMessage()];
    }
}

/**
 * Le bouton sur la fiche du service, dans l'espace client.
 *
 * WHMCS déclenche l'ouverture de session par une adresse convenue —
 * `…&dosinglesignon=1` — et non par un bouton personnalisé : un bouton
 * personnalisé appelle une fonction du module et attend un gabarit en retour,
 * pas une redirection.
 *
 * Le gabarit `clientarea.tpl` livré à côté ne fait qu'afficher ce lien.
 */
function gamedashboard_ClientArea(array $params)
{
    return [
        'templatefile' => 'clientarea',
        'vars' => [
            'ssoUrl' => 'clientarea.php?action=productdetails&id='
                . (int) ($params['serviceid'] ?? 0) . '&dosinglesignon=1',
        ],
    ];
}

function gamedashboard_client(array $params): GameDashboardClient
{
    /*
     * L'adresse se construit à partir de la fiche serveur.
     *
     * `serverhostname` de préférence à `serverip` : un certificat TLS répond
     * d'un nom, pas d'une adresse, et le client refuse — à raison — un
     * certificat qui ne correspond pas. La vérification n'est jamais
     * désactivée : le jeton applicatif voyage dans l'en-tête.
     */
    $hote = trim((string) ($params['serverhostname'] ?? ''));
    if ($hote === '') {
        $hote = trim((string) ($params['serverip'] ?? ''));
    }

    $schema = !empty($params['serversecure']) ? 'https' : 'http';
    if (preg_match('#^https?://#i', $hote)) {
        $base = $hote;
    } else {
        $base = $schema . '://' . $hote;
    }

    /*
     * La clé applicative est lue dans `serveraccesshash`, puis
     * `serverpassword` en repli.
     *
     * WHMCS chiffre les deux champs de la même façon ; le « access hash » est
     * celui prévu pour une clé d'API, et c'est là qu'un intégrateur la
     * cherchera. Le repli évite qu'une installation où elle a été saisie dans
     * le champ mot de passe échoue sans rien expliquer.
     */
    $cle = trim((string) ($params['serveraccesshash'] ?? ''));
    if ($cle === '') {
        $cle = trim((string) ($params['serverpassword'] ?? ''));
    }

    return new GameDashboardClient($base, $cle);
}

/**
 * Identifiant du client chez WHMCS.
 *
 * `$params['userid']` est la source : la documentation le donne comme
 * `tblclients.id`. `clientsdetails` porte l'état civil — nom, adresse,
 * courriel — et le chercher là dépendrait d'une clé que la documentation ne
 * garantit pas.
 *
 * C'est cet identifiant qui devient l'`externalId` du compte dans le panel :
 * s'il changeait de source, tous les clients paraîtraient inconnus et le
 * module leur créerait des comptes en double.
 */
function gamedashboard_client_id(array $params): string
{
    return (string) ($params['userid'] ?? '');
}

/**
 * Nom du serveur créé.
 *
 * Le domaine du service quand il y en a un, sinon « Serveur #<numéro> ». Un nom
 * vide produirait une liste de serveurs indistincts dans le panel du client dès
 * qu'il en a deux.
 *
 * Le nom du produit n'y figure pas, et ce n'est pas un oubli : WHMCS ne le
 * passe pas aux modules. `producttype` existe mais vaut `hostingaccount`,
 * `reselleraccount`, `server` ou `other` — s'en servir aurait nommé tous les
 * serveurs « other ».
 */
function gamedashboard_server_name(array $params): string
{
    $domaine = trim((string) ($params['domain'] ?? ''));
    if ($domaine !== '') {
        return $domaine;
    }

    return 'Serveur #' . (string) ($params['serviceid'] ?? '');
}

/** Identifiant du serveur, lu dans le champ personnalisé du produit. */
function gamedashboard_server_id(array $params): string
{
    $champs = $params['customfields'] ?? [];
    return is_array($champs) ? trim((string) ($champs[GAMEDASHBOARD_CHAMP_SERVEUR] ?? '')) : '';
}

/**
 * Écrit l'identifiant du serveur dans le champ personnalisé.
 *
 * WHMCS n'offre pas d'API de module pour cela : on écrit dans
 * `tblcustomfieldsvalues`, comme le font les modules de l'écosystème. Le champ
 * doit exister sur le produit, créé une fois à la main — la notice le dit, et
 * le module échoue en le nommant plutôt qu'en se taisant.
 *
 * L'échec d'écriture **n'interrompt pas** la création : le serveur existe, et
 * remonter une erreur ferait recommencer WHMCS, qui en créerait un second.
 * Mieux vaut un serveur rattaché à la main qu'un serveur en double.
 */
function gamedashboard_set_server_id(array $params, string $idServeur): void
{
    try {
        $champ = Capsule::table('tblcustomfields')
            ->where('type', 'product')
            ->where('relid', (int) ($params['pid'] ?? 0))
            ->where('fieldname', 'LIKE', GAMEDASHBOARD_CHAMP_SERVEUR . '%')
            ->first();

        if (!$champ) {
            logModuleCall(
                'gamedashboard',
                'set_server_id',
                ['pid' => $params['pid'] ?? null],
                'Champ personnalisé « ' . GAMEDASHBOARD_CHAMP_SERVEUR . ' » absent du produit : '
                    . 'le serveur ' . $idServeur . ' ne pourra pas être suspendu ni supprimé automatiquement.'
            );
            return;
        }

        Capsule::table('tblcustomfieldsvalues')
            ->updateOrInsert(
                ['fieldid' => $champ->id, 'relid' => (int) ($params['serviceid'] ?? 0)],
                ['value' => $idServeur]
            );
    } catch (Throwable $e) {
        logModuleCall('gamedashboard', 'set_server_id', $idServeur, $e->getMessage());
    }
}
