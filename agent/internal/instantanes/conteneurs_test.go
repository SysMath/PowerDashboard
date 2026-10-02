package instantanes

import (
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// L'agent ne touche jamais à la conteneurisation (ADR 0009, exigence de
// Matheo) : aucun paquet de Docker importé, aucun socket de Docker nommé
// dans le code de l'agent, où qu'il soit.
func TestAucunAccesADocker(t *testing.T) {
	racine, _ := filepath.Abs("../..")
	fset := token.NewFileSet()
	err := filepath.WalkDir(racine, func(chemin string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(chemin, ".go") || strings.HasSuffix(chemin, "_test.go") {
			return err
		}
		f, err := parser.ParseFile(fset, chemin, nil, parser.ImportsOnly)
		if err != nil {
			return err
		}
		for _, imp := range f.Imports {
			p, _ := strconv.Unquote(imp.Path.Value)
			if strings.Contains(strings.ToLower(p), "docker") || strings.Contains(p, "containerd") {
				t.Errorf("%s importe %s", chemin, p)
			}
		}
		brut, _ := os.ReadFile(chemin)
		if strings.Contains(string(brut), "docker.sock") {
			t.Errorf("%s nomme le socket de Docker", chemin)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
