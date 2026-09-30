package journal

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func ouvrir(t *testing.T) *Journal {
	t.Helper()
	j, err := Ouvrir(filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { j.Fermer() })
	return j
}

func TestEnvoiPuisAccuse(t *testing.T) {
	ctx := context.Background()
	j := ouvrir(t)
	for _, ev := range []string{"a", "b", "c"} {
		if err := j.Ecrire(ctx, Entree{Niveau: Info, Fonction: "instantanes", Evenement: ev}); err != nil {
			t.Fatal(err)
		}
	}
	lot, err := j.AEnvoyer(ctx, 2)
	if err != nil || len(lot) != 2 || lot[0].Evenement != "a" {
		t.Fatalf("lot : %v %v", lot, err)
	}
	if err := j.Accuser(ctx, lot[1].ID); err != nil {
		t.Fatal(err)
	}
	reste, _ := j.AEnvoyer(ctx, 10)
	if len(reste) != 1 || reste[0].Evenement != "c" {
		t.Fatalf("reste : %v", reste)
	}
}

func TestPurgeSignaleUnTrou(t *testing.T) {
	ctx := context.Background()
	j := ouvrir(t)
	maintenant := time.Now()
	_ = j.Ecrire(ctx, Entree{Horodatage: maintenant.Add(-31 * 24 * time.Hour), Niveau: Info, Fonction: "f", Evenement: "vieux"})
	_ = j.Ecrire(ctx, Entree{Horodatage: maintenant, Niveau: Info, Fonction: "f", Evenement: "recent"})
	tombe, err := j.Purger(ctx, maintenant)
	if err != nil || !tombe {
		t.Fatalf("purge : %v %v", tombe, err)
	}
	if trou, _ := j.Trou(ctx); !trou {
		t.Fatal("le trou doit être signalé au prochain envoi")
	}
	reste, _ := j.AEnvoyer(ctx, 10)
	if len(reste) != 1 || reste[0].Evenement != "recent" {
		t.Fatalf("reste : %v", reste)
	}
	_ = j.TrouSignale(ctx)
	if trou, _ := j.Trou(ctx); trou {
		t.Fatal("trou toujours signalé")
	}
}

func TestOrdreJamaisRefait(t *testing.T) {
	ctx := context.Background()
	j := ouvrir(t)
	now := time.Now()
	nouveau, err := j.Commencer(ctx, "o1", "instantanes", now)
	if err != nil || !nouveau {
		t.Fatal(err)
	}
	if nouveau, _ := j.Commencer(ctx, "o1", "instantanes", now); nouveau {
		t.Fatal("un ordre connu ne recommence pas")
	}
	_ = j.Terminer(ctx, "o1", OrdreReussi, `{"id":"o1"}`, now)
	o, existe, _ := j.Ordre(ctx, "o1")
	if !existe || o.Etat != OrdreReussi || o.Resultat != `{"id":"o1"}` {
		t.Fatalf("ordre : %+v", o)
	}
	// Un ordre terminé n'est pas rouvert.
	_ = j.Rouvrir(ctx, "o1")
	if _, existe, _ := j.Ordre(ctx, "o1"); !existe {
		t.Fatal("ordre terminé effacé")
	}
}

func TestValeursPersistantes(t *testing.T) {
	ctx := context.Background()
	chemin := filepath.Join(t.TempDir(), "agent.db")
	j, _ := Ouvrir(chemin)
	_ = j.Poser(ctx, "cle", "v1")
	j.Fermer()
	j, _ = Ouvrir(chemin)
	defer j.Fermer()
	if v, _ := j.Valeur(ctx, "cle"); v != "v1" {
		t.Fatalf("valeur : %q", v)
	}
}

// Un lot de LotJournal entrées au plus long doit tenir sous le mégaoctet que
// le panel accepte : tronquées à l'écriture, jamais à l'envoi.
func TestLongueursBornees(t *testing.T) {
	ctx := context.Background()
	j := ouvrir(t)
	long := strings.Repeat("é", DetailMax+500)
	if err := j.Ecrire(ctx, Entree{Niveau: Erreur, Fonction: "instantanes", Evenement: long, Detail: long}); err != nil {
		t.Fatal(err)
	}
	lot, err := j.AEnvoyer(ctx, 1)
	if err != nil || len(lot) != 1 {
		t.Fatalf("lot : %v %v", lot, err)
	}
	if n := utf8.RuneCountInString(lot[0].Detail); n != DetailMax || !utf8.ValidString(lot[0].Detail) {
		t.Fatalf("détail de %d caractères", n)
	}
	if n := utf8.RuneCountInString(lot[0].Evenement); n != EvenementMax {
		t.Fatalf("événement de %d caractères", n)
	}
}
