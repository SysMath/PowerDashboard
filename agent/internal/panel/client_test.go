package panel

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestEnTetesDeWings(t *testing.T) {
	var h http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h = r.Header
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()
	c := Nouveau(srv.URL, "a1b2c3d4e5f60718", "secret", "1.2.3", time.Second)
	var r struct{ OK bool }
	if _, err := c.Get(context.Background(), "/api/node-agent/snapshots", nil, "", &r); err != nil || !r.OK {
		t.Fatal(err)
	}
	if h.Get("Authorization") != "Bearer a1b2c3d4e5f60718.secret" {
		t.Fatalf("Authorization : %q", h.Get("Authorization"))
	}
	if h.Get("User-Agent") != "GameDashboard Agent/v1.2.3 (id:a1b2c3d4e5f60718)" {
		t.Fatalf("User-Agent : %q", h.Get("User-Agent"))
	}
}

func TestRedirectionRefusee(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "https://ailleurs.exemple/login", http.StatusFound)
	}))
	defer srv.Close()
	c := Nouveau(srv.URL, "a1b2c3d4e5f60718", "secret", "1", time.Second)
	_, err := c.Get(context.Background(), "/api/node-agent/snapshots", nil, "", nil)
	var e *ErreurHTTP
	if !errors.As(err, &e) || e.Statut != http.StatusFound {
		t.Fatalf("une redirection doit être une erreur, pas suivie : %v", err)
	}
}

func TestCheminHorsPrefixeRefuse(t *testing.T) {
	c := Nouveau("https://panel.exemple", "a", "b", "1", time.Second)
	if err := c.Post(context.Background(), "/api/remote/servers", nil, nil); err == nil {
		t.Fatal("l'agent ne doit appeler que /api/node-agent/")
	}
}

func TestReponseTropVolumineuse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`"` + strings.Repeat("x", TailleMaxReponse+10) + `"`))
	}))
	defer srv.Close()
	c := Nouveau(srv.URL, "a", "b", "1", 5*time.Second)
	var s string
	if _, err := c.Get(context.Background(), "/api/node-agent/x", nil, "", &s); err == nil {
		t.Fatal("réponse trop volumineuse acceptée")
	}
}
