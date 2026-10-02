package instantanes

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
)

func contenuArchive(t *testing.T, chemin string) map[string]string {
	t.Helper()
	f, err := os.Open(chemin)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		t.Fatal(err)
	}
	tr := tar.NewReader(gz)
	out := map[string]string{}
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return out
		}
		if err != nil {
			t.Fatal(err)
		}
		if h.Typeflag == tar.TypeSymlink {
			out[h.Name] = "-> " + h.Linkname
			continue
		}
		b, _ := io.ReadAll(tr)
		out[h.Name] = string(b)
	}
}

func TestArchiveAuFormatDeWings(t *testing.T) {
	source := t.TempDir()
	ecrire(t, filepath.Join(source, "world/level.dat"), "monde")
	ecrire(t, filepath.Join(source, "logs/latest.log"), "journal")
	ecrire(t, filepath.Join(source, "cache/x.bin"), "cache")
	ecrire(t, filepath.Join(source, "server.jar"), "jar")
	_ = os.Symlink("server.jar", filepath.Join(source, "lien.jar"))
	archive := filepath.Join(t.TempDir(), "a.tar.gz")
	f, _ := os.Create(archive)
	if err := Archiver(context.Background(), source, "logs/\n*.bin\n", f); err != nil {
		t.Fatal(err)
	}
	f.Close()
	got := contenuArchive(t, archive)
	var noms []string
	for n := range got {
		noms = append(noms, n)
	}
	sort.Strings(noms)
	if strings.Join(noms, ",") != "lien.jar,server.jar,world/level.dat" {
		t.Fatalf("entrées : %v (exclusions .pteroignore non appliquées ?)", noms)
	}
	if got["world/level.dat"] != "monde" || got["lien.jar"] != "-> server.jar" {
		t.Fatalf("contenu : %v", got)
	}
	somme, taille, err := Empreinte(archive)
	if err != nil || len(somme) != 40 || taille <= 0 {
		t.Fatalf("empreinte : %s %d %v", somme, taille, err)
	}
}

func TestTeleverserCommeWings(t *testing.T) {
	var mu sync.Mutex
	recu := map[string]string{}
	echecs := 0
	s3 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut || r.Header.Get("Content-Type") != "application/x-gzip" || r.Header.Get("Authorization") != "" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		if r.URL.Path == "/p2" && echecs == 0 {
			echecs++
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		b, _ := io.ReadAll(r.Body)
		if int64(len(b)) != r.ContentLength {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		recu[r.URL.Path] = string(b)
		w.Header().Set("ETag", `"`+r.URL.Path+`"`)
	}))
	defer s3.Close()
	archive := filepath.Join(t.TempDir(), "a")
	_ = os.WriteFile(archive, []byte("0123456789"), 0o600)
	parties, err := Televerser(context.Background(), s3.Client(), archive, 10, LiensDepot{Parts: []string{s3.URL + "/p1", s3.URL + "/p2", s3.URL + "/p3"}, PartSize: 4})
	if err != nil {
		t.Fatal(err)
	}
	if recu["/p1"] != "0123" || recu["/p2"] != "4567" || recu["/p3"] != "89" {
		t.Fatalf("parties : %v", recu)
	}
	if len(parties) != 3 || parties[2].PartNumber != 3 || parties[1].ETag != `"/p2"` {
		t.Fatalf("comptes rendus : %v", parties)
	}
}

func TestTeleverserSArreteSurUnRefus(t *testing.T) {
	appels := 0
	s3 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		appels++
		w.WriteHeader(http.StatusForbidden)
	}))
	defer s3.Close()
	archive := filepath.Join(t.TempDir(), "a")
	_ = os.WriteFile(archive, []byte("x"), 0o600)
	if _, err := Televerser(context.Background(), s3.Client(), archive, 1, LiensDepot{Parts: []string{s3.URL}, PartSize: 5}); err == nil || appels != 1 {
		t.Fatalf("un 403 ne se réessaie pas : %v, %d appels", err, appels)
	}
}
