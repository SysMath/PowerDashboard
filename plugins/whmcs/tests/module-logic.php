<?php

/*
 * Tout est en blocs `namespace` : PHP exige qu'une déclaration d'espace de
 * noms soit la toute première instruction du fichier, et il en faut un pour
 * loger le faux `Capsule` là où le module le cherche.
 */

/** `Capsule` simulé : le module ne s'en sert que pour le champ personnalisé. */
namespace WHMCS\Database {
    class Capsule
    {
        public static array $ecritures = [];
        public static bool $champExiste = true;

        public static function table(string $nom)
        {
            return new FausseTable($nom);
        }
    }

    class FausseTable
    {
        public function __construct(private string $nom)
        {
        }

        public function where(...$args): self
        {
            return $this;
        }

        public function first()
        {
            return Capsule::$champExiste ? (object) ['id' => 7] : null;
        }

        public function updateOrInsert(array $cle, array $valeurs): void
        {
            Capsule::$ecritures[] = $valeurs['value'];
        }
    }
}

namespace {

/**
 * Éprouve le module WHMCS **tel qu'il sera livré**.
 *
 * WHMCS est propriétaire et ne s'installe pas pour un essai. Ce banc simule
 * donc le peu dont le module dépend — la constante `WHMCS`, `Capsule`,
 * `logModuleCall` — et fait parler le module à un **vrai panel de poche**
 * servi en HTTP (`faux-panel.php`).
 *
 * Le détour par HTTP est délibéré. Remplacer le client d'API par un objet
 * simulé aurait obligé à neutraliser `gamedashboard_client()`, donc à éprouver
 * un code légèrement différent de celui qu'on livre. Ici rien n'est remplacé :
 * en-têtes, encodage JSON, codes de statut et clés d'idempotence passent par
 * le vrai chemin.
 *
 * Ce qu'il vérifie en propre au module : l'ordre des gestes, les refus, et
 * **les valeurs de retour**. Ces retours méritent leur propre contrôle — WHMCS
 * attend `'success'` ou un message pour les actions, un tableau pour le test
 * de connexion, et rendre le mauvais type affiche « Module Command Error »
 * sans autre détail.
 *
 * Lancement : `php tests/module-logic.php` depuis `plugins/whmcs/`.
 */

define('WHMCS', true);

/** Journal de module simulé : WHMCS l'expose globalement. */
function logModuleCall($module, $action, $requete, $reponse)
{
    $GLOBALS['journal'][] = (string) $action;
}

require_once __DIR__ . '/../GameDashboardClient.php';
require_once __DIR__ . '/../gamedashboard.php';

const PORT = 8731;
$racine = __DIR__;

// Le panel de poche tourne le temps du banc, et s'arrête avec lui.
// Commande en tableau, sans shell : `proc_terminate` vise alors `php -S`
// lui-même. Passée en chaîne, elle tuait le shell intermédiaire et laissait
// le serveur de poche tourner après le banc.
$serveur = proc_open(
    [PHP_BINARY, '-S', '127.0.0.1:' . PORT, $racine . '/faux-panel.php'],
    [1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']],
    $tubes
);
register_shutdown_function(static function () use ($serveur, $racine) {
    if (is_resource($serveur)) {
        proc_terminate($serveur);
        proc_close($serveur);
    }
    @unlink($racine . '/.etat.json');
    @unlink($racine . '/.appels.json');
});

// On attend qu'il réponde plutôt que de dormir au jugé : sur une machine
// chargée, une attente fixe est soit trop courte, soit du temps perdu.
$pret = false;
for ($i = 0; $i < 100; $i++) {
    $sonde = @fsockopen('127.0.0.1', PORT, $err, $errstr, 0.2);
    if ($sonde) {
        fclose($sonde);
        $pret = true;
        break;
    }
    usleep(50_000);
}
if (!$pret) {
    fwrite(STDERR, "Le panel de poche n'a pas démarré.\n");
    exit(1);
}

/** Pilote le faux panel, et repart d'un journal d'appels vide. */
function scenario(array $etat = []): void
{
    file_put_contents(__DIR__ . '/.etat.json', json_encode($etat));
    file_put_contents(__DIR__ . '/.appels.json', json_encode([]));
    \WHMCS\Database\Capsule::$ecritures = [];
    $GLOBALS['journal'] = [];
}

/** Les appels reçus, réduits à ce qui se vérifie : le geste et sa cible. */
function gestes(): array
{
    $brut = json_decode((string) @file_get_contents(__DIR__ . '/.appels.json'), true) ?: [];
    return array_map(static function (array $a): string {
        $chemin = (string) $a['chemin'];
        if ($chemin === '/api/v1/application/users' && $a['methode'] === 'GET') {
            return isset($a['requete']['externalId'])
                ? 'chercheParExterne:' . $a['requete']['externalId']
                : 'chercheParEmail:' . ($a['requete']['email'] ?? '');
        }
        if ($chemin === '/api/v1/application/users' && $a['methode'] === 'POST') {
            return 'creeCompte:' . ($a['corps']['externalId'] ?? '') . ':' . ($a['idempotency'] ?? '');
        }
        if ($chemin === '/api/v1/application/servers' && $a['methode'] === 'POST') {
            return 'creeServeur:' . ($a['corps']['ownerId'] ?? '') . ':' . ($a['idempotency'] ?? '');
        }
        if (str_ends_with($chemin, '/owner')) {
            return 'transfere:' . basename(dirname($chemin)) . ':' . ($a['corps']['ownerId'] ?? '');
        }
        if (str_ends_with($chemin, '/suspension')) {
            return 'suspend:' . ($a['corps']['suspended'] ? 'oui' : 'non');
        }
        if ($a['methode'] === 'PATCH') {
            return 'rattache:' . ($a['corps']['externalId'] ?? '');
        }
        if ($a['methode'] === 'DELETE') {
            return 'supprime';
        }
        return $a['methode'] . ' ' . $chemin;
    }, $brut);
}

function params(array $surcharge = []): array
{
    return array_merge([
        'serverhostname' => '127.0.0.1:' . PORT,
        // En clair : le panel de poche ne porte pas de certificat, et le
        // client refuse — à raison — de désactiver la vérification TLS.
        'serversecure' => false,
        'serveraccesshash' => 'gd_app_test_secret',
        // `userid` à la racine : c'est `tblclients.id`, la source que la
        // documentation garantit. `clientsdetails` ne porte volontairement pas
        // cette clé ici, pour que le banc échoue si le module allait la
        // chercher là — ce qu'il faisait.
        'userid' => '4271',
        'clientsdetails' => [
            'email' => 'paul@exemple.fr',
            'firstname' => 'Paul',
            'lastname' => 'Martin',
        ],
        'serviceid' => '9001',
        'pid' => '12',
        'domain' => 'mon-serveur.exemple.fr',
        'configoption1' => 'egg-minecraft',
        'configoption2' => '',
        'configoption3' => '2048',
        'configoption4' => '10240',
        'configoption5' => '100',
        'configoption6' => '2',
        'configoption7' => '1',
        'configoption8' => '0',
        'customfields' => [],
    ], $surcharge);
}

$echecs = 0;
function verifie(string $titre, bool $condition, string $constate = ''): void
{
    global $echecs;
    if ($condition) {
        echo "  OK   {$titre}\n";
        return;
    }
    $echecs++;
    echo "  ECHEC {$titre}" . ($constate !== '' ? " — constaté : {$constate}" : '') . "\n";
}

echo "Logique du module WHMCS\n";

// 1. Client inconnu : compte puis serveur, et WHMCS reçoit 'success'.
scenario();
$retour = gamedashboard_CreateAccount(params());
verifie(
    'client inconnu : le compte est créé avant le serveur',
    gestes() === [
        'chercheParExterne:4271',
        'chercheParEmail:paul@exemple.fr',
        'creeCompte:4271:whmcs-client-4271',
        'creeServeur:compte-neuf:whmcs-service-9001',
    ],
    implode(' | ', gestes())
);
verifie('la création rend exactement « success »', $retour === 'success', var_export($retour, true));
verifie(
    'l\'identifiant du serveur est rangé dans le champ personnalisé',
    \WHMCS\Database\Capsule::$ecritures === ['serveur-42'],
    implode(' | ', \WHMCS\Database\Capsule::$ecritures)
);

// 2. Reprise de parc : rattachement, pas de doublon.
scenario(['userByEmail' => ['id' => 'compte-ancien', 'email' => 'paul@exemple.fr']]);
gamedashboard_CreateAccount(params());
verifie(
    'reprise de parc : le compte existant est rattaché, pas dupliqué',
    in_array('rattache:4271', gestes(), true)
        && !in_array('creeCompte:4271:whmcs-client-4271', gestes(), true),
    implode(' | ', gestes())
);

// 3. Client déjà connu : aucune création.
scenario(['userByExternalId' => ['id' => 'compte-connu']]);
gamedashboard_CreateAccount(params());
verifie(
    'client déjà connu : ni création ni rattachement',
    gestes() === ['chercheParExterne:4271', 'creeServeur:compte-connu:whmcs-service-9001'],
    implode(' | ', gestes())
);

// 4. Suspension sans serveur rattaché : message, jamais 'success'.
scenario();
$retour = gamedashboard_SuspendAccount(params());
verifie(
    'suspension sans serveur rattaché : refus explicite, jamais un faux succès',
    $retour !== 'success' && is_string($retour) && $retour !== '' && gestes() === [],
    var_export($retour, true)
);

// 5. Suspension normale.
scenario();
$retour = gamedashboard_SuspendAccount(params([
    'customfields' => [GAMEDASHBOARD_CHAMP_SERVEUR => 'serveur-42'],
]));
verifie(
    'suspension : le bon serveur, et « success »',
    $retour === 'success' && gestes() === ['suspend:oui'],
    $retour . ' | ' . implode(' | ', gestes())
);

// 6. Résiliation d'un serveur déjà absent : succès malgré le 404.
scenario();
$retour = gamedashboard_TerminateAccount(params([
    'customfields' => [GAMEDASHBOARD_CHAMP_SERVEUR => 'deja-parti'],
]));
verifie(
    'résiliation d\'un serveur déjà supprimé : « success », sinon le service reste facturable',
    $retour === 'success',
    var_export($retour, true)
);

// 7. Test de connexion : le type de retour compte autant que le verdict.
scenario();
$retour = gamedashboard_TestConnection(params());
verifie(
    'test de connexion réussi : tableau avec success vrai',
    is_array($retour) && ($retour['success'] ?? null) === true,
    json_encode($retour)
);

scenario(['scopes' => ['users.read']]);
$retour = gamedashboard_TestConnection(params());
verifie(
    'portées manquantes : refus qui les nomme',
    is_array($retour)
        && ($retour['success'] ?? null) === false
        && str_contains((string) ($retour['error'] ?? ''), 'users.sso'),
    json_encode($retour)
);

// 8. Clé refusée : le message doit désigner la clé, pas un code HTTP.
scenario();
$retour = gamedashboard_TestConnection(params(['serveraccesshash' => 'cle-invalide']));
verifie(
    'clé refusée : le message nomme la clé',
    is_array($retour)
        && ($retour['success'] ?? null) === false
        && str_contains((string) ($retour['error'] ?? ''), 'clé applicative'),
    json_encode($retour)
);

// 9. Le champ personnalisé absent ne doit pas faire échouer la création.
scenario();
\WHMCS\Database\Capsule::$champExiste = false;
$retour = gamedashboard_CreateAccount(params());
verifie(
    'champ personnalisé absent : la création réussit quand même, et le dit au journal',
    $retour === 'success' && ($GLOBALS['journal'] ?? []) !== [],
    var_export($retour, true) . ' | journal : ' . count($GLOBALS['journal'] ?? [])
);
\WHMCS\Database\Capsule::$champExiste = true;

// 10. L'ouverture de session rend le triplet que WHMCS attend.
scenario();
$retour = gamedashboard_ServiceSingleSignOn(params());
verifie(
    'SSO réussi : tableau avec success et redirectTo, sans redirection maison',
    is_array($retour)
        && ($retour['success'] ?? null) === true
        && str_starts_with((string) ($retour['redirectTo'] ?? ''), 'https://panel.test/sso/'),
    json_encode($retour)
);

scenario(['ssoUnknown' => true]);
$retour = gamedashboard_ServiceSingleSignOn(params());
verifie(
    'SSO refusé : success faux et errorMsg renseigné',
    is_array($retour)
        && ($retour['success'] ?? null) === false
        && ($retour['errorMsg'] ?? '') !== '',
    json_encode($retour)
);

// 11. Le nom du serveur ne doit jamais valoir « other ».
scenario();
$retour = gamedashboard_CreateAccount(params([
    'domain' => '',
    // WHMCS passe bien `producttype`, mais il vaut « other » et non le nom du
    // produit. S'en servir aurait nommé tous les serveurs « other #9001 ».
    'producttype' => 'other',
]));
$brut = json_decode((string) file_get_contents(__DIR__ . '/.appels.json'), true) ?: [];
$nom = '';
foreach ($brut as $appel) {
    if ($appel['chemin'] === '/api/v1/application/servers') {
        $nom = (string) ($appel['corps']['name'] ?? '');
    }
}
verifie(
    'sans domaine, le serveur est nommé par son numéro et jamais « other »',
    $nom === 'Serveur #9001',
    $nom
);

// 12. Le bouton de l'espace client pointe vers l'adresse convenue de WHMCS.
scenario();
$retour = gamedashboard_ClientArea(params());
verifie(
    'l\'espace client affiche un lien « dosinglesignon », pas un bouton maison',
    is_array($retour)
        && ($retour['templatefile'] ?? '') === 'clientarea'
        && str_contains((string) ($retour['vars']['ssoUrl'] ?? ''), 'dosinglesignon=1')
        && str_contains((string) ($retour['vars']['ssoUrl'] ?? ''), 'id=9001'),
    json_encode($retour)
);

// 13. Le service a changé de client dans WHMCS : le bouton d'administration
//     donne le serveur au client actuel, créé au besoin.
scenario();
$retour = gamedashboard_ReassignOwner(params([
    'customfields' => [GAMEDASHBOARD_CHAMP_SERVEUR => 'serveur-42'],
]));
verifie(
    'réattribution : compte du client actuel, puis transfert du serveur, et « success »',
    $retour === 'success'
        && gestes() === [
            'chercheParExterne:4271',
            'chercheParEmail:paul@exemple.fr',
            'creeCompte:4271:whmcs-client-4271',
            'transfere:serveur-42:compte-neuf',
        ],
    var_export($retour, true) . ' | ' . implode(' | ', gestes())
);
verifie(
    'le bouton est déclaré à WHMCS et vise la bonne fonction',
    in_array('ReassignOwner', gamedashboard_AdminCustomButtonArray(), true)
        && function_exists('gamedashboard_ReassignOwner'),
    json_encode(gamedashboard_AdminCustomButtonArray())
);

scenario();
$retour = gamedashboard_ReassignOwner(params());
verifie(
    'réattribution sans serveur rattaché : message, jamais « success », aucun appel',
    $retour !== 'success' && is_string($retour) && $retour !== '' && gestes() === [],
    var_export($retour, true)
);

scenario(['scopes' => ['users.read', 'users.write']]);
$retour = gamedashboard_ReassignOwner(params([
    'customfields' => [GAMEDASHBOARD_CHAMP_SERVEUR => 'serveur-42'],
]));
verifie(
    'clé sans servers.owner : le refus nomme la portée',
    is_string($retour) && str_contains($retour, 'servers.owner'),
    var_export($retour, true)
);
verifie(
    'portée manquante : présentée comme un refus de la clé',
    is_string($retour) && str_starts_with($retour, 'Le panel a refusé la clé applicative'),
    var_export($retour, true)
);

// 14. Un 403 qui tient au compte visé n'est pas un refus de la clé : la
//     présenter ainsi enverrait vérifier une clé qui fonctionne.
scenario(['destinataireSuspendu' => true]);
$retour = gamedashboard_ReassignOwner(params([
    'customfields' => [GAMEDASHBOARD_CHAMP_SERVEUR => 'serveur-42'],
]));
verifie(
    'client suspendu : le refus du panel, sans accuser la clé',
    is_string($retour)
        && str_starts_with($retour, 'Le panel a refusé : Ce compte est suspendu')
        && !str_contains($retour, 'clé applicative'),
    var_export($retour, true)
);

echo $echecs === 0 ? "\nTout passe.\n" : "\n{$echecs} échec(s).\n";
exit($echecs === 0 ? 0 : 1);

}
