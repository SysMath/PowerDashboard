package instantanes

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

// Pilote prend, liste et détruit les instantanés du système de fichiers qui
// porte system.data, tout entier (ADR 0009 : un seul sous-volume ou dataset
// pour tous les serveurs du node).
type Pilote interface {
	// Systeme vaut "btrfs" ou "zfs".
	Systeme() string
	Prendre(ctx context.Context, nom string) error
	Detruire(ctx context.Context, nom string) error
	// Lister rend les instantanés de l'agent (préfixe gd-), les plus anciens
	// d'abord. Ceux d'un autre outil sont ignorés, jamais touchés.
	Lister(ctx context.Context) ([]string, error)
	// Racine est le chemin, en lecture seule, de system.data tel qu'il était
	// dans l'instantané.
	Racine(nom string) string
	// Taille rend l'espace que l'instantané retient seul, quand le système
	// sait le dire (ZFS), -1 sinon.
	Taille(ctx context.Context, nom string) int64
}

// Executant lance une commande sans shell. Remplacé dans les tests.
type Executant interface {
	Lancer(ctx context.Context, programme string, args ...string) ([]byte, error)
}

type ExecutantSysteme struct{}

func (ExecutantSysteme) Lancer(ctx context.Context, programme string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, programme, args...)
	var sortie, erreur bytes.Buffer
	cmd.Stdout = &sortie
	cmd.Stderr = &erreur
	// Environnement minimal : ni LANG ni variables héritées ne changent la
	// sortie qu'on analyse.
	cmd.Env = []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL=C"}
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("%s %s : %w : %s", programme, strings.Join(args, " "), err, strings.TrimSpace(erreur.String()))
	}
	return sortie.Bytes(), nil
}

// Noms ----------------------------------------------------------------------

// Un nom d'instantané est toujours tiré par l'agent : gd-, puis l'instant de
// la prise en UTC à la milliseconde. Il est valide pour btrfs comme pour ZFS,
// et c'est le seul que l'agent accepte dans un ordre.
var motifNom = regexp.MustCompile(`^gd-(\d{8}T\d{6}\.\d{3})Z$`)

const formatNom = "20060102T150405.000"

func NomPour(t time.Time) string { return "gd-" + t.UTC().Format(formatNom) + "Z" }

func NomValide(nom string) bool { return motifNom.MatchString(nom) }

// PrisLe rend l'instant d'un nom valide.
func PrisLe(nom string) (time.Time, bool) {
	m := motifNom.FindStringSubmatch(nom)
	if m == nil {
		return time.Time{}, false
	}
	t, err := time.ParseInLocation(formatNom, m[1], time.UTC)
	return t, err == nil
}

var motifUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func UUIDValide(u string) bool { return motifUUID.MatchString(u) }

func trierNoms(noms []string) []string {
	sort.Strings(noms) // l'horodatage à largeur fixe trie dans l'ordre du temps
	return noms
}

// Détection -----------------------------------------------------------------

const (
	magicBtrfs = 0x9123683E
	magicZFS   = 0x2FC12FC1
	// Numéro d'inode de la racine de tout sous-volume btrfs
	// (BTRFS_FIRST_FREE_OBJECTID).
	inodeRacineBtrfs = 256
)

// ErrIndisponible explique pourquoi la fonction ne peut pas tourner sur ce
// node ; le motif est rapporté au panel, qui grise la fonction.
type ErrIndisponible struct{ Motif string }

func (e *ErrIndisponible) Error() string { return e.Motif }

// Detecter reconnaît le système de fichiers de system.data et vérifie les
// conditions de l'ADR 0009 : system.data est la racine d'un sous-volume
// btrfs ou d'un dataset ZFS, et backup_directory n'est pas dedans.
func Detecter(ctx context.Context, x Executant, data, sauvegardes, dossierBtrfs, mountinfo string) (Pilote, error) {
	var st unix.Statfs_t
	if err := unix.Statfs(data, &st); err != nil {
		return nil, &ErrIndisponible{fmt.Sprintf("system.data (%s) illisible : %v", data, err)}
	}
	if dedans(sauvegardes, data) {
		return nil, &ErrIndisponible{fmt.Sprintf("backup_directory (%s) est dans system.data : chaque instantané retiendrait des archives entières", sauvegardes)}
	}
	switch uint32(st.Type) {
	case magicBtrfs:
		var s unix.Stat_t
		if err := unix.Stat(data, &s); err != nil {
			return nil, &ErrIndisponible{err.Error()}
		}
		if s.Ino != inodeRacineBtrfs {
			return nil, &ErrIndisponible{fmt.Sprintf("%s est sur btrfs mais n'est pas la racine d'un sous-volume", data)}
		}
		if dedans(dossierBtrfs, data) {
			return nil, &ErrIndisponible{fmt.Sprintf("instantanes.directory (%s) ne doit pas être dans system.data", dossierBtrfs)}
		}
		if err := os.MkdirAll(dossierBtrfs, 0o700); err != nil {
			return nil, &ErrIndisponible{err.Error()}
		}
		var sd unix.Stat_t
		if err := unix.Stat(dossierBtrfs, &sd); err != nil {
			return nil, &ErrIndisponible{err.Error()}
		}
		if sd.Dev != s.Dev && !memeSystemeBtrfs(dossierBtrfs, data) {
			return nil, &ErrIndisponible{fmt.Sprintf("instantanes.directory (%s) doit être sur le même système btrfs que system.data", dossierBtrfs)}
		}
		return &Btrfs{x: x, data: data, dossier: dossierBtrfs}, nil
	case magicZFS:
		dataset, err := datasetMonteSur(mountinfo, data)
		if err != nil {
			return nil, &ErrIndisponible{err.Error()}
		}
		return &ZFS{x: x, data: data, dataset: dataset}, nil
	default:
		return nil, &ErrIndisponible{fmt.Sprintf("system.data (%s) n'est ni sur btrfs ni sur ZFS", data)}
	}
}

func dedans(chemin, parent string) bool {
	rel, err := filepath.Rel(parent, chemin)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, "../")
}

// Deux sous-volumes d'un même système btrfs ont des numéros de périphérique
// différents : on compare alors l'identifiant du système de fichiers.
func memeSystemeBtrfs(a, b string) bool {
	var sa, sb unix.Statfs_t
	if unix.Statfs(a, &sa) != nil || unix.Statfs(b, &sb) != nil {
		return false
	}
	return uint32(sa.Type) == magicBtrfs && sa.Fsid == sb.Fsid
}

// datasetMonteSur lit /proc/self/mountinfo : le dataset ZFS monté exactement
// sur `point`. Un dossier dans un dataset ne suffit pas (ADR 0009).
func datasetMonteSur(mountinfo, point string) (string, error) {
	f, err := os.Open(mountinfo)
	if err != nil {
		return "", err
	}
	defer f.Close()
	s := bufio.NewScanner(f)
	for s.Scan() {
		// id parent maj:min racine point options … - type source options
		champs := strings.Fields(s.Text())
		sep := -1
		for i, c := range champs {
			if c == "-" {
				sep = i
				break
			}
		}
		if sep < 5 || len(champs) < sep+3 {
			continue
		}
		if decoderMountinfo(champs[4]) == point && champs[sep+1] == "zfs" {
			return decoderMountinfo(champs[sep+2]), nil
		}
	}
	if err := s.Err(); err != nil {
		return "", err
	}
	return "", fmt.Errorf("%s est sur ZFS mais n'est pas le point de montage d'un dataset", point)
}

// mountinfo échappe espace, tabulation, saut de ligne et barre oblique
// inverse en octal (\040…).
func decoderMountinfo(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+3 < len(s) {
			if v, err := strconv.ParseUint(s[i+1:i+4], 8, 8); err == nil {
				b.WriteByte(byte(v))
				i += 3
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

// btrfs ---------------------------------------------------------------------

type Btrfs struct {
	x       Executant
	data    string
	dossier string
}

func (b *Btrfs) Systeme() string { return "btrfs" }

func (b *Btrfs) Prendre(ctx context.Context, nom string) error {
	if !NomValide(nom) {
		return fmt.Errorf("nom d'instantané refusé : %q", nom)
	}
	_, err := b.x.Lancer(ctx, "btrfs", "subvolume", "snapshot", "-r", b.data, filepath.Join(b.dossier, nom))
	return err
}

func (b *Btrfs) Detruire(ctx context.Context, nom string) error {
	if !NomValide(nom) {
		return fmt.Errorf("nom d'instantané refusé : %q", nom)
	}
	_, err := b.x.Lancer(ctx, "btrfs", "subvolume", "delete", filepath.Join(b.dossier, nom))
	return err
}

func (b *Btrfs) Lister(context.Context) ([]string, error) {
	entrees, err := os.ReadDir(b.dossier)
	if err != nil {
		return nil, err
	}
	var noms []string
	for _, e := range entrees {
		if e.IsDir() && NomValide(e.Name()) {
			noms = append(noms, e.Name())
		}
	}
	return trierNoms(noms), nil
}

func (b *Btrfs) Racine(nom string) string { return filepath.Join(b.dossier, nom) }

// Sans quotas btrfs (coûteux, et désactivés par défaut), la part d'un
// instantané n'est pas connue.
func (b *Btrfs) Taille(context.Context, string) int64 { return -1 }

// ZFS -----------------------------------------------------------------------

type ZFS struct {
	x       Executant
	data    string
	dataset string
}

func (z *ZFS) Systeme() string { return "zfs" }

func (z *ZFS) Prendre(ctx context.Context, nom string) error {
	if !NomValide(nom) {
		return fmt.Errorf("nom d'instantané refusé : %q", nom)
	}
	_, err := z.x.Lancer(ctx, "zfs", "snapshot", z.dataset+"@"+nom)
	return err
}

func (z *ZFS) Detruire(ctx context.Context, nom string) error {
	if !NomValide(nom) {
		return fmt.Errorf("nom d'instantané refusé : %q", nom)
	}
	// Jamais -r ni -R : on ne détruit que cet instantané, de ce dataset.
	_, err := z.x.Lancer(ctx, "zfs", "destroy", z.dataset+"@"+nom)
	return err
}

func (z *ZFS) Lister(ctx context.Context) ([]string, error) {
	sortie, err := z.x.Lancer(ctx, "zfs", "list", "-H", "-t", "snapshot", "-o", "name", "-d", "1", z.dataset)
	if err != nil {
		return nil, err
	}
	var noms []string
	for _, ligne := range strings.Split(strings.TrimSpace(string(sortie)), "\n") {
		ds, nom, ok := strings.Cut(strings.TrimSpace(ligne), "@")
		if ok && ds == z.dataset && NomValide(nom) {
			noms = append(noms, nom)
		}
	}
	return trierNoms(noms), nil
}

func (z *ZFS) Racine(nom string) string { return filepath.Join(z.data, ".zfs", "snapshot", nom) }

func (z *ZFS) Taille(ctx context.Context, nom string) int64 {
	sortie, err := z.x.Lancer(ctx, "zfs", "get", "-H", "-p", "-o", "value", "used", z.dataset+"@"+nom)
	if err != nil {
		return -1
	}
	n, err := strconv.ParseInt(strings.TrimSpace(string(sortie)), 10, 64)
	if err != nil {
		return -1
	}
	return n
}

// Espace libre --------------------------------------------------------------

type Espace struct {
	Total int64 `json:"total"`
	Libre int64 `json:"libre"`
}

func (e Espace) PourcentLibre() float64 {
	if e.Total <= 0 {
		return 0
	}
	return 100 * float64(e.Libre) / float64(e.Total)
}

func MesurerEspace(chemin string) (Espace, error) {
	var st unix.Statfs_t
	if err := unix.Statfs(chemin, &st); err != nil {
		return Espace{}, err
	}
	return Espace{Total: int64(st.Blocks) * st.Bsize, Libre: int64(st.Bavail) * st.Bsize}, nil
}

// ServeursContenus liste les dossiers de serveur (UUID) d'un instantané.
func ServeursContenus(racine string) ([]string, error) {
	entrees, err := os.ReadDir(racine)
	if err != nil {
		return nil, err
	}
	var uuids []string
	for _, e := range entrees {
		if e.IsDir() && UUIDValide(e.Name()) {
			uuids = append(uuids, e.Name())
		}
	}
	sort.Strings(uuids)
	return uuids, nil
}

var errIntrouvable = errors.New("instantané introuvable")
