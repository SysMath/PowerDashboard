<?php

/*
 * Éprouve la logique du module ClientXCMS, sans ClientXCMS.
 *
 * ClientXCMS est un Laravel complet, sous licence qui réserve l'usage
 * commercial de son code source. On ne l'installe donc pas pour un essai, et
 * on ne recopie rien : ce banc **redéclare** le strict minimum de ses classes
 * — celles que le module nomme dans ses signatures — à partir de leurs
 * signatures publiques, puis exécute le module tel qu'il sera livré.
 *
 * Ce qu'il vérifie en propre au module : l'ordre des gestes, les refus, et le
 * fait que chaque méthode rende un `ServiceStateChangeDTO` dont le drapeau
 * `success` dit la vérité. Un module qui rend « succès » sur une suspension
 * qui n'a rien suspendu est la panne la plus coûteuse de l'intégration.
 *
 * Lancement : `php tests/module-logic.php` depuis le dossier du module.
 */

namespace App\Models\Provisioning {
    class Server
    {
        public ?string $hostname = 'panel.test';
        public ?string $address = null;
        public ?string $password = 'gd_app_test_secret';

        public function fill(array $attributs): self
        {
            foreach ($attributs as $cle => $valeur) {
                $this->{$cle} = $valeur;
            }
            return $this;
        }
    }

    class Service
    {
        public int $id = 9001;
        public string $name = 'mon-serveur';
        public int $customer_id = 4271;
        public ?array $data = [];
        public $customer = null;
        public $server = null;
        public $product = null;
        public bool $enregistre = false;

        public function save(): bool
        {
            $this->enregistre = true;
            return true;
        }
    }
}

namespace App\Models\Account {
    class Customer
    {
        public int $id = 4271;
        public string $email = 'paul@exemple.fr';
        public string $firstname = 'Paul';
        public string $lastname = 'Martin';
    }
}

namespace App\Models\Store {
    class Product
    {
        public ?array $data = [];
    }
}

namespace App\Models\Billing {
    class ConfigOption
    {
    }
}

namespace App\DTO\Provisioning {
    class ServiceStateChangeDTO
    {
        public function __construct(
            public $service,
            public bool $success,
            public string $message,
            public array $data = []
        ) {
        }
    }

    class ConnectionResponse
    {
        public function __construct(public $response)
        {
        }

        public function successful(): bool
        {
            return $this->response->statut >= 200 && $this->response->statut < 300;
        }

        public function status(): int
        {
            return $this->response->statut;
        }

        public function toString(): string
        {
            return $this->response->corps;
        }
    }
}

namespace Illuminate\Http\Client {
    class Response
    {
        public int $statut;
        public string $corps;

        public function __construct($psr)
        {
            $this->statut = $psr->statut;
            $this->corps = $psr->corps;
        }
    }
}

namespace GuzzleHttp\Psr7 {
    class Response
    {
        public function __construct(public int $statut, public array $entetes, public string $corps)
        {
        }
    }
}

namespace App\Contracts\Provisioning {
    interface ServerTypeInterface
    {
    }

    interface ImportServiceInterface
    {
    }
}

namespace App\Abstracts {
    abstract class AbstractServerType
    {
        protected string $uuid;
        protected string $title;

        public function uuid(): string
        {
            return $this->uuid;
        }

        public function title(): string
        {
            return $this->title;
        }
    }
}

namespace {

require_once __DIR__ . '/../src/GameDashboardClient.php';
require_once __DIR__ . '/../src/GameDashboardServerType.php';

use App\Models\Account\Customer;
use App\Models\Provisioning\Server;
use App\Models\Provisioning\Service;
use App\Modules\GameDashboard\GameDashboardServerType;

/** Client simulé : enregistre les appels, rend ce que le scénario dicte. */
class ClientSimule extends GameDashboardClient
{
    public array $appels = [];
    public ?array $parExterne = null;
    public ?array $parEmail = null;
    public array $bilan = [];
    public array $portees = [
        'users.read', 'users.write', 'users.sso',
        'servers.create', 'servers.suspend', 'servers.delete', 'servers.owner',
    ];

    public function __construct()
    {
        parent::__construct('https://panel.test', 'gd_app_test_secret');
    }

    public function identity(): array
    {
        return ['data' => ['scopes' => $this->portees]];
    }

    public function findUserByExternalId(string $externalId): ?array
    {
        $this->appels[] = "chercheParExterne:{$externalId}";
        return $this->parExterne;
    }

    public function findUserByEmail(string $email): ?array
    {
        $this->appels[] = "chercheParEmail:{$email}";
        return $this->parEmail;
    }

    public function linkExternalId(string $userId, string $externalId): array
    {
        $this->appels[] = "rattache:{$userId}:{$externalId}";
        return ['data' => ['id' => $userId]];
    }

    public function createUser(
        string $email,
        string $firstName,
        string $lastName,
        string $externalId,
        ?string $idempotencyKey = null
    ): array {
        $this->appels[] = "creeCompte:{$externalId}:{$idempotencyKey}";
        return ['data' => ['id' => 'compte-neuf']];
    }

    public function createServer(array $payload, ?string $idempotencyKey = null): array
    {
        $this->appels[] = "creeServeur:{$payload['ownerId']}:{$idempotencyKey}:{$payload['name']}";
        return ['data' => ['id' => 'serveur-42']];
    }

    public function setSuspended(string $serverId, bool $suspended, string $reason = ''): array
    {
        $this->appels[] = 'suspend:' . $serverId . ':' . ($suspended ? 'oui' : 'non');
        return [];
    }

    public function setServerOwner(string $serverId, string $ownerId): array
    {
        $this->appels[] = "transfere:{$serverId}:{$ownerId}";
        if ($serverId === 'deja-parti') {
            throw new GameDashboardNotFound('Serveur introuvable.');
        }
        if (!in_array('servers.owner', $this->portees, true)) {
            throw new GameDashboardError('Le panel a refusé la clé applicative : Portée manquante : servers.owner.');
        }
        return ['data' => ['serverId' => $serverId, 'ownerId' => $ownerId, 'cleanup' => $this->bilan]];
    }

    public function deleteServer(string $serverId): array
    {
        $this->appels[] = "supprime:{$serverId}";
        if ($serverId === 'deja-parti') {
            throw new GameDashboardNotFound('Serveur introuvable.');
        }
        return [];
    }

    public function ssoLink(string $externalId): string
    {
        $this->appels[] = "ssoLink:{$externalId}";
        return 'https://panel.test/sso/jeton-a-usage-unique';
    }
}

/** Le module, avec le seul point réseau remplacé. */
class TypeSousBanc extends GameDashboardServerType
{
    public ClientSimule $simule;
    public array $options = ['egg' => 'egg-minecraft'];

    protected function client(?Server $server): GameDashboardClient
    {
        return $this->simule;
    }

    protected function option(Service $service, string $nom, $defaut = '')
    {
        return $this->options[$nom] ?? $defaut;
    }
}

function service(ClientSimule $s, array $data = []): array
{
    $type = new TypeSousBanc;
    $type->simule = $s;

    $service = new Service;
    $service->customer = new Customer;
    $service->server = new Server;
    $service->data = $data;

    return [$type, $service];
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

echo "Logique du module ClientXCMS\n";

// 1. Client inconnu : compte puis serveur, dans cet ordre.
$s = new ClientSimule();
[$type, $service] = service($s);
$dto = $type->createAccount($service);
verifie(
    'client inconnu : le compte est créé avant le serveur',
    $s->appels === [
        'chercheParExterne:4271',
        'chercheParEmail:paul@exemple.fr',
        'creeCompte:4271:clientxcms-client-4271',
        'creeServeur:compte-neuf:clientxcms-service-9001:mon-serveur',
    ],
    implode(' | ', $s->appels)
);
verifie('la création rend un DTO en succès', $dto->success === true, $dto->message);
verifie(
    'l\'identifiant du serveur est rangé et le service enregistré',
    ($service->data['gamedashboard_server_id'] ?? '') === 'serveur-42' && $service->enregistre,
    json_encode($service->data)
);

// 2. Reprise de parc : rattachement, pas de doublon.
$s = new ClientSimule();
$s->parEmail = ['id' => 'compte-ancien'];
[$type, $service] = service($s);
$type->createAccount($service);
verifie(
    'reprise de parc : le compte existant est rattaché, pas dupliqué',
    in_array('rattache:compte-ancien:4271', $s->appels, true)
        && !in_array('creeCompte:4271:clientxcms-client-4271', $s->appels, true),
    implode(' | ', $s->appels)
);

// 3. Client déjà connu : aucune création.
$s = new ClientSimule();
$s->parExterne = ['id' => 'compte-connu'];
[$type, $service] = service($s);
$type->createAccount($service);
verifie(
    'client déjà connu : ni création ni rattachement',
    $s->appels === [
        'chercheParExterne:4271',
        'creeServeur:compte-connu:clientxcms-service-9001:mon-serveur',
    ],
    implode(' | ', $s->appels)
);

// 4. Suspension sans serveur rattaché : échec, jamais un faux succès.
$s = new ClientSimule();
[$type, $service] = service($s);
$dto = $type->suspendAccount($service);
verifie(
    'suspension sans serveur rattaché : refus explicite, jamais un faux succès',
    $dto->success === false && $s->appels === [],
    $dto->message
);

// 5. Suspension normale.
$s = new ClientSimule();
[$type, $service] = service($s, ['gamedashboard_server_id' => 'serveur-42']);
$dto = $type->suspendAccount($service);
verifie(
    'suspension : le bon serveur, et un succès',
    $dto->success === true && $s->appels === ['suspend:serveur-42:oui'],
    $dto->message . ' | ' . implode(' | ', $s->appels)
);

// 6. Expiration d'un serveur déjà absent : succès malgré le 404.
$s = new ClientSimule();
[$type, $service] = service($s, ['gamedashboard_server_id' => 'deja-parti']);
$dto = $type->expireAccount($service);
verifie(
    'expiration d\'un serveur déjà supprimé : succès, sinon le service reste facturable',
    $dto->success === true,
    $dto->message
);

// 7. Test de connexion : verdict et portées.
$s = new ClientSimule();
[$type] = service($s);
$reponse = $type->testConnection(['hostname' => 'panel.test', 'password' => 'gd_app_test_secret']);
verifie('test de connexion réussi', $reponse->successful(), (string) $reponse->status());

$s = new ClientSimule();
$s->portees = ['users.read'];
[$type] = service($s);
$reponse = $type->testConnection(['hostname' => 'panel.test', 'password' => 'gd_app_test_secret']);
verifie(
    'portées manquantes : refus qui les nomme',
    !$reponse->successful() && str_contains($reponse->toString(), 'users.sso'),
    $reponse->toString()
);

// 8. Le lien de connexion est demandé pour le titulaire, pas pour le demandeur.
$s = new ClientSimule();
[$type, $service] = service($s);
$url = $type->ssoLink($service);
verifie(
    'le lien est émis pour le client titulaire du service',
    $s->appels === ['ssoLink:4271'] && str_starts_with($url, 'https://panel.test/sso/'),
    implode(' | ', $s->appels)
);

// 9. Changement de titulaire : le compte du nouveau client, puis le serveur
//    lui est donné — et non plus un échec qui renvoyait au geste manuel.
$s = new ClientSimule();
[$type, $service] = service($s, ['gamedashboard_server_id' => 'serveur-42']);
$dto = $type->changeCustomer($service, new Customer);
verifie(
    'changement de titulaire : compte du nouveau client, puis transfert du serveur',
    $dto->success === true
        && $s->appels === [
            'chercheParExterne:4271',
            'chercheParEmail:paul@exemple.fr',
            'creeCompte:4271:clientxcms-client-4271',
            'transfere:serveur-42:compte-neuf',
        ],
    $dto->message . ' | ' . implode(' | ', $s->appels)
);

$s = new ClientSimule();
$s->parExterne = ['id' => 'compte-connu'];
[$type, $service] = service($s, ['gamedashboard_server_id' => 'serveur-42']);
$dto = $type->changeCustomer($service, new Customer);
verifie(
    'changement vers un client déjà connu : transfert direct, sans création',
    $dto->success === true
        && $s->appels === ['chercheParExterne:4271', 'transfere:serveur-42:compte-connu'],
    implode(' | ', $s->appels)
);

$s = new ClientSimule();
[$type, $service] = service($s);
$dto = $type->changeCustomer($service, new Customer);
verifie(
    'changement sans serveur livré : le compte est prêt, rien à transférer',
    $dto->success === true && !in_array('transfere', array_map(
        static fn (string $a): string => explode(':', $a)[0],
        $s->appels
    ), true),
    $dto->message . ' | ' . implode(' | ', $s->appels)
);

$s = new ClientSimule();
$s->portees = array_values(array_diff($s->portees, ['servers.owner']));
[$type, $service] = service($s, ['gamedashboard_server_id' => 'serveur-42']);
$dto = $type->changeCustomer($service, new Customer);
verifie(
    'clé sans servers.owner : échec qui nomme la portée, jamais un faux succès',
    $dto->success === false && str_contains($dto->message, 'servers.owner'),
    $dto->message
);

$s = new ClientSimule();
[$type, $service] = service($s, ['gamedashboard_server_id' => 'deja-parti']);
$dto = $type->changeCustomer($service, new Customer);
verifie(
    'serveur absent du panel : échec explicite',
    $dto->success === false && str_contains($dto->message, 'introuvable'),
    $dto->message
);

$s = new ClientSimule();
$s->parExterne = ['id' => 'compte-connu'];
$s->bilan = ['databasesNotRotated' => ['s1_boutique'], 'sessionsNotClosed' => 1];
[$type, $service] = service($s, ['gamedashboard_server_id' => 'serveur-42']);
$dto = $type->changeCustomer($service, new Customer);
verifie(
    'base restée sur son ancien mot de passe : succès, mais le message la nomme',
    $dto->success === true
        && str_contains($dto->message, 's1_boutique')
        && str_contains($dto->message, '1 compte(s)'),
    $dto->message
);

echo $echecs === 0 ? "\nTout passe.\n" : "\n{$echecs} échec(s).\n";
exit($echecs === 0 ? 0 : 1);

}
