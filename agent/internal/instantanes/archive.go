package instantanes

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	ignore "github.com/sabhiram/go-gitignore"
)

// Archiver écrit en tar.gz le dossier d'un serveur pris dans un instantané,
// au format que Wings produit et sait restaurer (server/filesystem/archive.go
// de Wings v1.13.3) : fichiers et liens symboliques seulement, chemins
// relatifs au dossier du serveur, exclusions au format .pteroignore, avec la
// même bibliothèque que Wings (go-gitignore) pour les interpréter à
// l'identique. Les sockets sont ignorés, comme chez Wings.
//
// La source est un instantané en lecture seule : l'archive est cohérente,
// tous les fichiers pris au même instant (ADR 0009).
func Archiver(ctx context.Context, source, exclusions string, w io.Writer) error {
	gz, err := gzip.NewWriterLevel(w, gzip.BestSpeed)
	if err != nil {
		return err
	}
	tw := tar.NewWriter(gz)

	var exclu *ignore.GitIgnore
	if strings.TrimSpace(exclusions) != "" {
		exclu = ignore.CompileIgnoreLines(strings.Split(exclusions, "\n")...)
	}

	err = filepath.WalkDir(source, func(chemin string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(source, chemin)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if exclu != nil && exclu.MatchesPath(rel) {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		var cible string
		switch {
		case info.Mode()&fs.ModeSymlink != 0:
			if cible, err = os.Readlink(chemin); err != nil {
				return err
			}
		case info.Mode().IsRegular():
		default:
			return nil
		}
		entete, err := tar.FileInfoHeader(info, filepath.ToSlash(cible))
		if err != nil {
			return err
		}
		entete.Name = rel
		if err := tw.WriteHeader(entete); err != nil {
			return err
		}
		if !info.Mode().IsRegular() || entete.Size == 0 {
			return nil
		}
		f, err := os.Open(chemin)
		if err != nil {
			return err
		}
		defer f.Close()
		_, err = io.Copy(tw, io.LimitReader(f, entete.Size))
		return err
	})
	if err != nil {
		return err
	}
	if err := tw.Close(); err != nil {
		return err
	}
	return gz.Close()
}

// Televersement ---------------------------------------------------------------

// LiensDepot est la réponse du panel à une demande d'adresses de dépôt : le
// même contenu que pour Wings (BackupRemoteUploadResponse), produit par le
// même S3Service.
type LiensDepot struct {
	Parts    []string `json:"parts"`
	PartSize int64    `json:"part_size"`
}

type Partie struct {
	ETag       string `json:"etag"`
	PartNumber int    `json:"part_number"`
}

// CompteRendu est le compte rendu d'une sauvegarde, identique à celui de
// Wings (BackupRequest) : le panel le clôt par le même code.
type CompteRendu struct {
	Checksum     string   `json:"checksum"`
	ChecksumType string   `json:"checksum_type"`
	Size         int64    `json:"size"`
	Successful   bool     `json:"successful"`
	Parts        []Partie `json:"parts"`
}

// Empreinte rend le SHA-1 (comme Wings) et la taille d'un fichier.
func Empreinte(chemin string) (string, int64, error) {
	f, err := os.Open(chemin)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	// SHA-1 parce que c'est la somme que Wings rend dans son compte rendu
	// (`checksum_type: sha1`) et que le panel range telle quelle : un contrôle
	// d'intégrité au format de Wings, pas une signature ni un secret.
	h := sha1.New() // nosemgrep: go.lang.security.audit.crypto.use_of_weak_crypto.use-of-sha1
	n, err := io.Copy(h, f)
	if err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(h.Sum(nil)), n, nil
}

// Televerser dépose l'archive par les liens signés, une partie par lien,
// exactement comme Wings : la dernière partie prend le reste, dépôt en
// application/x-gzip (seul type que Wings accepte à la restauration).
func Televerser(ctx context.Context, client *http.Client, archive string, taille int64, liens LiensDepot) ([]Partie, error) {
	if len(liens.Parts) == 0 || liens.PartSize <= 0 {
		return nil, errors.New("dépôt : aucun lien ou taille de partie nulle")
	}
	if int64(len(liens.Parts)-1)*liens.PartSize >= taille && taille > 0 {
		return nil, errors.New("dépôt : plus de liens que de parties")
	}
	f, err := os.Open(archive)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	parties := make([]Partie, 0, len(liens.Parts))
	for i, lien := range liens.Parts {
		if err := lienAutorise(lien); err != nil {
			return nil, err
		}
		debut := int64(i) * liens.PartSize
		longueur := liens.PartSize
		if i == len(liens.Parts)-1 {
			longueur = taille - debut
		}
		etag, err := deposerPartie(ctx, client, lien, io.NewSectionReader(f, debut, longueur), longueur)
		if err != nil {
			return nil, fmt.Errorf("dépôt de la partie %d : %w", i+1, err)
		}
		parties = append(parties, Partie{ETag: etag, PartNumber: i + 1})
	}
	return parties, nil
}

func lienAutorise(lien string) error {
	if !strings.HasPrefix(lien, "https://") && !strings.HasPrefix(lien, "http://") {
		return errors.New("dépôt : lien signé invalide")
	}
	return nil
}

func deposerPartie(ctx context.Context, client *http.Client, lien string, partie *io.SectionReader, longueur int64) (string, error) {
	var derniere error
	for essai := range 4 {
		if essai > 0 {
			select {
			case <-ctx.Done():
				return "", ctx.Err()
			case <-time.After(time.Duration(1<<essai) * time.Second):
			}
		}
		if _, err := partie.Seek(0, io.SeekStart); err != nil {
			return "", err
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPut, lien, io.NopCloser(partie))
		if err != nil {
			return "", err
		}
		req.ContentLength = longueur
		req.Header.Set("Content-Length", strconv.FormatInt(longueur, 10))
		req.Header.Set("Content-Type", "application/x-gzip")
		res, err := client.Do(req)
		if err != nil {
			if ctx.Err() != nil {
				return "", ctx.Err()
			}
			derniere = err
			continue
		}
		_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 1<<16))
		res.Body.Close()
		if res.StatusCode == http.StatusOK {
			return res.Header.Get("ETag"), nil
		}
		derniere = fmt.Errorf("HTTP %d", res.StatusCode)
		if res.StatusCode < 500 {
			return "", derniere
		}
	}
	return "", derniere
}
