package instantanes

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

type appel struct {
	programme string
	args      []string
}

type executantFactice struct {
	appels  []appel
	sorties map[string]string
}

func (e *executantFactice) Lancer(_ context.Context, programme string, args ...string) ([]byte, error) {
	e.appels = append(e.appels, appel{programme, args})
	return []byte(e.sorties[programme+" "+strings.Join(args, " ")]), nil
}

func TestBtrfsCommandes(t *testing.T) {
	x := &executantFactice{}
	b := &Btrfs{x: x, data: "/var/lib/pterodactyl/volumes", dossier: "/var/lib/gamedashboard-agent/instantanes"}
	nom := NomPour(t0)
	if err := b.Prendre(context.Background(), nom); err != nil {
		t.Fatal(err)
	}
	if err := b.Detruire(context.Background(), nom); err != nil {
		t.Fatal(err)
	}
	attendu := []appel{
		{"btrfs", []string{"subvolume", "snapshot", "-r", "/var/lib/pterodactyl/volumes", "/var/lib/gamedashboard-agent/instantanes/" + nom}},
		{"btrfs", []string{"subvolume", "delete", "/var/lib/gamedashboard-agent/instantanes/" + nom}},
	}
	if !reflect.DeepEqual(x.appels, attendu) {
		t.Fatalf("appels : %v", x.appels)
	}
	if b.Prendre(context.Background(), "../../etc") == nil || b.Detruire(context.Background(), "x") == nil {
		t.Fatal("un nom étranger doit être refusé avant toute commande")
	}
	if len(x.appels) != 2 {
		t.Fatal("commande lancée avec un nom refusé")
	}
}

func TestBtrfsListerIgnoreCeQuiNEstPasALAgent(t *testing.T) {
	dossier := t.TempDir()
	for _, n := range []string{NomPour(t0.Add(3600e9)), NomPour(t0), "snapper-1", ".tmp"} {
		_ = os.Mkdir(filepath.Join(dossier, n), 0o700)
	}
	b := &Btrfs{dossier: dossier}
	noms, err := b.Lister(context.Background())
	if err != nil || len(noms) != 2 || noms[0] != NomPour(t0) {
		t.Fatalf("noms : %v %v", noms, err)
	}
}

func TestZFSCommandesEtListe(t *testing.T) {
	nom := NomPour(t0)
	x := &executantFactice{sorties: map[string]string{
		"zfs list -H -t snapshot -o name -d 1 tank/volumes": "tank/volumes@" + nom + "\ntank/volumes@zfs-auto-snap_hourly\ntank/volumes/autre@" + nom + "\n",
		"zfs get -H -p -o value used tank/volumes@" + nom:   "4096\n",
	}}
	z := &ZFS{x: x, data: "/var/lib/pterodactyl/volumes", dataset: "tank/volumes"}
	noms, err := z.Lister(context.Background())
	if err != nil || !reflect.DeepEqual(noms, []string{nom}) {
		t.Fatalf("noms : %v %v", noms, err)
	}
	if z.Taille(context.Background(), nom) != 4096 {
		t.Fatal("taille")
	}
	_ = z.Prendre(context.Background(), nom)
	_ = z.Detruire(context.Background(), nom)
	fin := x.appels[len(x.appels)-2:]
	if !reflect.DeepEqual(fin, []appel{{"zfs", []string{"snapshot", "tank/volumes@" + nom}}, {"zfs", []string{"destroy", "tank/volumes@" + nom}}}) {
		t.Fatalf("appels : %v", fin)
	}
	if z.Racine(nom) != "/var/lib/pterodactyl/volumes/.zfs/snapshot/"+nom {
		t.Fatal("racine")
	}
}

func TestDatasetMonteSur(t *testing.T) {
	mountinfo := filepath.Join(t.TempDir(), "mountinfo")
	_ = os.WriteFile(mountinfo, []byte(strings.Join([]string{
		"22 1 0:21 / / rw,relatime shared:1 - ext4 /dev/sda1 rw",
		"40 22 0:40 / /var/lib/pterodactyl rw shared:20 - zfs tank/ptero rw,xattr",
		"41 40 0:41 / /var/lib/pterodactyl/volumes rw shared:21 - zfs tank/ptero/volumes rw,xattr",
		`42 22 0:42 / /srv/mes\040jeux rw shared:22 - zfs tank/jeux rw`,
	}, "\n")), 0o600)
	if ds, err := datasetMonteSur(mountinfo, "/var/lib/pterodactyl/volumes"); err != nil || ds != "tank/ptero/volumes" {
		t.Fatalf("%s %v", ds, err)
	}
	if ds, err := datasetMonteSur(mountinfo, "/srv/mes jeux"); err != nil || ds != "tank/jeux" {
		t.Fatalf("échappement : %s %v", ds, err)
	}
	if _, err := datasetMonteSur(mountinfo, "/var/lib/pterodactyl/volumes/sous-dossier"); err == nil {
		t.Fatal("un dossier dans un dataset n'est pas un point de montage")
	}
}

func TestDetecterRefuseUnSystemeOrdinaire(t *testing.T) {
	data := t.TempDir() // tmpfs ou ext4 : ni btrfs ni ZFS
	_, err := Detecter(context.Background(), &executantFactice{}, data, "/ailleurs", "/instantanes", "/proc/self/mountinfo")
	if err == nil || !strings.Contains(err.Error(), "ni sur btrfs ni sur ZFS") {
		t.Fatalf("obtenu %v", err)
	}
	_, err = Detecter(context.Background(), &executantFactice{}, data, filepath.Join(data, "backups"), "/i", "/proc/self/mountinfo")
	if err == nil || !strings.Contains(err.Error(), "backup_directory") {
		t.Fatalf("sauvegardes dans system.data : %v", err)
	}
}
