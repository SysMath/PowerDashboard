<?php

/**
 * Client de l'API applicative de GameDashboard.
 *
 * Volontairement séparé du module HostBill, et sans aucune dépendance à
 * HostBill : c'est la partie qu'on peut éprouver contre un vrai panel sans
 * installer quoi que ce soit, et celle qui servira telle quelle aux modules
 * WHMCS et ClientXCMS. Le module, lui, ne fait que traduire le vocabulaire de
 * son hôte vers ces méthodes.
 *
 * Ce qu'il faut savoir du contrat, côté panel :
 *
 * - une **clé applicative** (`gd_app_…`) porte des portées déclarées une par
 *   une ; rien n'est déduit d'autre chose. Le module n'en demande que ce
 *   qu'il emploie ;
 * - les créations acceptent une **clé d'idempotence** : rejouer la même
 *   requête après un délai réseau ne crée pas un second serveur ;
 * - le client est désigné par **son identifiant chez vous** (`externalId`),
 *   jamais par celui du panel. Vous connaissez vos clients ; retenir les
 *   identifiants du panel vous obligerait à tenir une correspondance qui se
 *   désynchronise au premier incident.
 */
class GameDashboardClient
{
    /** Au-delà, l'appel est abandonné. Une création de serveur reste rapide : le panel ne fait qu'enregistrer, c'est le daemon qui installe ensuite. */
    private const TIMEOUT = 20;

    private string $baseUrl;
    private string $apiKey;

    public function __construct(string $baseUrl, string $apiKey)
    {
        // La barre finale est retirée une fois pour toutes : la concaténation
        // produirait sinon des `//` que certains mandataires réécrivent, et le
        // symptôme serait une 404 incompréhensible.
        $this->baseUrl = rtrim(trim($baseUrl), '/');
        $this->apiKey = trim($apiKey);
    }

    /**
     * Vérifie que la clé passe, sans rien créer.
     *
     * C'est la première chose à appeler en mettant le module en service :
     * elle confirme l'adresse, la clé et les portées. Sans elle, la mise en
     * service se ferait en tentant une vraie commande, et un échec ne dirait
     * pas lequel des trois est en cause.
     */
    public function identity(): array
    {
        return $this->request('GET', '/api/v1/application/identity');
    }

    /**
     * Crée le compte du client dans le panel.
     *
     * `externalId` est l'identifiant HostBill du client. C'est par lui que tout
     * le reste le retrouvera — en particulier le lien de connexion.
     */
    public function createUser(
        string $email,
        string $firstName,
        string $lastName,
        string $externalId,
        ?string $idempotencyKey = null
    ): array {
        return $this->request('POST', '/api/v1/application/users', [
            'email' => $email,
            'nameFirst' => $firstName !== '' ? $firstName : 'Client',
            'nameLast' => $lastName !== '' ? $lastName : $externalId,
            'externalId' => $externalId,
        ], $idempotencyKey);
    }

    /** Le compte existe-t-il déjà ? Rend `null` plutôt que de lever sur 404. */
    public function findUserByExternalId(string $externalId): ?array
    {
        try {
            $response = $this->request(
                'GET',
                '/api/v1/application/users?externalId=' . rawurlencode($externalId)
            );
            return $response['data'] ?? null;
        } catch (GameDashboardNotFound $e) {
            return null;
        }
    }

    /** Idem par adresse : sert à rattacher un compte créé avant l'installation du module. */
    public function findUserByEmail(string $email): ?array
    {
        try {
            $response = $this->request(
                'GET',
                '/api/v1/application/users?email=' . rawurlencode($email)
            );
            return $response['data'] ?? null;
        } catch (GameDashboardNotFound $e) {
            return null;
        }
    }

    /**
     * Rattache un compte existant à son identifiant chez vous.
     *
     * Le cas se produit à chaque reprise d'un parc : les clients ont déjà un
     * compte sur le panel, créé à la main, et le module doit pouvoir les
     * adopter sans en fabriquer un second sur la même adresse.
     */
    public function linkExternalId(string $userId, string $externalId): array
    {
        return $this->request('PATCH', '/api/v1/application/users/' . rawurlencode($userId), [
            'externalId' => $externalId,
        ]);
    }

    public function createServer(array $payload, ?string $idempotencyKey = null): array
    {
        return $this->request('POST', '/api/v1/application/servers', $payload, $idempotencyKey);
    }

    /** Suspend ou rétablit. Un impayé suspend, un paiement rétablit. */
    public function setSuspended(string $serverId, bool $suspended, string $reason = ''): array
    {
        return $this->request(
            'POST',
            '/api/v1/application/servers/' . rawurlencode($serverId) . '/suspension',
            ['suspended' => $suspended, 'reason' => $reason]
        );
    }

    /**
     * Donne le serveur à un autre compte du panel : le service a changé de
     * client chez vous.
     *
     * `$ownerId` est l'identifiant **du panel**, celui que rendent
     * `createUser` et les recherches. Le panel efface au passage ce que
     * l'ancien titulaire avait installé autour : sous-utilisateurs, rappels
     * sortants, mots de passe des bases, sessions SFTP et consoles ouvertes.
     * Demande la portée `servers.owner`, qu'une clé plus ancienne n'a pas :
     * le refus la nomme. Ce qui n'a pas pu être nettoyé se lit dans la
     * réponse avec `ownerChangeWarning`.
     */
    public function setServerOwner(string $serverId, string $ownerId): array
    {
        return $this->request(
            'POST',
            '/api/v1/application/servers/' . rawurlencode($serverId) . '/owner',
            ['ownerId' => $ownerId]
        );
    }

    /**
     * Ce que le changement de titulaire n'a pas pu nettoyer, en une phrase à
     * montrer à l'administrateur de la boutique ; vide quand tout est fait.
     *
     * Le transfert a eu lieu dans tous les cas : une base dont l'hôte a
     * refusé le nouveau mot de passe garde l'ancien, que l'ancien client
     * connaît, et un node injoignable a pu lui laisser une session SFTP.
     */
    public static function ownerChangeWarning(array $response): string
    {
        $bilan = $response['data']['cleanup'] ?? [];
        $parties = [];

        $bases = $bilan['databasesNotRotated'] ?? [];
        if (is_array($bases) && count($bases) > 0) {
            $parties[] = 'le mot de passe de ces bases n\'a pas pu être renouvelé : '
                . implode(', ', array_map('strval', $bases));
        }
        $sessions = (int) ($bilan['sessionsNotClosed'] ?? 0);
        if ($sessions > 0) {
            $parties[] = 'le node n\'a pas pu fermer les sessions de ' . $sessions . ' compte(s)';
        }

        return $parties === [] ? '' : 'Serveur transféré, mais ' . implode(' ; ', $parties) . '.';
    }

    public function deleteServer(string $serverId): array
    {
        return $this->request('DELETE', '/api/v1/application/servers/' . rawurlencode($serverId));
    }

    /**
     * Un lien de connexion à usage unique pour ce client.
     *
     * Le panel refuse d'en émettre un pour un client qu'il ne connaît pas :
     * le compte doit avoir été créé au moment de la commande. Il refuse
     * également pour un compte du personnel du panel — une clé applicative ne
     * doit pas pouvoir ouvrir une session d'administrateur.
     *
     * Le lien vaut deux minutes et ne sert qu'une fois : on redirige dessus
     * immédiatement, on ne le stocke pas et on ne l'affiche pas.
     */
    public function ssoLink(string $externalId): string
    {
        $response = $this->request('POST', '/api/v1/application/users/sso-link', [
            'externalId' => $externalId,
        ]);

        $url = $response['data']['url'] ?? '';
        if (!is_string($url) || $url === '') {
            throw new GameDashboardError('Le panel n\'a pas rendu de lien de connexion.');
        }
        return $url;
    }

    /**
     * Un appel, et la traduction de ce qui peut mal se passer.
     *
     * Trois familles d'échec, et elles appellent trois gestes différents :
     * le panel injoignable (vérifier l'adresse et le pare-feu), la clé
     * refusée (vérifier la clé et ses portées), et le refus métier — quota
     * dépassé, nom déjà pris — dont le panel écrit la raison en clair. Les
     * confondre en « erreur API » obligerait à ouvrir les journaux du panel
     * pour savoir lequel des trois.
     */
    private function request(
        string $method,
        string $path,
        ?array $body = null,
        ?string $idempotencyKey = null
    ): array {
        $headers = [
            'Authorization: Bearer ' . $this->apiKey,
            'Accept: application/json',
        ];
        if ($body !== null) {
            $headers[] = 'Content-Type: application/json';
        }
        if ($idempotencyKey !== null && $idempotencyKey !== '') {
            $headers[] = 'Idempotency-Key: ' . $idempotencyKey;
        }

        $ch = curl_init($this->baseUrl . $path);
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_TIMEOUT => self::TIMEOUT,
            CURLOPT_CONNECTTIMEOUT => 10,
            // La vérification TLS n'est **jamais** désactivée. Le jeton
            // applicative voyage dans l'en-tête : sans certificat vérifié,
            // n'importe quel intermédiaire le recueille et obtient le droit de
            // créer, suspendre et supprimer des serveurs.
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
        ]);
        if ($body !== null) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body, JSON_UNESCAPED_UNICODE));
        }

        $raw = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $transport = curl_error($ch);
        curl_close($ch);

        if ($raw === false) {
            throw new GameDashboardError(
                'Le panel est injoignable (' . $transport . '). Vérifiez l\'adresse et que HostBill peut sortir vers lui.'
            );
        }

        $decoded = json_decode((string) $raw, true);
        if (!is_array($decoded)) {
            $decoded = [];
        }

        if ($status === 401 || ($status === 403 && self::refusDeLaCle($decoded))) {
            throw new GameDashboardError(
                'Le panel a refusé la clé applicative : ' . self::message($decoded, 'vérifiez la clé et ses portées.')
            );
        }
        if ($status === 403) {
            // Un refus qui tient au compte ou au serveur visé (compte
            // suspendu, personnel…), pas à la clé : le présenter comme un
            // refus de la clé enverrait vérifier une clé qui fonctionne.
            throw new GameDashboardError('Le panel a refusé : ' . self::message($decoded, 'action refusée.'));
        }
        if ($status === 404) {
            throw new GameDashboardNotFound(self::message($decoded, 'Ressource introuvable sur le panel.'));
        }
        if ($status >= 400) {
            throw new GameDashboardError(self::message($decoded, 'Le panel a répondu ' . $status . '.'));
        }

        return $decoded;
    }

    /**
     * Le 403 vient-il de la clé elle-même ? Portée manquante, clé bornée à un
     * revendeur pour une route de la plateforme, ou clé d'un autre node : ce
     * sont les refus du garde de l'API applicative, et eux seuls se corrigent
     * dans la configuration de la clé.
     */
    private static function refusDeLaCle(array $decoded): bool
    {
        $message = self::message($decoded, '');
        return $message === ''
            || str_starts_with($message, 'Portée manquante')
            || str_starts_with($message, 'Cette clé')
            || str_starts_with($message, 'Cette route ne déclare aucune portée');
    }

    private static function message(array $decoded, string $fallback): string
    {
        $message = $decoded['message'] ?? null;
        return is_string($message) && $message !== '' ? $message : $fallback;
    }
}

class GameDashboardError extends Exception
{
}

/** Distincte : « ce client n'existe pas encore » se traite, « la clé est refusée » non. */
class GameDashboardNotFound extends GameDashboardError
{
}
