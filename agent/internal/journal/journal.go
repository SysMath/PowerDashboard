// Package journal tient le journal local de l'agent dans SQLite, comme Wings
// tient son activité dans /var/lib/pterodactyl/wings.db.
//
// Les entrées partent au panel à chaque relevé, par lots, et ne sont effacées
// qu'une fois accusées. Au-delà de 30 jours ou de 50 Mo, les plus anciennes
// tombent et un « trou » est signalé au panel au prochain envoi (ADR 0008).
// La même base garde les ordres déjà exécutés : un ordre rejoué par le panel
// n'est jamais refait (ADR 0009).
//
// SQLite en Go pur (modernc.org/sqlite) : le binaire reste statique, rien à
// installer sur la machine.
package journal

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
	"unicode/utf8"

	_ "modernc.org/sqlite"
)

const (
	DureeMax  = 30 * 24 * time.Hour
	TailleMax = 50 << 20
	// Longueurs gardées, en caractères, comme celles que le panel range
	// (`NODE_AGENT_DETAIL_MAX`, `NODE_AGENT_EVENT_MAX`) : tronquées ici, une
	// erreur bavarde ne gonfle ni la base ni le relevé.
	DetailMax    = 2000
	EvenementMax = 64
)

// tronquer coupe à `n` caractères, sans casser un caractère multioctet.
func tronquer(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}

type Niveau string

const (
	Info   Niveau = "info"
	Alerte Niveau = "alerte"
	Erreur Niveau = "erreur"
)

type Entree struct {
	ID         int64     `json:"id"`
	Horodatage time.Time `json:"horodatage"`
	Niveau     Niveau    `json:"niveau"`
	Fonction   string    `json:"fonction"`
	Evenement  string    `json:"evenement"`
	Serveur    string    `json:"serveur,omitempty"`
	Detail     string    `json:"detail,omitempty"`
}

type Journal struct {
	db *sql.DB
}

const schema = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS journal (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	horodatage TEXT NOT NULL,
	niveau TEXT NOT NULL,
	fonction TEXT NOT NULL,
	evenement TEXT NOT NULL,
	serveur TEXT NOT NULL DEFAULT '',
	detail TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS ordres (
	id TEXT PRIMARY KEY,
	fonction TEXT NOT NULL,
	etat TEXT NOT NULL,
	resultat TEXT NOT NULL DEFAULT '',
	recu TEXT NOT NULL,
	termine TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS etat (
	cle TEXT PRIMARY KEY,
	valeur TEXT NOT NULL
);
`

// Ouvrir crée au besoin la base (0600) et son schéma.
func Ouvrir(chemin string) (*Journal, error) {
	if err := os.MkdirAll(filepath.Dir(chemin), 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(chemin, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	f.Close()
	// busy_timeout : plusieurs services de l'agent (un par fonction) peuvent
	// partager la base.
	db, err := sql.Open("sqlite", "file:"+chemin+"?_pragma=busy_timeout(5000)&_pragma=auto_vacuum(incremental)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("journal : schéma : %w", err)
	}
	return &Journal{db: db}, nil
}

func (j *Journal) Fermer() error { return j.db.Close() }

func (j *Journal) Ecrire(ctx context.Context, e Entree) error {
	if e.Horodatage.IsZero() {
		e.Horodatage = time.Now()
	}
	e.Evenement = tronquer(e.Evenement, EvenementMax)
	e.Detail = tronquer(e.Detail, DetailMax)
	_, err := j.db.ExecContext(ctx,
		`INSERT INTO journal (horodatage, niveau, fonction, evenement, serveur, detail) VALUES (?, ?, ?, ?, ?, ?)`,
		e.Horodatage.UTC().Format(time.RFC3339Nano), e.Niveau, e.Fonction, e.Evenement, e.Serveur, e.Detail)
	return err
}

// AEnvoyer rend au plus `n` entrées non accusées, les plus anciennes d'abord.
func (j *Journal) AEnvoyer(ctx context.Context, n int) ([]Entree, error) {
	rows, err := j.db.QueryContext(ctx,
		`SELECT id, horodatage, niveau, fonction, evenement, serveur, detail FROM journal ORDER BY id LIMIT ?`, n)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Entree
	for rows.Next() {
		var e Entree
		var h string
		if err := rows.Scan(&e.ID, &h, &e.Niveau, &e.Fonction, &e.Evenement, &e.Serveur, &e.Detail); err != nil {
			return nil, err
		}
		e.Horodatage, _ = time.Parse(time.RFC3339Nano, h)
		out = append(out, e)
	}
	return out, rows.Err()
}

// Accuser efface les entrées reçues par le panel, jusqu'à `id` compris.
func (j *Journal) Accuser(ctx context.Context, id int64) error {
	_, err := j.db.ExecContext(ctx, `DELETE FROM journal WHERE id <= ?`, id)
	return err
}

// Purger fait tomber ce qui dépasse 30 jours, puis les plus anciennes
// entrées tant que la base dépasse 50 Mo. Rend vrai si quelque chose est
// tombé sans avoir été accusé : le prochain envoi le signale.
func (j *Journal) Purger(ctx context.Context, maintenant time.Time) (bool, error) {
	res, err := j.db.ExecContext(ctx, `DELETE FROM journal WHERE horodatage < ?`,
		maintenant.Add(-DureeMax).UTC().Format(time.RFC3339Nano))
	if err != nil {
		return false, err
	}
	tombees, _ := res.RowsAffected()
	for range 20 {
		taille, err := j.taille(ctx)
		if err != nil {
			return false, err
		}
		if taille <= TailleMax {
			break
		}
		res, err := j.db.ExecContext(ctx,
			`DELETE FROM journal WHERE id IN (SELECT id FROM journal ORDER BY id LIMIT (SELECT MAX(COUNT(*) / 10, 1) FROM journal))`)
		if err != nil {
			return false, err
		}
		n, _ := res.RowsAffected()
		tombees += n
		if _, err := j.db.ExecContext(ctx, `PRAGMA incremental_vacuum`); err != nil {
			return false, err
		}
		if n == 0 {
			break
		}
	}
	// Les ordres terminés ne servent qu'à l'idempotence d'un ordre rejoué :
	// au-delà de la durée maximale, aucun ordre ne l'est plus.
	if _, err := j.db.ExecContext(ctx, `DELETE FROM ordres WHERE termine != '' AND termine < ?`,
		maintenant.Add(-DureeMax).UTC().Format(time.RFC3339Nano)); err != nil {
		return false, err
	}
	if tombees > 0 {
		if err := j.poser(ctx, "trou", "1"); err != nil {
			return false, err
		}
	}
	return tombees > 0, nil
}

// Trou dit si des entrées sont tombées depuis le dernier envoi accusé.
func (j *Journal) Trou(ctx context.Context) (bool, error) {
	v, err := j.lire(ctx, "trou")
	return v == "1", err
}

func (j *Journal) TrouSignale(ctx context.Context) error { return j.poser(ctx, "trou", "0") }

func (j *Journal) taille(ctx context.Context) (int64, error) {
	var pages, libres, taillePage int64
	if err := j.db.QueryRowContext(ctx, `PRAGMA page_count`).Scan(&pages); err != nil {
		return 0, err
	}
	if err := j.db.QueryRowContext(ctx, `PRAGMA freelist_count`).Scan(&libres); err != nil {
		return 0, err
	}
	if err := j.db.QueryRowContext(ctx, `PRAGMA page_size`).Scan(&taillePage); err != nil {
		return 0, err
	}
	return (pages - libres) * taillePage, nil
}

// Poser et Valeur gardent un petit état entre deux démarrages (derniers
// réglages valides reçus du panel, trou dans le journal).
func (j *Journal) Poser(ctx context.Context, cle, valeur string) error {
	return j.poser(ctx, cle, valeur)
}

func (j *Journal) Valeur(ctx context.Context, cle string) (string, error) { return j.lire(ctx, cle) }

func (j *Journal) poser(ctx context.Context, cle, valeur string) error {
	_, err := j.db.ExecContext(ctx,
		`INSERT INTO etat (cle, valeur) VALUES (?, ?) ON CONFLICT(cle) DO UPDATE SET valeur = excluded.valeur`, cle, valeur)
	return err
}

func (j *Journal) lire(ctx context.Context, cle string) (string, error) {
	var v string
	err := j.db.QueryRowContext(ctx, `SELECT valeur FROM etat WHERE cle = ?`, cle).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return v, err
}

// Ordres ------------------------------------------------------------------

type EtatOrdre string

const (
	OrdreEnCours EtatOrdre = "en_cours"
	OrdreReussi  EtatOrdre = "reussi"
	OrdreEchoue  EtatOrdre = "echoue"
)

type Ordre struct {
	ID       string
	Fonction string
	Etat     EtatOrdre
	Resultat string
}

// Ordre rend l'ordre s'il est connu.
func (j *Journal) Ordre(ctx context.Context, id string) (Ordre, bool, error) {
	o := Ordre{ID: id}
	err := j.db.QueryRowContext(ctx, `SELECT fonction, etat, resultat FROM ordres WHERE id = ?`, id).
		Scan(&o.Fonction, &o.Etat, &o.Resultat)
	if errors.Is(err, sql.ErrNoRows) {
		return o, false, nil
	}
	return o, err == nil, err
}

// Commencer inscrit un ordre « en cours ». Rend faux s'il était déjà connu.
func (j *Journal) Commencer(ctx context.Context, id, fonction string, maintenant time.Time) (bool, error) {
	res, err := j.db.ExecContext(ctx,
		`INSERT INTO ordres (id, fonction, etat, recu) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
		id, fonction, OrdreEnCours, maintenant.UTC().Format(time.RFC3339Nano))
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n == 1, nil
}

// Terminer pose l'état final et le résultat (JSON rendu au panel).
func (j *Journal) Terminer(ctx context.Context, id string, etat EtatOrdre, resultat string, maintenant time.Time) error {
	_, err := j.db.ExecContext(ctx, `UPDATE ordres SET etat = ?, resultat = ?, termine = ? WHERE id = ?`,
		etat, resultat, maintenant.UTC().Format(time.RFC3339Nano), id)
	return err
}

// Rouvrir remet en attente un ordre resté « en cours » (l'agent s'est arrêté
// pendant son exécution) : il sera rejoué, ce que chaque ordre supporte.
func (j *Journal) Rouvrir(ctx context.Context, id string) error {
	_, err := j.db.ExecContext(ctx, `DELETE FROM ordres WHERE id = ? AND etat = ?`, id, OrdreEnCours)
	return err
}
