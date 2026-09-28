<?php

/**
 * Un panel de poche, pour éprouver les plugins sans installation.
 *
 * Servi par `php -S`. Il répond comme l'API applicative de GameDashboard sur
 * les seules routes que les plugins emploient, et se pilote par un fichier
 * d'état que le banc réécrit entre deux cas.
 *
 * L'intérêt d'un vrai serveur HTTP plutôt qu'un client simulé : le module et
 * le client d'API sont éprouvés **tels qu'ils seront livrés**, en-têtes,
 * encodage JSON et codes de statut compris. Aucune fonction n'a besoin d'être
 * remplacée, donc le code sous banc est bien celui qui tournera chez le client.
 *
 * Il enregistre aussi chaque appel reçu : c'est ainsi que le banc vérifie
 * l'ordre des gestes et les clés d'idempotence.
 */

$etatFichier = __DIR__ . '/.etat.json';
$journalFichier = __DIR__ . '/.appels.json';

$etat = is_file($etatFichier)
    ? json_decode((string) file_get_contents($etatFichier), true)
    : [];
if (!is_array($etat)) {
    $etat = [];
}

$chemin = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?? '/';
$requete = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_QUERY) ?? '';
parse_str($requete, $parametres);
$methode = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$corps = json_decode((string) file_get_contents('php://input'), true);
if (!is_array($corps)) {
    $corps = [];
}

/** Trace de l'appel : chemin, et ce qui permet d'identifier le geste. */
$appels = is_file($journalFichier)
    ? json_decode((string) file_get_contents($journalFichier), true)
    : [];
if (!is_array($appels)) {
    $appels = [];
}
$appels[] = [
    'methode' => $methode,
    'chemin' => $chemin,
    'requete' => $parametres,
    'corps' => $corps,
    'idempotency' => $_SERVER['HTTP_IDEMPOTENCY_KEY'] ?? null,
];
file_put_contents($journalFichier, json_encode($appels));

header('Content-Type: application/json');

function repond(int $statut, array $charge): void
{
    http_response_code($statut);
    echo json_encode($charge, JSON_UNESCAPED_UNICODE);
    exit;
}

// La clé applicative doit être présentée, comme sur le vrai panel.
$autorisation = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
if (!str_starts_with($autorisation, 'Bearer gd_app_')) {
    repond(401, ['message' => 'Clé applicative refusée.']);
}

if ($chemin === '/api/v1/application/identity') {
    repond(200, ['data' => [
        'name' => 'Faux panel',
        'scopes' => $etat['scopes'] ?? [
            'users.read', 'users.write', 'users.sso',
            'servers.create', 'servers.suspend', 'servers.delete',
        ],
    ]]);
}

if ($chemin === '/api/v1/application/users' && $methode === 'GET') {
    $parExterne = $etat['userByExternalId'] ?? null;
    $parEmail = $etat['userByEmail'] ?? null;

    if (isset($parametres['externalId']) && $parExterne !== null) {
        repond(200, ['data' => $parExterne]);
    }
    if (isset($parametres['email']) && $parEmail !== null) {
        repond(200, ['data' => $parEmail]);
    }
    repond(404, ['message' => 'Compte introuvable.']);
}

if ($chemin === '/api/v1/application/users' && $methode === 'POST') {
    repond(201, ['data' => ['id' => 'compte-neuf', 'email' => $corps['email'] ?? '']]);
}

if (preg_match('#^/api/v1/application/users/([^/]+)$#', $chemin, $m) && $methode === 'PATCH') {
    repond(200, ['data' => ['id' => $m[1]]]);
}

if ($chemin === '/api/v1/application/users/sso-link') {
    if (($etat['ssoUnknown'] ?? false) === true) {
        repond(404, ['message' => 'Aucun compte ne correspond. Créez-le d\'abord par POST /api/v1/application/users.']);
    }
    repond(201, ['data' => [
        'url' => 'https://panel.test/sso/jeton-a-usage-unique',
        'expiresAt' => '2026-01-01T00:02:00.000Z',
    ]]);
}

if ($chemin === '/api/v1/application/servers' && $methode === 'POST') {
    repond(201, ['data' => ['id' => 'serveur-42', 'name' => $corps['name'] ?? '']]);
}

if (preg_match('#^/api/v1/application/servers/([^/]+)/suspension$#', $chemin)) {
    repond(200, ['data' => ['suspended' => $corps['suspended'] ?? null]]);
}

if (preg_match('#^/api/v1/application/servers/([^/]+)/owner$#', $chemin, $m) && $methode === 'POST') {
    if (!in_array('servers.owner', $etat['scopes'] ?? ['servers.owner'], true)) {
        repond(403, ['message' => 'Portée manquante : servers.owner.']);
    }
    if (($etat['destinataireSuspendu'] ?? false) === true) {
        repond(403, ['message' => 'Ce compte est suspendu dans le panel : aucun serveur ne lui est livré tant qu\'il n\'est pas réactivé.']);
    }
    if ($m[1] === 'deja-parti') {
        repond(404, ['message' => 'Serveur introuvable.']);
    }
    repond(201, ['data' => ['serverId' => $m[1], 'ownerId' => $corps['ownerId'] ?? null]]);
}

if (preg_match('#^/api/v1/application/servers/([^/]+)$#', $chemin, $m) && $methode === 'DELETE') {
    if ($m[1] === 'deja-parti') {
        repond(404, ['message' => 'Serveur introuvable.']);
    }
    repond(200, ['data' => ['deleted' => $m[1]]]);
}

repond(404, ['message' => 'Route inconnue du faux panel : ' . $chemin]);
