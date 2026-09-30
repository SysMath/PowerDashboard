package config

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const exemple = `debug: false
uuid: 0f5e8a1c-3b2d-4c5e-9f00-112233445566
token_id: a1b2c3d4e5f60718
token: AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde
remote: https://panel.exemple.fr
instantanes:
  enabled: true
`

func ecrireFichier(t *testing.T, contenu string, mode os.FileMode) string {
	t.Helper()
	chemin := filepath.Join(t.TempDir(), "config.yml")
	if err := os.WriteFile(chemin, []byte(contenu), mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(chemin, mode); err != nil {
		t.Fatal(err)
	}
	return chemin
}

func TestLireAppliqueLesDefautsDeWings(t *testing.T) {
	c, err := Lire(ecrireFichier(t, exemple, 0o600))
	if err != nil {
		t.Fatal(err)
	}
	if c.RemoteQuery.Intervalle != 15 || c.System.WingsConfig != "/etc/pterodactyl/config.yml" {
		t.Fatalf("défauts non appliqués : %+v", c)
	}
	if got := c.Fonctions(); len(got) != 1 || got[0] != FonctionInstantanes {
		t.Fatalf("fonctions : %v", got)
	}
}

func TestLireRefuseUnFichierLisibleParDAutres(t *testing.T) {
	if _, err := Lire(ecrireFichier(t, exemple, 0o644)); err == nil || !strings.Contains(err.Error(), "chmod 600") {
		t.Fatalf("attendu : refus d'un config.yml en 0644, obtenu %v", err)
	}
}

func TestLireRefuseUneCleInconnue(t *testing.T) {
	if _, err := Lire(ecrireFichier(t, exemple+"inconnue: 1\n", 0o600)); err == nil {
		t.Fatal("une clé inconnue (faute de frappe) doit être refusée")
	}
}

func TestValiderRemote(t *testing.T) {
	for remote, ok := range map[string]bool{
		"https://panel.exemple.fr":        true,
		"https://panel.exemple.fr/":       true,
		"http://localhost:3000":           true,
		"http://panel.exemple.fr":         false,
		"https://panel.exemple.fr/chemin": false,
		"https://u:p@panel.exemple.fr":    false,
		"ftp://panel":                     false,
		"":                                false,
	} {
		if err := ValiderRemote(remote); (err == nil) != ok {
			t.Errorf("%q : attendu ok=%v, obtenu %v", remote, ok, err)
		}
	}
}

func TestEcrireEn0600(t *testing.T) {
	c, err := Lire(ecrireFichier(t, exemple, 0o600))
	if err != nil {
		t.Fatal(err)
	}
	chemin := filepath.Join(t.TempDir(), "sous", "config.yml")
	if err := Ecrire(chemin, c); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(chemin)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", info.Mode().Perm())
	}
	relu, err := Lire(chemin)
	if err != nil || relu.Token != c.Token {
		t.Fatalf("relecture : %v", err)
	}
}

func TestTelechargerCommeWingsConfigure(t *testing.T) {
	var chemin, auth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		chemin, auth = r.URL.Path, r.Header.Get("Authorization")
		_, _ = w.Write([]byte(`{"uuid":"0f5e8a1c-3b2d-4c5e-9f00-112233445566","token_id":"a1b2c3d4e5f60718","token":"AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde","remote":"https://panel.exemple.fr"}`))
	}))
	defer srv.Close()
	// httptest parle en http sur 127.0.0.1 : accepté comme en développement.
	recu, err := Telecharger(context.Background(), srv.URL, "cle", "0f5e8a1c-3b2d-4c5e-9f00-112233445566")
	if err != nil {
		t.Fatal(err)
	}
	if chemin != "/api/application/nodes/0f5e8a1c-3b2d-4c5e-9f00-112233445566/agent-configuration" || auth != "Bearer cle" {
		t.Fatalf("appel : %s %s", chemin, auth)
	}
	c, err := Appliquer(ParDefaut(), recu, "", "")
	if err != nil || c.TokenID != "a1b2c3d4e5f60718" {
		t.Fatalf("application : %v", err)
	}
}

func TestTelechargerRefuseUneCleExpiree(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer srv.Close()
	if _, err := Telecharger(context.Background(), srv.URL, "cle", "n"); err == nil || !strings.Contains(err.Error(), "nodes.configure") {
		t.Fatalf("obtenu %v", err)
	}
}

func TestAppliquerRefuseUnAutreNodeQueWings(t *testing.T) {
	recu := Configuration{UUID: "0f5e8a1c-3b2d-4c5e-9f00-112233445566", TokenID: "a1b2c3d4e5f60718", Token: strings.Repeat("a", 43), Remote: "https://panel.exemple.fr"}
	if _, err := Appliquer(ParDefaut(), recu, "11111111-2222-3333-4444-555555555555", ""); err == nil {
		t.Fatal("un agent ne doit pas servir un autre node que Wings")
	}
	if _, err := Appliquer(ParDefaut(), recu, "", "https://autre.exemple.fr"); err == nil {
		t.Fatal("un agent ne doit pas parler à un autre panel que Wings")
	}
	if _, err := Appliquer(ParDefaut(), recu, recu.UUID, "https://panel.exemple.fr/"); err != nil {
		t.Fatal(err)
	}
}
