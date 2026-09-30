package instantanes

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// Banc sur un vrai btrfs, dans une image en boucle. Il demande root et un
// noyau avec btrfs : il ne tourne que si GD_BTRFS_REEL=1 (runner Ubuntu
// hébergé, machine de test), et se saute ailleurs.
func TestBtrfsReel(t *testing.T) {
	if os.Getenv("GD_BTRFS_REEL") != "1" || os.Geteuid() != 0 {
		t.Skip("GD_BTRFS_REEL=1 et root requis")
	}
	ctx := context.Background()
	x := ExecutantSysteme{}
	dir := t.TempDir()
	image, mnt := filepath.Join(dir, "b.img"), filepath.Join(dir, "mnt")
	lancer := func(args ...string) {
		t.Helper()
		if out, err := exec.Command(args[0], args[1:]...).CombinedOutput(); err != nil {
			t.Fatalf("%v : %v : %s", args, err, out)
		}
	}
	lancer("truncate", "-s", "300M", image)
	lancer("mkfs.btrfs", "-q", image)
	_ = os.Mkdir(mnt, 0o755)
	lancer("mount", "-o", "loop", image, mnt)
	t.Cleanup(func() { _ = exec.Command("umount", mnt).Run() })
	data := filepath.Join(mnt, "volumes")
	lancer("btrfs", "subvolume", "create", data)
	ecrire(t, filepath.Join(data, srvA, "world/level.dat"), "v1")

	p, err := Detecter(ctx, x, data, filepath.Join(mnt, "backups"), filepath.Join(mnt, "instantanes"), "/proc/self/mountinfo")
	if err != nil {
		t.Fatal(err)
	}
	nom := NomPour(t0)
	if err := p.Prendre(ctx, nom); err != nil {
		t.Fatal(err)
	}
	ecrire(t, filepath.Join(data, srvA, "world/level.dat"), "v2")
	if err := Restaurer(ctx, filepath.Join(p.Racine(nom), srvA), filepath.Join(data, srvA)); err != nil {
		t.Fatal(err)
	}
	if lire(t, filepath.Join(data, srvA, "world/level.dat")) != "v1" {
		t.Fatal("restauration")
	}
	if err := os.WriteFile(filepath.Join(p.Racine(nom), "x"), nil, 0o600); err == nil {
		t.Fatal("un instantané doit être en lecture seule")
	}
	if err := p.Detruire(ctx, nom); err != nil {
		t.Fatal(err)
	}
	if noms, _ := p.Lister(ctx); len(noms) != 0 {
		t.Fatalf("reste : %v", noms)
	}
}
