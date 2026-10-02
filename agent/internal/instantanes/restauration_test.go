package instantanes

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func ecrire(t *testing.T, chemin, contenu string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(chemin), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(chemin, []byte(contenu), 0o640); err != nil {
		t.Fatal(err)
	}
}

func lire(t *testing.T, chemin string) string {
	t.Helper()
	b, err := os.ReadFile(chemin)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestRestaurerRendLEtatExact(t *testing.T) {
	source, vivant := t.TempDir(), t.TempDir()
	ecrire(t, filepath.Join(source, "world/level.dat"), "ancien monde")
	ecrire(t, filepath.Join(source, "server.properties"), "motd=avant")
	_ = os.Chmod(filepath.Join(source, "server.properties"), 0o600)
	date := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)
	_ = os.Chtimes(filepath.Join(source, "server.properties"), date, date)
	_ = os.Symlink("world/level.dat", filepath.Join(source, "lien"))
	_ = os.Mkdir(filepath.Join(source, "vide"), 0o750)

	ecrire(t, filepath.Join(vivant, "world/level.dat"), "monde corrompu")
	ecrire(t, filepath.Join(vivant, "plugins/greffon-fautif.jar"), "x")
	avant, _ := os.Stat(vivant)

	if err := Restaurer(context.Background(), source, vivant); err != nil {
		t.Fatal(err)
	}
	if lire(t, filepath.Join(vivant, "world/level.dat")) != "ancien monde" {
		t.Fatal("contenu non rendu")
	}
	if _, err := os.Stat(filepath.Join(vivant, "plugins")); !os.IsNotExist(err) {
		t.Fatal("un fichier ajouté depuis l'instantané doit disparaître")
	}
	info, _ := os.Stat(filepath.Join(vivant, "server.properties"))
	if info.Mode().Perm() != 0o600 || !info.ModTime().Equal(date) {
		t.Fatalf("droits ou date non rendus : %v %v", info.Mode(), info.ModTime())
	}
	if cible, err := os.Readlink(filepath.Join(vivant, "lien")); err != nil || cible != "world/level.dat" {
		t.Fatal("lien symbolique non recopié tel quel")
	}
	if info, err := os.Stat(filepath.Join(vivant, "vide")); err != nil || !info.IsDir() || info.Mode().Perm() != 0o750 {
		t.Fatal("dossier vide non rendu")
	}
	apres, _ := os.Stat(vivant)
	if !os.SameFile(avant, apres) {
		t.Fatal("le dossier du serveur lui-même ne doit jamais être remplacé")
	}
}

func TestRestaurerNeSortJamaisDuDossier(t *testing.T) {
	source, vivant, dehors := t.TempDir(), t.TempDir(), t.TempDir()
	ecrire(t, filepath.Join(dehors, "precieux"), "intact")
	// Le dossier vivant contient un lien vers l'extérieur : le vider doit
	// supprimer le lien, pas ce qu'il désigne.
	_ = os.Symlink(dehors, filepath.Join(vivant, "evasion"))
	// La source contient un lien absolu : il est recopié, jamais suivi.
	_ = os.Symlink(dehors+"/precieux", filepath.Join(source, "lien-absolu"))
	ecrire(t, filepath.Join(source, "evasion/precieux"), "écrasé ?")

	if err := Restaurer(context.Background(), source, vivant); err != nil {
		t.Fatal(err)
	}
	if lire(t, filepath.Join(dehors, "precieux")) != "intact" {
		t.Fatal("écriture hors du dossier du serveur")
	}
	if info, err := os.Lstat(filepath.Join(vivant, "evasion")); err != nil || !info.IsDir() {
		t.Fatal("evasion doit être un vrai dossier, celui de l'instantané")
	}
}

func TestRestaurerEstRejouable(t *testing.T) {
	source, vivant := t.TempDir(), t.TempDir()
	ecrire(t, filepath.Join(source, "a/b"), "1")
	for range 2 {
		if err := Restaurer(context.Background(), source, vivant); err != nil {
			t.Fatal(err)
		}
	}
	if lire(t, filepath.Join(vivant, "a/b")) != "1" {
		t.Fatal("rejeu")
	}
}

func TestRestaurerRefuseUnLienALaPlaceDuDossier(t *testing.T) {
	source, parent := t.TempDir(), t.TempDir()
	_ = os.Symlink(t.TempDir(), filepath.Join(parent, "serveur"))
	if Restaurer(context.Background(), source, filepath.Join(parent, "serveur")) == nil {
		t.Fatal("un dossier de serveur remplacé par un lien doit être refusé")
	}
}
