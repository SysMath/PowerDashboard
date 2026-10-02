package socle

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/SysMath/PowerDashboard/agent/internal/journal"
	"github.com/SysMath/PowerDashboard/agent/internal/panel"
)

type releveurFactice struct{ j *journal.Journal }

// Le relevé écrit une entrée pendant l'annonce précédente : elle ne doit pas
// être effacée avant d'avoir été envoyée.
func (r releveurFactice) Releve(ctx context.Context) error {
	return r.j.Ecrire(ctx, journal.Entree{Niveau: journal.Info, Fonction: "instantanes", Evenement: "tour"})
}

func TestAnnonceEtAccuseBorne(t *testing.T) {
	var recues []Annonce
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var a Annonce
		_ = json.NewDecoder(r.Body).Decode(&a)
		recues = append(recues, a)
		// Un panel qui accuse plus loin que ce qu'il a reçu.
		_, _ = w.Write([]byte(`{"journal_accuse": 999}`))
	}))
	defer srv.Close()
	j, err := journal.Ouvrir(filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer j.Fermer()
	b := &Boucle{
		Version: "1", Fonction: "instantanes", Fonctions: []string{"instantanes"},
		Intervalle: time.Second, Panel: panel.Nouveau(srv.URL, "a1b2c3d4e5f60718", "s", "1", time.Second),
		Journal: j, Module: releveurFactice{j}, Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	b.Tour(context.Background())
	if len(recues) != 1 || len(recues[0].Journal) != 1 || recues[0].Fonctions[0] != "instantanes" {
		t.Fatalf("annonce : %+v", recues)
	}
	_ = j.Ecrire(context.Background(), journal.Entree{Niveau: journal.Info, Fonction: "instantanes", Evenement: "apres"})
	reste, _ := j.AEnvoyer(context.Background(), 10)
	if len(reste) != 1 || reste[0].Evenement != "apres" {
		t.Fatalf("une entrée écrite après l'envoi ne doit pas être effacée : %v", reste)
	}
}

// Le pire lot tient sous le mégaoctet que Fastify accepte par défaut pour un
// corps JSON, même quand l'échappement gonfle chaque caractère.
func TestLotSousLeMegaoctet(t *testing.T) {
	for _, motif := range []string{"é", "<", "😀"} {
		long := strings.Repeat(motif, journal.DetailMax)
		ev := strings.Repeat("e", journal.EvenementMax)
		entrees := make([]journal.Entree, LotJournal)
		for i := range entrees {
			entrees[i] = journal.Entree{ID: int64(i + 1), Horodatage: time.Now(), Niveau: journal.Erreur,
				Fonction: "instantanes", Evenement: ev, Serveur: "aaaaaaaa-1111-2222-3333-444444444444", Detail: long}
		}
		lot := borner(entrees)
		if len(lot) == 0 {
			t.Fatalf("%q : lot vide", motif)
		}
		corps, err := json.Marshal(Annonce{Version: "1.0.0", Fonction: "instantanes", Fonctions: []string{"instantanes"}, Journal: lot})
		if err != nil {
			t.Fatal(err)
		}
		if len(corps) >= 1<<20 {
			t.Fatalf("%q : lot de %d octets", motif, len(corps))
		}
	}
}

// releveurLong travaille jusqu'à l'arrêt, comme une longue archive S3.
type releveurLong struct{}

func (releveurLong) Releve(ctx context.Context) error {
	<-ctx.Done()
	return nil
}

// Non-régression : l'annonce suivait le relevé dans la même boucle, et une
// longue archive faisait passer la fonction pour muette auprès du panel.
func TestAnnonceSansAttendreLeReleve(t *testing.T) {
	var annonces atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		annonces.Add(1)
		_, _ = w.Write([]byte(`{"journal_accuse": 0}`))
	}))
	defer srv.Close()
	j, err := journal.Ouvrir(filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer j.Fermer()
	b := &Boucle{
		Version: "1", Fonction: "instantanes", Fonctions: []string{"instantanes"},
		Intervalle: 10 * time.Millisecond, Panel: panel.Nouveau(srv.URL, "a1b2c3d4e5f60718", "s", "1", time.Second),
		Journal: j, Module: releveurLong{}, Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	ctx, fin := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer fin()
	b.Tourner(ctx)
	if n := annonces.Load(); n < 3 {
		t.Fatalf("%d annonce(s) pendant un relevé bloqué, au moins 3 attendues", n)
	}
}
