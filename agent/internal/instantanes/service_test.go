package instantanes

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/SysMath/PowerDashboard/agent/internal/journal"
)

// piloteFactice copie system.data dans un dossier par instantané.
type piloteFactice struct {
	data, dossier string
	pris          []string
	detruits      []string
}

func (p *piloteFactice) Systeme() string { return "btrfs" }
func (p *piloteFactice) Prendre(ctx context.Context, nom string) error {
	p.pris = append(p.pris, nom)
	dest := filepath.Join(p.dossier, nom)
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return err
	}
	return Restaurer(ctx, p.data, dest)
}
func (p *piloteFactice) Detruire(_ context.Context, nom string) error {
	p.detruits = append(p.detruits, nom)
	return os.RemoveAll(filepath.Join(p.dossier, nom))
}
func (p *piloteFactice) Lister(context.Context) ([]string, error) {
	e, err := os.ReadDir(p.dossier)
	if err != nil {
		return nil, err
	}
	var noms []string
	for _, d := range e {
		if NomValide(d.Name()) {
			noms = append(noms, d.Name())
		}
	}
	sort.Strings(noms)
	return noms, nil
}
func (p *piloteFactice) Racine(nom string) string             { return filepath.Join(p.dossier, nom) }
func (p *piloteFactice) Taille(context.Context, string) int64 { return -1 }

// panelFactice sert l'état voulu et enregistre les rapports.
type panelFactice struct {
	mu        sync.Mutex
	etat      Etat
	brut      string
	rapports  []Rapport
	comptes   []CompteRendu
	liens     LiensDepot
	demandees []string
}

func (f *panelFactice) Get(_ context.Context, chemin string, q url.Values, _ string, dest any) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.demandees = append(f.demandees, chemin+"?"+q.Encode())
	switch {
	case chemin == CheminEtat && f.brut != "":
		return "", json.Unmarshal([]byte(f.brut), dest)
	case chemin == CheminEtat:
		b, _ := json.Marshal(f.etat)
		return "", json.Unmarshal(b, dest)
	case strings.HasPrefix(chemin, CheminDepot):
		b, _ := json.Marshal(f.liens)
		return "", json.Unmarshal(b, dest)
	}
	return "", errors.New("inconnu")
}

func (f *panelFactice) Post(_ context.Context, chemin string, corps, _ any) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	switch c := corps.(type) {
	case Rapport:
		f.rapports = append(f.rapports, c)
	case CompteRendu:
		f.comptes = append(f.comptes, c)
	}
	return nil
}

func (f *panelFactice) dernier() Rapport { return f.rapports[len(f.rapports)-1] }

const (
	srvA = "0f5e8a1c-3b2d-4c5e-9f00-112233445566"
	srvB = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f11223344"
)

type banc struct {
	s      *Service
	p      *piloteFactice
	panel  *panelFactice
	heure  time.Time
	data   string
	espace Espace
}

func nouveauBanc(t *testing.T) *banc {
	t.Helper()
	racine := t.TempDir()
	data := filepath.Join(racine, "volumes")
	ecrire(t, filepath.Join(data, srvA, "world/level.dat"), "monde A v1")
	ecrire(t, filepath.Join(data, srvB, "world/level.dat"), "monde B v1")
	p := &piloteFactice{data: data, dossier: filepath.Join(racine, "instantanes")}
	_ = os.MkdirAll(p.dossier, 0o700)
	j, err := journal.Ouvrir(filepath.Join(racine, "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { j.Fermer() })
	b := &banc{p: p, panel: &panelFactice{etat: Etat{Reglages: reglagesDefaut()}}, heure: t0, data: data, espace: Espace{Total: 100, Libre: 50}}
	b.s = &Service{
		Version: "test", Data: data, Travail: filepath.Join(racine, "tmp"),
		Panel: b.panel, Journal: j,
		Horloge:  func() time.Time { return b.heure },
		Detecter: func(context.Context) (Pilote, error) { return p, nil },
		Mesurer:  func(string) (Espace, error) { return b.espace, nil },
	}
	return b
}

func (b *banc) releve(t *testing.T) Rapport {
	t.Helper()
	if err := b.s.Releve(context.Background()); err != nil {
		t.Fatal(err)
	}
	return b.panel.dernier()
}

func TestReleveAutomatiqueEtRapport(t *testing.T) {
	b := nouveauBanc(t)
	r := b.releve(t)
	if len(b.p.pris) != 1 {
		t.Fatalf("un instantané automatique attendu, %d pris", len(b.p.pris))
	}
	if r.Systeme != "btrfs" || len(r.Instantanes) != 1 {
		t.Fatalf("rapport : %+v", r)
	}
	if got := strings.Join(r.Instantanes[0].Serveurs, ","); got != srvA+","+srvB && got != srvB+","+srvA {
		t.Fatalf("serveurs contenus : %s", got)
	}
	b.heure = b.heure.Add(10 * time.Minute)
	b.releve(t)
	if len(b.p.pris) != 1 {
		t.Fatal("rien de dû dans la même heure")
	}
}

func TestOrdrePrendreRegroupeEtJamaisRefait(t *testing.T) {
	b := nouveauBanc(t)
	b.panel.etat.Reglages.Niveaux = nil // pas d'automatique
	o := Ordre{ID: "11111111-2222-3333-4444-555555555555", Type: OrdrePrendre}
	o2 := Ordre{ID: "22222222-2222-3333-4444-555555555555", Type: OrdrePrendre}
	b.panel.etat.Ordres = []Ordre{o, o2}
	r := b.releve(t)
	if len(b.p.pris) != 1 || r.Ordres[0].Instantane != r.Ordres[1].Instantane || r.Ordres[0].Etat != "reussi" {
		t.Fatalf("deux demandes dans la même minute : un seul instantané (%v)", r.Ordres)
	}
	// Le panel rejoue le même ordre plus tard : même résultat, rien de pris.
	b.heure = b.heure.Add(time.Hour)
	b.panel.etat.Ordres = []Ordre{o}
	r2 := b.releve(t)
	if len(b.p.pris) != 1 || r2.Ordres[0].Instantane != r.Ordres[0].Instantane {
		t.Fatal("un ordre déjà exécuté ne se refait pas")
	}
}

func TestRestaurerUnSeulServeurAvecSurete(t *testing.T) {
	b := nouveauBanc(t)
	b.panel.etat.Reglages.Niveaux = nil
	b.panel.etat.Ordres = []Ordre{{ID: "11111111-2222-3333-4444-555555555555", Type: OrdrePrendre}}
	premier := b.releve(t).Ordres[0].Instantane

	b.panel.etat.Gardes = []string{premier} // le panel garde l'instantané manuel
	ecrire(t, filepath.Join(b.data, srvA, "world/level.dat"), "monde A corrompu")
	ecrire(t, filepath.Join(b.data, srvB, "world/level.dat"), "monde B v2")
	b.heure = b.heure.Add(time.Hour)
	b.panel.etat.Ordres = []Ordre{{ID: "33333333-2222-3333-4444-555555555555", Type: OrdreRestaurer, Serveur: srvA, Instantane: premier}}
	r := b.releve(t)
	if r.Ordres[0].Etat != "reussi" || r.Ordres[0].Instantane == "" || r.Ordres[0].Instantane == premier {
		t.Fatalf("résultat : %+v", r.Ordres[0])
	}
	if lire(t, filepath.Join(b.data, srvA, "world/level.dat")) != "monde A v1" {
		t.Fatal("serveur A non restauré")
	}
	if lire(t, filepath.Join(b.data, srvB, "world/level.dat")) != "monde B v2" {
		t.Fatal("le serveur B ne doit pas bouger")
	}
	surete := filepath.Join(b.p.Racine(r.Ordres[0].Instantane), srvA, "world/level.dat")
	if lire(t, surete) != "monde A corrompu" {
		t.Fatal("l'instantané de sûreté doit garder l'état d'avant : la restauration se défait")
	}
}

func TestEtatInvalideRejeteEnEntier(t *testing.T) {
	b := nouveauBanc(t)
	b.releve(t) // réglages valides retenus
	b.panel.brut = `{"reglages":{"actif":true,"niveaux":[],"duree_max_s":999999999,"seuil_libre_pct":1,"regroupement_s":0},"ordres":[{"id":"11111111-2222-3333-4444-555555555555","type":"prendre"}]}`
	b.heure = b.heure.Add(2 * time.Hour)
	avant := len(b.p.pris)
	if err := b.s.Releve(context.Background()); err == nil {
		t.Fatal("l'erreur doit remonter")
	}
	r := b.panel.dernier()
	if len(r.Ordres) != 0 {
		t.Fatal("aucun ordre d'un état invalide ne s'exécute")
	}
	// Les derniers réglages valides continuent : l'automatique de la nouvelle
	// heure est pris.
	if len(b.p.pris) != avant+1 {
		t.Fatal("le dernier état connu doit continuer de s'appliquer")
	}
}

func TestFonctionCoupeeRefuseSaufDetruire(t *testing.T) {
	b := nouveauBanc(t)
	b.releve(t)
	nom := b.p.pris[0]
	b.panel.etat.Reglages.Actif = false
	b.panel.etat.Ordres = []Ordre{
		{ID: "11111111-2222-3333-4444-555555555555", Type: OrdrePrendre},
		{ID: "22222222-2222-3333-4444-555555555555", Type: OrdreDetruire, Instantane: nom},
	}
	b.panel.etat.Gardes = []string{nom}
	r := b.releve(t)
	if r.Ordres[0].Etat != "echoue" || r.Ordres[1].Etat != "reussi" {
		t.Fatalf("résultats : %+v", r.Ordres)
	}
	if len(r.Instantanes) != 0 {
		t.Fatal("instantané non détruit")
	}
}

func TestArchiverVersS3(t *testing.T) {
	b := nouveauBanc(t)
	var recu []byte
	s3 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		recu, _ = io.ReadAll(r.Body)
		w.Header().Set("ETag", `"e1"`)
	}))
	defer s3.Close()
	b.s.S3 = s3.Client()
	b.panel.liens = LiensDepot{Parts: []string{s3.URL + "/p1"}, PartSize: 1 << 30}
	sauvegarde := "44444444-2222-3333-4444-555555555555"
	b.panel.etat.Ordres = []Ordre{{ID: "11111111-2222-3333-4444-555555555555", Type: OrdreArchiver, Serveur: srvA, Sauvegarde: sauvegarde}}
	r := b.releve(t)
	if r.Ordres[0].Etat != "reussi" || !r.Ordres[0].DepotCommence {
		t.Fatalf("résultat : %+v", r.Ordres[0])
	}
	if len(b.panel.comptes) != 1 {
		t.Fatal("compte rendu de la sauvegarde attendu")
	}
	cr := b.panel.comptes[0]
	if !cr.Successful || cr.ChecksumType != "sha1" || cr.Size != int64(len(recu)) || cr.Parts[0].ETag != `"e1"` {
		t.Fatalf("compte rendu : %+v", cr)
	}
	demande := b.panel.demandees[len(b.panel.demandees)-1]
	if !strings.HasPrefix(demande, CheminDepot+sauvegarde+"?size=") {
		t.Fatalf("demande de liens : %s", demande)
	}
	archive := filepath.Join(t.TempDir(), "a.tar.gz")
	_ = os.WriteFile(archive, recu, 0o600)
	if got := contenuArchive(t, archive); got["world/level.dat"] != "monde A v1" || len(got) != 1 {
		t.Fatalf("archive : %v", got)
	}
	if e, _ := os.ReadDir(b.s.Travail); len(e) != 0 {
		t.Fatal("archive temporaire laissée sur le disque")
	}
}

func TestSansSystemeDInstantanesLeMotifRemonte(t *testing.T) {
	b := nouveauBanc(t)
	b.s.Detecter = func(context.Context) (Pilote, error) {
		return nil, &ErrIndisponible{"system.data n'est ni sur btrfs ni sur ZFS"}
	}
	r := b.releve(t)
	if r.Systeme != "" || !strings.Contains(r.Motif, "ni sur btrfs") {
		t.Fatalf("rapport : %+v", r)
	}
}

func TestSousLeSeuilUnSeulSacrificeParReleve(t *testing.T) {
	b := nouveauBanc(t)
	b.panel.etat.Reglages.Niveaux = nil
	for i := range 3 {
		b.panel.etat.Ordres = []Ordre{{ID: "1111111" + string(rune('1'+i)) + "-2222-3333-4444-555555555555", Type: OrdrePrendre}}
		b.panel.etat.Gardes = append([]string(nil), b.p.pris...)
		b.releve(t)
		b.heure = b.heure.Add(time.Hour)
	}
	b.panel.etat.Gardes = append([]string(nil), b.p.pris...)
	b.panel.etat.Ordres = nil
	b.espace = Espace{Total: 100, Libre: 10}
	r := b.releve(t)
	if !r.Suspendu || len(b.p.detruits) != 1 || b.p.detruits[0] != b.p.pris[0] {
		t.Fatalf("un seul sacrifice par relevé, le plus ancien : %v (suspendu=%v)", b.p.detruits, r.Suspendu)
	}
	b.panel.etat.Ordres = []Ordre{{ID: "99999999-2222-3333-4444-555555555555", Type: OrdrePrendre}}
	b.panel.etat.Reglages.RegroupementS = 0
	r = b.releve(t)
	if r.Ordres[0].Etat != "echoue" || !strings.Contains(r.Ordres[0].Erreur, "espace") {
		t.Fatalf("sous le seuil, aucune nouvelle prise : %+v", r.Ordres[0])
	}
}
