// Package socle porte ce que toutes les fonctions de l'agent partagent :
// la boucle de relevé, l'annonce des fonctions actives et l'envoi du journal
// au panel (ADR 0008, « L'agent calqué sur Wings, et facultatif »).
//
// Chaque fonction tourne dans son propre service systemd, avec ses propres
// privilèges (ADR 0009, « Privilèges de l'agent ») ; toutes lisent le même
// config.yml et écrivent dans la même base.
package socle

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"github.com/SysMath/PowerDashboard/agent/internal/journal"
	"github.com/SysMath/PowerDashboard/agent/internal/panel"
)

const CheminAnnonce = "/api/node-agent/heartbeat"

// Nombre d'entrées de journal envoyées par relevé. Avec les longueurs bornées
// par le journal (2 000 caractères de détail), un lot reste sous le mégaoctet
// que le panel accepte pour un corps JSON : un lot refusé serait renvoyé à
// chaque relevé et bloquerait toutes les entrées suivantes.
const LotJournal = 200

// OctetsMaxLot borne le lot en octets, quel que soit le texte des entrées :
// l'échappement JSON peut sextupler un caractère (`<` devient `\u003c`).
const OctetsMaxLot = 512 << 10

// borner garde les premières entrées tant que le lot tient dans OctetsMaxLot,
// et toujours au moins une : une entrée n'excède jamais quelques dizaines de
// kilo-octets (voir journal.DetailMax).
func borner(entrees []journal.Entree) []journal.Entree {
	total := 0
	for i, e := range entrees {
		b, err := json.Marshal(e)
		if err != nil {
			return entrees[:i]
		}
		total += len(b) + 1
		if total > OctetsMaxLot && i > 0 {
			return entrees[:i]
		}
	}
	return entrees
}

// Annonce est le signe de vie de l'agent : sa version, la fonction de ce
// processus, les fonctions actives dans config.yml (le panel n'offre que
// celles-là, `nodeCapabilities()`), et un lot du journal.
type Annonce struct {
	Version   string           `json:"version"`
	Fonction  string           `json:"fonction"`
	Fonctions []string         `json:"fonctions"`
	Journal   []journal.Entree `json:"journal"`
	// Des entrées sont tombées sans avoir été reçues (30 jours ou 50 Mo).
	Trou bool `json:"trou"`
}

type Accuse struct {
	// Dernier identifiant d'entrée enregistré par le panel.
	JournalAccuse int64 `json:"journal_accuse"`
}

type Releveur interface {
	Releve(ctx context.Context) error
}

type Boucle struct {
	Version    string
	Fonction   string
	Fonctions  []string
	Intervalle time.Duration
	Panel      *panel.Client
	Journal    *journal.Journal
	Module     Releveur
	Log        *slog.Logger
}

// Tourner relève et annonce tout de suite, puis à chaque intervalle, jusqu'à
// l'arrêt. **Deux boucles** : un relevé peut durer (une archive S3, une
// restauration par vraie copie sur ZFS), et l'annonce est le signe de vie de
// la fonction. Dans la même boucle, le panel tenait la fonction pour muette
// au bout de deux minutes de travail et refusait toute écriture jusqu'à la
// fin.
func (b *Boucle) Tourner(ctx context.Context) {
	var fini sync.WaitGroup
	fini.Add(1)
	go func() {
		defer fini.Done()
		chaque(ctx, b.Intervalle, b.TourAnnonce)
	}()
	chaque(ctx, b.Intervalle, b.TourReleve)
	fini.Wait()
}

func chaque(ctx context.Context, intervalle time.Duration, f func(context.Context)) {
	minuterie := time.NewTicker(intervalle)
	defer minuterie.Stop()
	for {
		f(ctx)
		select {
		case <-ctx.Done():
			return
		case <-minuterie.C:
		}
	}
}

// Tour fait un relevé du module puis une annonce, l'un après l'autre.
// Aucune erreur ne l'arrête.
func (b *Boucle) Tour(ctx context.Context) {
	b.TourReleve(ctx)
	b.TourAnnonce(ctx)
}

// TourReleve fait un relevé du module ; un échec est écrit au journal.
func (b *Boucle) TourReleve(ctx context.Context) {
	if err := b.Module.Releve(ctx); err != nil {
		b.Log.Warn("relevé", "fonction", b.Fonction, "erreur", err)
		_ = b.Journal.Ecrire(ctx, journal.Entree{
			Niveau: journal.Alerte, Fonction: b.Fonction, Evenement: "releve_echec", Detail: err.Error(),
		})
	}
}

// TourAnnonce purge le journal puis annonce la fonction au panel.
func (b *Boucle) TourAnnonce(ctx context.Context) {
	if _, err := b.Journal.Purger(ctx, time.Now()); err != nil {
		b.Log.Error("purge du journal", "erreur", err)
	}
	if err := b.Annoncer(ctx); err != nil {
		b.Log.Warn("annonce au panel", "erreur", err)
	}
}

func (b *Boucle) Annoncer(ctx context.Context) error {
	entrees, err := b.Journal.AEnvoyer(ctx, LotJournal)
	if err != nil {
		return err
	}
	entrees = borner(entrees)
	trou, err := b.Journal.Trou(ctx)
	if err != nil {
		return err
	}
	if entrees == nil {
		entrees = []journal.Entree{}
	}
	fonctions := b.Fonctions
	if fonctions == nil {
		fonctions = []string{}
	}
	var accuse Accuse
	if err := b.Panel.Post(ctx, CheminAnnonce, Annonce{
		Version: b.Version, Fonction: b.Fonction, Fonctions: fonctions, Journal: entrees, Trou: trou,
	}, &accuse); err != nil {
		return err
	}
	if trou {
		if err := b.Journal.TrouSignale(ctx); err != nil {
			return err
		}
	}
	// On n'efface que ce qui est parti : un accusé plus grand que le dernier
	// envoyé effacerait des entrées écrites entre-temps, jamais reçues.
	jusqua := accuse.JournalAccuse
	if len(entrees) == 0 {
		return nil
	}
	if dernier := entrees[len(entrees)-1].ID; jusqua > dernier {
		jusqua = dernier
	}
	if jusqua > 0 {
		return b.Journal.Accuser(ctx, jusqua)
	}
	return nil
}
