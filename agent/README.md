# Agent de node

Logiciel **facultatif**, installé à côté de Wings sur un node de jeu. Il ne
modifie jamais Wings et ne touche jamais à Docker : il tire du panel ce qu'il
doit faire, le valide, l'exécute sur la machine et rend compte. Le panel ne
l'appelle jamais ; il n'écoute rien.

- Décisions : [ADR 0008](../docs/adr/0008-pare-feu-nftables.md) (agent,
  authentification et configuration calquées sur Wings, journal SQLite,
  fonctions facultatives) et [ADR 0009](../docs/adr/0009-instantanes-de-volumes.md)
  (instantanés).
- Fonction écrite : **instantanés** de volumes btrfs ou ZFS, restauration d'un
  serveur, sauvegardes S3 cohérentes tirées d'un instantané. Le pare-feu, le
  bilan de santé et la mise à jour de Wings s'ajouteront à côté, chacun avec sa
  sous-commande et son service systemd.

## Construire et tester

Go (dernière version stable, `go.mod`), module à part de l'espace pnpm :

```bash
cd agent
gofmt -l .          # doit être vide
go vet ./...
go test ./...
go build -ldflags "-X main.Version=1.0.0" -o gamedashboard-agent ./cmd/gamedashboard-agent
```

La CI le fait dans l'image Go épinglée (`IMAGE_GO`, `infra/ci/outils.env`).
Le banc sur un vrai btrfs demande root et un noyau avec btrfs :
`sudo GD_BTRFS_REEL=1 go test ./internal/instantanes -run Reel`.

## Sur la machine

```bash
install -m 0755 gamedashboard-agent /usr/local/bin/
gamedashboard-agent configure --panel-url https://panel.exemple.fr --token <clé> --node <uuid> --activer instantanes
gamedashboard-agent instantanes verifier     # diagnostic, ne change rien
install -m 0644 packaging/gamedashboard-agent-instantanes.service /etc/systemd/system/
systemctl enable --now gamedashboard-agent-instantanes
```

`system.data` de Wings doit être la racine d'un sous-volume btrfs ou le point
de montage d'un dataset ZFS, et `backup_directory` hors de lui ; sinon la
fonction reste grisée dans le panel, avec la raison.

## Contrat avec le panel

Toutes les routes sont sous `/api/node-agent/`, avec
`Authorization: Bearer <token_id>.<token>` comme Wings :

| Route | Rôle |
|---|---|
| `POST /api/node-agent/heartbeat` | version, fonction, fonctions actives, lot du journal ; réponse `{journal_accuse}` |
| `GET /api/node-agent/snapshots` | réglages du node, instantanés gardés, ordres (`prendre`, `restaurer`, `detruire`, `archiver`) |
| `POST /api/node-agent/snapshots/report` | système, espace, instantanés et serveurs contenus, résultat des ordres |
| `GET /api/node-agent/snapshots/backups/<id>?size=` | liens signés du dépôt S3 (même réponse que pour Wings) |
| `POST /api/node-agent/snapshots/backups/<id>` | compte rendu de la sauvegarde (même contenu que Wings) |
| `GET /api/application/nodes/<id>/agent-configuration` | `configure` (clé applicative, portée `nodes.configure`) |

Les types exacts sont dans `internal/instantanes/protocole.go`,
`internal/socle/socle.go` et `internal/config/configure.go`.
