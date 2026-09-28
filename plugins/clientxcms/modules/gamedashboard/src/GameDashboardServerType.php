<?php

namespace App\Modules\GameDashboard;

use App\Abstracts\AbstractServerType;
use App\Contracts\Provisioning\ServerTypeInterface;
use App\DTO\Provisioning\ConnectionResponse;
use App\DTO\Provisioning\ServiceStateChangeDTO;
use App\Models\Account\Customer;
use App\Models\Provisioning\Server;
use App\Models\Provisioning\Service;
use App\Models\Store\Product;

require_once __DIR__ . '/GameDashboardClient.php';

/**
 * Module de provisionnement ClientXCMS pour GameDashboard.
 *
 * Même travail que les modules HostBill et WHMCS, dans le vocabulaire de
 * ClientXCMS : une classe qui étend `AbstractServerType` et dont chaque
 * méthode rend un `ServiceStateChangeDTO`.
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
 * `AbstractServerType` implémente déjà toute l'interface avec des défauts :
 * on ne surcharge donc que ce que ce module fait réellement. Les méthodes
 * absentes — changement de mot de passe, options, import — gardent le
 * comportement du cœur, ce qui est plus honnête que de les déclarer pour
 * renvoyer « non pris en charge ».
 */
class GameDashboardServerType extends AbstractServerType implements ServerTypeInterface
{
    protected string $uuid = 'gamedashboard';

    protected string $title = 'GameDashboard';

    /** Clé sous laquelle l'identifiant du serveur distant est rangé dans `Service::$data`. */
    private const CLE_SERVEUR = 'gamedashboard_server_id';

    /** Portées que le module emploie, et rien de plus. */
    private const PORTEES = [
        'users.read',
        'users.write',
        'users.sso',
        'servers.create',
        'servers.suspend',
        'servers.delete',
    ];

    /**
     * Une commande payée : le compte, puis le serveur.
     *
     * Les **clés d'idempotence** viennent des identifiants de service et de
     * client, qui ne changent jamais. ClientXCMS retente la livraison
     * (`delivery_attempts` existe sur le service) : sans elles, chaque reprise
     * créerait un serveur de plus, facturé une seule fois.
     */
    public function createAccount(Service $service): ServiceStateChangeDTO
    {
        try {
            $client = $this->client($service->server);
            $customer = $service->customer;

            if ($customer === null) {
                return new ServiceStateChangeDTO($service, false, 'Aucun client rattaché à ce service.');
            }

            $compte = $this->ensureUser($client, $customer);
            if (!isset($compte['id'])) {
                return new ServiceStateChangeDTO($service, false, 'Le panel n\'a pas rendu de compte exploitable.');
            }

            $charge = [
                'ownerId' => (string) $compte['id'],
                'eggId' => (string) $this->option($service, 'egg'),
                'name' => $this->serverName($service),
            ];

            $plan = trim((string) $this->option($service, 'plan'));
            if ($plan !== '') {
                $charge['planId'] = $plan;
            } else {
                $charge['resources'] = [
                    'memoryMb' => (int) $this->option($service, 'memory', 2048),
                    'diskMb' => (int) $this->option($service, 'disk', 10240),
                    'cpuPct' => (int) $this->option($service, 'cpu', 100),
                    'swapMb' => 0,
                    'allocations' => (int) $this->option($service, 'allocations', 0),
                    'backups' => (int) $this->option($service, 'backups', 2),
                    'databases' => (int) $this->option($service, 'databases', 1),
                ];
            }

            $reponse = $client->createServer($charge, 'clientxcms-service-' . $service->id);
            $idServeur = (string) ($reponse['data']['id'] ?? '');

            /*
             * L'identifiant du serveur est rangé dans `Service::$data`.
             *
             * Sans lui, suspendre et supprimer devraient retrouver le serveur
             * par son nom — que le client peut changer depuis le panel. On
             * suspendrait alors le mauvais, ou plus probablement aucun, en
             * silence.
             */
            $this->rangerIdentifiant($service, $idServeur);

            return new ServiceStateChangeDTO($service, true, 'Serveur créé sur GameDashboard.', [
                self::CLE_SERVEUR => $idServeur,
            ]);
        } catch (\GameDashboardError $e) {
            return new ServiceStateChangeDTO($service, false, $e->getMessage());
        }
    }

    /** Impayé : le serveur s'arrête, les fichiers restent. */
    public function suspendAccount(Service $service): ServiceStateChangeDTO
    {
        return $this->changerSuspension($service, true, 'Suspendu par la facturation (impayé).');
    }

    /** Paiement reçu : le serveur redevient utilisable. */
    public function unsuspendAccount(Service $service): ServiceStateChangeDTO
    {
        return $this->changerSuspension($service, false, '');
    }

    /**
     * Résiliation : le serveur et ses fichiers disparaissent.
     *
     * Un serveur déjà absent du panel n'est **pas** une erreur : il a pu être
     * supprimé à la main. Rendre un échec bloquerait l'expiration côté
     * ClientXCMS et laisserait un service facturable sans rien derrière.
     */
    public function expireAccount(Service $service): ServiceStateChangeDTO
    {
        $id = $this->identifiant($service);
        if ($id === '') {
            return new ServiceStateChangeDTO($service, true, 'Aucun serveur rattaché : rien à supprimer.');
        }

        try {
            $this->client($service->server)->deleteServer($id);
        } catch (\GameDashboardNotFound $e) {
            // Déjà parti. L'expiration continue.
        } catch (\GameDashboardError $e) {
            return new ServiceStateChangeDTO($service, false, $e->getMessage());
        }

        $this->rangerIdentifiant($service, '');

        return new ServiceStateChangeDTO($service, true, 'Serveur supprimé de GameDashboard.');
    }

    /**
     * Vérifie l'adresse, la clé **et** les portées, sans rien créer.
     *
     * `$params` arrive du formulaire de serveur, avant enregistrement : on y
     * lit directement l'hôte et la clé plutôt que de charger un serveur qui
     * n'existe peut-être pas encore.
     */
    public function testConnection(array $params): ConnectionResponse
    {
        $serveur = new Server;
        $serveur->fill($params);

        try {
            $identite = $this->client($serveur)->identity();
            $portees = $identite['data']['scopes'] ?? [];
            $manquantes = array_diff(self::PORTEES, is_array($portees) ? $portees : []);

            if ($manquantes !== []) {
                return $this->reponse(
                    403,
                    'La clé fonctionne mais il lui manque des portées : ' . implode(', ', $manquantes)
                        . '. Les portées d\'une clé ne se modifient pas : créez-en une nouvelle.'
                );
            }

            return $this->reponse(200, 'Connexion établie.');
        } catch (\GameDashboardError $e) {
            return $this->reponse(400, $e->getMessage());
        }
    }

    /**
     * Le service change de titulaire : le serveur suit.
     *
     * Le nouveau client doit exister dans le panel — on le crée au besoin,
     * comme à la commande — puis le serveur lui est donné. Sans ce second
     * geste, l'ancien titulaire garderait l'accès à un serveur qui ne lui
     * appartient plus, et le nouveau ne le verrait pas.
     *
     * Le panel efface ce que l'ancien titulaire avait installé autour du
     * serveur : sous-utilisateurs, rappels sortants, mots de passe des bases,
     * sessions SFTP et consoles ouvertes. Rejouer le changement ne fait rien de plus.
     */
    public function changeCustomer(Service $service, Customer $customer): ServiceStateChangeDTO
    {
        try {
            $client = $this->client($service->server);
            $compte = $this->ensureUser($client, $customer);
            if (!isset($compte['id'])) {
                return new ServiceStateChangeDTO($service, false, 'Le panel n\'a pas rendu de compte exploitable.');
            }

            $id = $this->identifiant($service);
            if ($id === '') {
                // Aucun serveur n'a encore été livré : il n'y a rien à
                // transférer, et le compte du nouveau client est prêt pour la
                // livraison. Un échec bloquerait le changement pour rien.
                return new ServiceStateChangeDTO(
                    $service,
                    true,
                    'Aucun serveur rattaché : le compte du nouveau client est prêt sur GameDashboard.'
                );
            }

            $reponse = $client->setServerOwner($id, (string) $compte['id']);

            // Le transfert a eu lieu : ce qui n'a pas pu être nettoyé se dit
            // dans le message, sans faire échouer le changement.
            $avertissement = \GameDashboardClient::ownerChangeWarning($reponse);

            return new ServiceStateChangeDTO(
                $service,
                true,
                $avertissement !== '' ? $avertissement : 'Serveur transféré au nouveau client sur GameDashboard.'
            );
        } catch (\GameDashboardNotFound $e) {
            return new ServiceStateChangeDTO(
                $service,
                false,
                'Le serveur ou le compte du nouveau client est introuvable sur GameDashboard : ' . $e->getMessage()
            );
        } catch (\GameDashboardError $e) {
            return new ServiceStateChangeDTO($service, false, $e->getMessage());
        }
    }

    /** Ce que ce type sait faire, pour que l'interface ne propose que cela. */
    public function getSupportedOptions(): array
    {
        return ['create', 'suspend', 'unsuspend', 'expire'];
    }

    /**
     * Un lien de connexion à usage unique pour le titulaire du service.
     *
     * Appelé par le contrôleur du module, derrière le bouton de l'espace
     * client. Le lien vaut deux minutes et ne sert qu'une fois : on redirige
     * dessus immédiatement, on ne l'affiche ni ne le met en cache.
     */
    public function ssoLink(Service $service): string
    {
        $customer = $service->customer;
        if ($customer === null) {
            throw new \GameDashboardError('Aucun client rattaché à ce service.');
        }

        return $this->client($service->server)->ssoLink((string) $customer->id);
    }

    /**
     * Retrouve ou crée le compte du client dans le panel.
     *
     * Trois cas, dans cet ordre :
     *
     * 1. le panel connaît déjà cet identifiant ClientXCMS — c'est lui ;
     * 2. il connaît l'adresse mais pas l'identifiant : **on rattache** plutôt
     *    que de créer un doublon. C'est le cas de toute reprise de parc ;
     * 3. il ne connaît rien : on crée.
     */
    private function ensureUser(\GameDashboardClient $client, Customer $customer): array
    {
        $externe = (string) $customer->id;

        $trouve = $client->findUserByExternalId($externe);
        if ($trouve !== null) {
            return $trouve;
        }

        $email = trim((string) $customer->email);
        if ($email === '') {
            throw new \GameDashboardError('Le client #' . $externe . ' n\'a pas d\'adresse e-mail.');
        }

        $parEmail = $client->findUserByEmail($email);
        if ($parEmail !== null) {
            $client->linkExternalId((string) $parEmail['id'], $externe);
            return $parEmail;
        }

        $cree = $client->createUser(
            $email,
            (string) $customer->firstname,
            (string) $customer->lastname,
            $externe,
            'clientxcms-client-' . $externe
        );

        return $cree['data'] ?? [];
    }

    private function changerSuspension(Service $service, bool $suspendu, string $raison): ServiceStateChangeDTO
    {
        $id = $this->identifiant($service);
        if ($id === '') {
            /*
             * Rien à suspendre : on le dit, plutôt que de rendre un succès.
             *
             * Un service marqué suspendu dans ClientXCMS alors que le serveur
             * tourne encore est la panne la plus coûteuse de cette
             * intégration : le client continue de jouer sans payer, et rien ne
             * le signale à personne.
             */
            return new ServiceStateChangeDTO($service, false, 'Aucun serveur GameDashboard n\'est rattaché à ce service.');
        }

        try {
            $this->client($service->server)->setSuspended($id, $suspendu, $raison);
            return new ServiceStateChangeDTO(
                $service,
                true,
                $suspendu ? 'Serveur suspendu.' : 'Serveur rétabli.'
            );
        } catch (\GameDashboardError $e) {
            return new ServiceStateChangeDTO($service, false, $e->getMessage());
        }
    }

    /**
     * Fabrique le client d'API à partir du serveur déclaré.
     *
     * `hostname` de préférence à `address` : un certificat TLS répond d'un
     * nom, pas d'une adresse. La clé applicative est rangée dans `password`,
     * que ClientXCMS chiffre en base — c'est ce qui la distingue d'un simple
     * champ de configuration.
     *
     * `protected` et non `private` : c'est le seul point par lequel ce module
     * touche le réseau, et le rendre remplaçable permet d'en éprouver la
     * logique sans installer ClientXCMS.
     */
    protected function client(?Server $server): \GameDashboardClient
    {
        if ($server === null) {
            throw new \GameDashboardError('Aucun serveur GameDashboard n\'est configuré pour ce produit.');
        }

        $hote = trim((string) ($server->hostname ?: $server->address));
        if ($hote === '') {
            throw new \GameDashboardError('Le serveur déclaré n\'a ni nom d\'hôte ni adresse.');
        }

        $base = preg_match('#^https?://#i', $hote) ? $hote : 'https://' . $hote;

        return new \GameDashboardClient($base, (string) $server->password);
    }

    /** Identifiant du serveur distant, rangé dans les données du service. */
    private function identifiant(Service $service): string
    {
        $data = $service->data;
        return is_array($data) ? trim((string) ($data[self::CLE_SERVEUR] ?? '')) : '';
    }

    private function rangerIdentifiant(Service $service, string $id): void
    {
        $data = is_array($service->data) ? $service->data : [];
        $data[self::CLE_SERVEUR] = $id;
        $service->data = $data;
        $service->save();
    }

    /**
     * Nom du serveur créé.
     *
     * Le nom du service quand il en porte un, sinon « Serveur #<numéro> ». Un
     * nom vide produirait une liste de serveurs indistincts dans le panel du
     * client dès qu'il en a deux.
     */
    private function serverName(Service $service): string
    {
        $nom = trim((string) $service->name);
        return $nom !== '' ? $nom : 'Serveur #' . $service->id;
    }

    /**
     * Une option du produit, par son nom.
     *
     * `protected` pour la même raison que `client()` : le banc y substitue les
     * valeurs sans avoir à monter un produit ClientXCMS complet.
     */
    protected function option(Service $service, string $nom, $defaut = '')
    {
        $data = $service->data;
        if (is_array($data) && isset($data[$nom]) && $data[$nom] !== '') {
            return $data[$nom];
        }

        $product = $service->product;
        $config = $product?->data;
        if (is_array($config) && isset($config[$nom]) && $config[$nom] !== '') {
            return $config[$nom];
        }

        return $defaut;
    }

    /** Fabrique la réponse que `testConnection` doit rendre. */
    private function reponse(int $statut, string $message): ConnectionResponse
    {
        return new ConnectionResponse(
            new \Illuminate\Http\Client\Response(
                new \GuzzleHttp\Psr7\Response($statut, [], json_encode(['message' => $message]))
            )
        );
    }
}
