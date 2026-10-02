package instantanes

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// Restaurer ramène le dossier vivant d'un serveur à l'état de `source` (son
// dossier dans un instantané), serveur arrêté.
//
// Le dossier `vivant` lui-même n'est jamais supprimé, recréé ni renommé :
// seul son contenu est vidé puis recopié (ADR 0009). C'est la seule chose que
// Wings, son SFTP et Docker connaissent. Toute écriture passe par un os.Root
// ouvert sur `vivant` : un lien symbolique posé pendant l'opération ne peut
// pas faire écrire ailleurs. Les liens de la source sont recopiés tels quels,
// jamais suivis.
//
// L'opération est rejouable : rejouée après une coupure, elle vide et
// recopie de nouveau.
func Restaurer(ctx context.Context, source, vivant string) error {
	info, err := os.Lstat(vivant)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("%s n'est pas un dossier", vivant)
	}
	if info, err := os.Lstat(source); err != nil {
		return err
	} else if !info.IsDir() {
		return fmt.Errorf("%s n'est pas un dossier", source)
	}

	racine, err := os.OpenRoot(vivant)
	if err != nil {
		return err
	}
	defer racine.Close()

	if err := vider(racine); err != nil {
		return fmt.Errorf("vidage de %s : %w", vivant, err)
	}

	type dateDossier struct {
		rel   string
		atime time.Time
		mtime time.Time
	}
	var dossiers []dateDossier

	err = filepath.WalkDir(source, func(chemin string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		rel, err := filepath.Rel(source, chemin)
		if err != nil {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		st, _ := info.Sys().(*syscall.Stat_t)
		switch {
		case d.IsDir():
			if rel != "." {
				if err := racine.Mkdir(rel, 0o700); err != nil {
					return err
				}
			}
			cible := rel
			if err := appliquerDroits(racine, cible, info, st, false); err != nil {
				return err
			}
			dossiers = append(dossiers, dateDossier{rel: cible, atime: dateAcces(st, info), mtime: info.ModTime()})
		case d.Type()&fs.ModeSymlink != 0:
			cible, err := os.Readlink(chemin)
			if err != nil {
				return err
			}
			if err := racine.Symlink(cible, rel); err != nil {
				return err
			}
			if st != nil {
				if err := racine.Lchown(rel, int(st.Uid), int(st.Gid)); err != nil {
					return err
				}
			}
		case d.Type().IsRegular():
			if err := copierFichier(racine, chemin, rel); err != nil {
				return err
			}
			if err := appliquerDroits(racine, rel, info, st, true); err != nil {
				return err
			}
		default:
			// Périphériques, tubes, sockets : rien de tel n'a sa place dans le
			// dossier d'un serveur de jeu, et Wings ne les sauvegarde pas non
			// plus.
		}
		return nil
	})
	if err != nil {
		return err
	}
	// Les dates des dossiers en dernier : y créer des entrées les change.
	for i := len(dossiers) - 1; i >= 0; i-- {
		d := dossiers[i]
		if err := racine.Chtimes(d.rel, d.atime, d.mtime); err != nil {
			return err
		}
	}
	return nil
}

func vider(racine *os.Root) error {
	f, err := racine.Open(".")
	if err != nil {
		return err
	}
	noms, err := f.Readdirnames(-1)
	f.Close()
	if err != nil {
		return err
	}
	for _, nom := range noms {
		if err := racine.RemoveAll(nom); err != nil {
			return err
		}
	}
	return nil
}

// Droits recopiés sans setuid ni setgid : rien de ce qui sort d'un serveur de
// jeu n'en a besoin.
func appliquerDroits(racine *os.Root, rel string, info fs.FileInfo, st *syscall.Stat_t, fichier bool) error {
	if st != nil {
		if err := racine.Lchown(rel, int(st.Uid), int(st.Gid)); err != nil {
			return err
		}
	}
	mode := info.Mode().Perm()
	if info.Mode()&fs.ModeSticky != 0 {
		mode |= fs.ModeSticky
	}
	if err := racine.Chmod(rel, mode); err != nil {
		return err
	}
	if fichier {
		return racine.Chtimes(rel, dateAcces(st, info), info.ModTime())
	}
	return nil
}

func dateAcces(st *syscall.Stat_t, info fs.FileInfo) time.Time {
	if st == nil {
		return info.ModTime()
	}
	return time.Unix(st.Atim.Sec, st.Atim.Nsec)
}

// copierFichier clone les extents quand le système le permet (btrfs,
// OpenZFS ≥ 2.2 avec le clonage de blocs) : rien n'est réellement copié.
// Sinon, copie ordinaire (io.Copy passe par copy_file_range).
func copierFichier(racine *os.Root, source, rel string) error {
	src, err := os.Open(source)
	if err != nil {
		return err
	}
	defer src.Close()
	dst, err := racine.OpenFile(rel, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	defer dst.Close()
	if err := unix.IoctlFileClone(int(dst.Fd()), int(src.Fd())); err == nil {
		return dst.Close()
	} else if !clonageImpossible(err) {
		return err
	}
	if _, err := io.Copy(dst, src); err != nil {
		return err
	}
	return dst.Close()
}

func clonageImpossible(err error) bool {
	return errors.Is(err, unix.EOPNOTSUPP) || errors.Is(err, unix.EXDEV) ||
		errors.Is(err, unix.EINVAL) || errors.Is(err, unix.ENOTTY) || errors.Is(err, unix.ENOSYS)
}
