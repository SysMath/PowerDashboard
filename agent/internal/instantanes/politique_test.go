package instantanes

import (
	"testing"
	"time"
)

var t0 = time.Date(2026, 9, 30, 12, 0, 0, 0, time.UTC)

func reglagesDefaut() Reglages {
	return Reglages{
		Actif: true,
		Niveaux: []Niveau{
			{IntervalleS: 3600, RetentionS: 24 * 3600},
			{IntervalleS: 24 * 3600, RetentionS: 7 * 24 * 3600},
		},
		DureeMaxS:     30 * 24 * 3600,
		SeuilLibrePct: 15,
		RegroupementS: 60,
	}
}

func TestNoms(t *testing.T) {
	n := NomPour(t0.Add(1500 * time.Millisecond))
	if n != "gd-20260930T120001.500Z" || !NomValide(n) {
		t.Fatalf("nom : %s", n)
	}
	if got, ok := PrisLe(n); !ok || !got.Equal(t0.Add(1500*time.Millisecond)) {
		t.Fatalf("instant : %v", got)
	}
	for _, mauvais := range []string{"gd-x", "../gd-20260930T120001.500Z", "gd-20260930T120001.500Z/..", "autre@gd-20260930T120001.500Z", "zfs-auto-snap"} {
		if NomValide(mauvais) {
			t.Errorf("%q accepté", mauvais)
		}
	}
	if UUIDValide("../../etc") || !UUIDValide("0f5e8a1c-3b2d-4c5e-9f00-112233445566") {
		t.Fatal("UUID")
	}
}

func TestAPrendreAuto(t *testing.T) {
	r := reglagesDefaut()
	if !APrendreAuto(nil, t0, r) {
		t.Fatal("aucun instantané : dû")
	}
	noms := []string{NomPour(t0.Add(5 * time.Minute))}
	if APrendreAuto(noms, t0.Add(59*time.Minute), r) {
		t.Fatal("déjà un instantané dans l'heure et le jour")
	}
	if !APrendreAuto(noms, t0.Add(61*time.Minute), r) {
		t.Fatal("nouvelle heure : dû")
	}
	r.Actif = false
	if APrendreAuto(nil, t0, r) {
		t.Fatal("fonction coupée : jamais d'instantané automatique")
	}
}

func TestRotation(t *testing.T) {
	r := reglagesDefaut()
	maintenant := t0.Add(10 * 24 * time.Hour)
	var noms []string
	// Un instantané toutes les 30 minutes pendant 10 jours.
	for d := time.Duration(0); d <= 10*24*time.Hour; d += 30 * time.Minute {
		noms = append(noms, NomPour(t0.Add(d)))
	}
	vieux := NomPour(t0.Add(-40 * 24 * time.Hour))
	garde := NomPour(t0.Add(-20 * 24 * time.Hour))
	noms = append(noms, vieux, garde)
	gardes := map[string]bool{garde: true, vieux: true}
	conserves := AConserver(noms, maintenant, r, gardes, nil)
	// 24 h à l'heure : 24 ou 25 ; 7 jours au jour : 7 ou 8 (en partie
	// communs) ; plus le gardé de 20 jours. Le gardé de 40 jours dépasse la
	// durée maximale : il part malgré la garde.
	if conserves[vieux] {
		t.Fatal("au-delà de la durée maximale, même gardé, un instantané part")
	}
	if !conserves[garde] {
		t.Fatal("un instantané gardé par le panel reste")
	}
	if n := len(conserves); n < 31 || n > 36 {
		t.Fatalf("%d conservés", n)
	}
	detruits := ADetruire(noms, maintenant, r, gardes, map[string]bool{vieux: true})
	for _, d := range detruits {
		if d == vieux {
			t.Fatal("un instantané en cours d'usage n'est jamais détruit")
		}
	}
	if len(detruits)+len(AConserver(noms, maintenant, r, gardes, map[string]bool{vieux: true})) != len(noms) {
		t.Fatal("partition incomplète")
	}
}

func TestOrdreDeSacrifice(t *testing.T) {
	a, b, c, d := NomPour(t0), NomPour(t0.Add(time.Hour)), NomPour(t0.Add(2*time.Hour)), NomPour(t0.Add(3*time.Hour))
	got := OrdreDeSacrifice([]string{d, c, b, a}, map[string]bool{a: true}, map[string]bool{c: true})
	if len(got) != 3 || got[0] != b || got[1] != d || got[2] != a {
		t.Fatalf("ordre : %v", got)
	}
}

func TestReutilisable(t *testing.T) {
	n := NomPour(t0)
	if got, ok := Reutilisable([]string{n}, t0.Add(30*time.Second), time.Minute); !ok || got != n {
		t.Fatal("dans la fenêtre : réutilisé")
	}
	if _, ok := Reutilisable([]string{n}, t0.Add(2*time.Minute), time.Minute); ok {
		t.Fatal("hors fenêtre : non réutilisé")
	}
	if _, ok := Reutilisable([]string{n}, t0, 0); ok {
		t.Fatal("fenêtre nulle : jamais réutilisé")
	}
}

func TestBornesDesReglages(t *testing.T) {
	if err := reglagesDefaut().Valider(); err != nil {
		t.Fatal(err)
	}
	cas := map[string]func(*Reglages){
		"seuil trop bas":         func(r *Reglages) { r.SeuilLibrePct = 1 },
		"durée au-delà de 90 j":  func(r *Reglages) { r.DureeMaxS = 91 * 24 * 3600 },
		"intervalle trop court":  func(r *Reglages) { r.Niveaux[0].IntervalleS = 10 },
		"rétention > durée max":  func(r *Reglages) { r.Niveaux[1].RetentionS = 31 * 24 * 3600 },
		"regroupement trop long": func(r *Reglages) { r.RegroupementS = 3600 },
		"trop de niveaux":        func(r *Reglages) { r.Niveaux = make([]Niveau, 9) },
	}
	for nom, f := range cas {
		r := reglagesDefaut()
		f(&r)
		if r.Valider() == nil {
			t.Errorf("%s : accepté", nom)
		}
	}
}

func TestValidationDesOrdres(t *testing.T) {
	id := "11111111-2222-3333-4444-555555555555"
	srv := "0f5e8a1c-3b2d-4c5e-9f00-112233445566"
	nom := NomPour(t0)
	bons := []Ordre{
		{ID: id, Type: OrdrePrendre},
		{ID: id, Type: OrdreDetruire, Instantane: nom},
		{ID: id, Type: OrdreRestaurer, Serveur: srv, Instantane: nom},
		{ID: id, Type: OrdreArchiver, Serveur: srv, Sauvegarde: id},
	}
	for _, o := range bons {
		if err := o.Valider(); err != nil {
			t.Errorf("%s : %v", o.Type, err)
		}
	}
	mauvais := []Ordre{
		{ID: "x", Type: OrdrePrendre},
		{ID: id, Type: "executer"},
		{ID: id, Type: OrdreRestaurer, Serveur: "../..", Instantane: nom},
		{ID: id, Type: OrdreRestaurer, Serveur: srv, Instantane: "/etc"},
		{ID: id, Type: OrdreDetruire, Instantane: "pool/autre@snap"},
	}
	for _, o := range mauvais {
		if o.Valider() == nil {
			t.Errorf("%+v accepté", o)
		}
	}
	e := Etat{Reglages: reglagesDefaut(), Ordres: []Ordre{bons[0], bons[0]}}
	if e.Valider() == nil {
		t.Fatal("ordre en double accepté")
	}
}

func TestDelaiDeGrace(t *testing.T) {
	r := reglagesDefaut()
	r.Niveaux = nil
	recent := NomPour(t0.Add(-30 * time.Minute))
	ancien := NomPour(t0.Add(-2 * time.Hour))
	got := ADetruire([]string{recent, ancien}, t0, r, nil, nil)
	if len(got) != 1 || got[0] != ancien {
		t.Fatalf("un instantané de moins d'une heure, pas encore connu du panel, reste : %v", got)
	}
}
