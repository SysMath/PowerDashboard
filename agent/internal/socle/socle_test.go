package socle

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
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
