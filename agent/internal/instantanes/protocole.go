package instantanes

import (
	"errors"
	"fmt"
	"time"
)

// Contrat entre l'agent et le panel pour les instantanés (ADR 0009, « Liaison
// avec le panel »). Le panel envoie des données, jamais des commandes ni des
// chemins ; tout est validé ici et une réponse invalide est rejetée en
// entier (les derniers réglages valides restent en vigueur).

const (
	CheminEtat    = "/api/node-agent/snapshots"
	CheminRapport = "/api/node-agent/snapshots/report"
	CheminDepot   = "/api/node-agent/snapshots/backups/" // + <sauvegarde>
)

// Bornes que le panel ne peut pas dépasser, même compromis : il ne peut pas
// faire remplir le disque à l'agent (ADR 0009, « Supprimer et faire
// tourner »).
const (
	NiveauxMax       = 8
	IntervalleMin    = 5 * time.Minute
	DureeMaxPlafond  = 90 * 24 * time.Hour
	DureeMaxPlancher = time.Hour
	SeuilLibreMin    = 5.0
	SeuilLibreMax    = 95.0
	RegroupementMax  = 10 * time.Minute
	OrdresMax        = 100
	ExclusionsMax    = 64 << 10
	GardesMax        = 5000
)

type Niveau struct {
	IntervalleS int64 `json:"intervalle_s"`
	RetentionS  int64 `json:"retention_s"`
}

func (n Niveau) Intervalle() time.Duration { return time.Duration(n.IntervalleS) * time.Second }
func (n Niveau) Retention() time.Duration  { return time.Duration(n.RetentionS) * time.Second }

type Reglages struct {
	Actif         bool     `json:"actif"`
	Niveaux       []Niveau `json:"niveaux"`
	DureeMaxS     int64    `json:"duree_max_s"`
	SeuilLibrePct float64  `json:"seuil_libre_pct"`
	RegroupementS int64    `json:"regroupement_s"`
}

func (r Reglages) DureeMax() time.Duration     { return time.Duration(r.DureeMaxS) * time.Second }
func (r Reglages) Regroupement() time.Duration { return time.Duration(r.RegroupementS) * time.Second }

// ReglagesSurs s'appliquent tant que le panel n'a jamais répondu : aucun
// instantané automatique, et les gardes au plus prudent.
func ReglagesSurs() Reglages {
	return Reglages{Actif: false, DureeMaxS: int64((30 * 24 * time.Hour).Seconds()), SeuilLibrePct: 15, RegroupementS: 60}
}

type TypeOrdre string

const (
	OrdrePrendre   TypeOrdre = "prendre"
	OrdreRestaurer TypeOrdre = "restaurer"
	OrdreDetruire  TypeOrdre = "detruire"
	OrdreArchiver  TypeOrdre = "archiver"
)

type Ordre struct {
	ID         string    `json:"id"`
	Type       TypeOrdre `json:"type"`
	Serveur    string    `json:"serveur,omitempty"`
	Instantane string    `json:"instantane,omitempty"`
	Sauvegarde string    `json:"sauvegarde,omitempty"`
	Exclusions string    `json:"exclusions,omitempty"`
}

// Etat est la réponse de GET /api/node-agent/snapshots.
type Etat struct {
	Reglages Reglages `json:"reglages"`
	// Instantanés que le panel veut garder hors rotation : épinglés, et
	// manuels ou de sûreté encore dans leur délai. Jamais au-delà de la durée
	// maximale.
	Gardes []string `json:"gardes"`
	Ordres []Ordre  `json:"ordres"`
}

func (r Reglages) Valider() error {
	var e []error
	if len(r.Niveaux) > NiveauxMax {
		e = append(e, fmt.Errorf("au plus %d niveaux automatiques", NiveauxMax))
	}
	if r.DureeMax() < DureeMaxPlancher || r.DureeMax() > DureeMaxPlafond {
		e = append(e, errors.New("durée maximale hors bornes (1 h à 90 jours)"))
	}
	for i, n := range r.Niveaux {
		if n.Intervalle() < IntervalleMin || n.Intervalle() > DureeMaxPlafond {
			e = append(e, fmt.Errorf("niveau %d : intervalle hors bornes", i+1))
		}
		if n.Retention() < n.Intervalle() || n.Retention() > r.DureeMax() {
			e = append(e, fmt.Errorf("niveau %d : rétention entre l'intervalle et la durée maximale", i+1))
		}
	}
	if r.SeuilLibrePct < SeuilLibreMin || r.SeuilLibrePct > SeuilLibreMax {
		e = append(e, errors.New("seuil d'espace libre hors bornes (5 à 95 %)"))
	}
	if r.Regroupement() < 0 || r.Regroupement() > RegroupementMax {
		e = append(e, errors.New("fenêtre de regroupement hors bornes (0 à 10 min)"))
	}
	return errors.Join(e...)
}

func (o Ordre) Valider() error {
	if !UUIDValide(o.ID) {
		return errors.New("identifiant d'ordre invalide")
	}
	switch o.Type {
	case OrdrePrendre:
		return nil
	case OrdreDetruire:
		if !NomValide(o.Instantane) {
			return errors.New("nom d'instantané invalide")
		}
	case OrdreRestaurer:
		if !UUIDValide(o.Serveur) {
			return errors.New("serveur invalide")
		}
		if !NomValide(o.Instantane) {
			return errors.New("nom d'instantané invalide")
		}
	case OrdreArchiver:
		if !UUIDValide(o.Serveur) || !UUIDValide(o.Sauvegarde) {
			return errors.New("serveur ou sauvegarde invalide")
		}
		if len(o.Exclusions) > ExclusionsMax {
			return errors.New("liste d'exclusions trop longue")
		}
	default:
		return fmt.Errorf("type d'ordre inconnu : %q", o.Type)
	}
	return nil
}

func (e Etat) Valider() error {
	if err := e.Reglages.Valider(); err != nil {
		return err
	}
	if len(e.Ordres) > OrdresMax || len(e.Gardes) > GardesMax {
		return errors.New("trop d'ordres ou de gardes")
	}
	vus := map[string]bool{}
	for _, o := range e.Ordres {
		if err := o.Valider(); err != nil {
			return fmt.Errorf("ordre %q : %w", o.ID, err)
		}
		if vus[o.ID] {
			return fmt.Errorf("ordre %q en double", o.ID)
		}
		vus[o.ID] = true
	}
	for _, g := range e.Gardes {
		if !NomValide(g) {
			return fmt.Errorf("garde invalide : %q", g)
		}
	}
	return nil
}

// Rapport -------------------------------------------------------------------

type InstantaneRapporte struct {
	Nom      string    `json:"nom"`
	PrisLe   time.Time `json:"pris_le"`
	Serveurs []string  `json:"serveurs"`
	// Nul quand le système ne sait pas le dire (btrfs sans quotas).
	Octets *int64 `json:"octets"`
}

type ResultatOrdre struct {
	ID   string `json:"id"`
	Etat string `json:"etat"` // "reussi" | "echoue"
	// Instantané pris ou réutilisé (prendre, archiver), ou de sûreté
	// (restaurer).
	Instantane string `json:"instantane,omitempty"`
	Erreur     string `json:"erreur,omitempty"`
	// archiver : faux tant qu'aucun octet n'est parti vers S3. Un échec sans
	// dépôt commencé laisse le panel retomber sur Wings.
	DepotCommence bool `json:"depot_commence,omitempty"`
}

type Rapport struct {
	Version string `json:"version"`
	// "btrfs", "zfs", ou vide avec un motif.
	Systeme     string               `json:"systeme"`
	Motif       string               `json:"motif,omitempty"`
	Espace      *Espace              `json:"espace,omitempty"`
	Suspendu    bool                 `json:"suspendu"` // sous le seuil d'espace libre
	Instantanes []InstantaneRapporte `json:"instantanes"`
	Ordres      []ResultatOrdre      `json:"ordres"`
}
