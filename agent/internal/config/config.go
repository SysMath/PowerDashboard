// Package config lit et écrit /etc/gamedashboard-agent/config.yml.
//
// Le fichier reprend les clés de Wings qui ont un sens pour l'agent (uuid,
// token_id, token, remote, debug), plus une section par fonction (ADR 0008,
// « L'agent calqué sur Wings, et facultatif » ; ADR 0009). Il contient le
// jeton de l'agent : il est refusé s'il est lisible par un autre que root.
package config

import (
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

// Chemin par défaut, comme /etc/pterodactyl/config.yml pour Wings.
const CheminParDefaut = "/etc/gamedashboard-agent/config.yml"

// Fonctions connues de l'agent. Seule `instantanes` est écrite ; les autres
// (ADR 0008 : pare-feu, bilan de santé, mise à jour de Wings) s'ajouteront
// comme des modules à côté, sans toucher au socle.
const FonctionInstantanes = "instantanes"

type Config struct {
	Debug bool `yaml:"debug"`
	// UUID du node, le même que dans le config.yml de Wings.
	UUID    string `yaml:"uuid"`
	TokenID string `yaml:"token_id"`
	Token   string `yaml:"token"`
	// Adresse du panel (PANEL_ORIGIN), comme `remote` chez Wings.
	Remote string `yaml:"remote"`

	RemoteQuery RemoteQuery `yaml:"remote_query"`
	System      System      `yaml:"system"`
	Instantanes Instantanes `yaml:"instantanes"`
}

type RemoteQuery struct {
	// Délai d'un appel au panel, en secondes.
	Timeout int `yaml:"timeout"`
	// Intervalle entre deux relevés, en secondes (ADR 0008 : 15 s).
	Intervalle int `yaml:"interval"`
}

type System struct {
	// Dossier de travail : base SQLite, fichiers temporaires.
	RootDirectory string `yaml:"root_directory"`
	// config.yml de Wings, lu seulement (system.data, backup_directory).
	WingsConfig string `yaml:"wings_config"`
}

type Instantanes struct {
	Enabled bool `yaml:"enabled"`
	// btrfs seulement : où ranger les instantanés, sur le même système de
	// fichiers que system.data mais hors de lui (ADR 0009).
	Directory string `yaml:"directory"`
}

// Défauts appliqués avant la lecture, comme les `default:` de Wings.
func ParDefaut() Config {
	return Config{
		RemoteQuery: RemoteQuery{Timeout: 30, Intervalle: 15},
		System: System{
			RootDirectory: "/var/lib/gamedashboard-agent",
			WingsConfig:   "/etc/pterodactyl/config.yml",
		},
		Instantanes: Instantanes{
			Enabled:   false,
			Directory: "/var/lib/gamedashboard-agent/instantanes",
		},
	}
}

var (
	motifUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	// Même forme que le jeton de Wings tiré par le panel : 8 octets en
	// hexadécimal pour l'identifiant, 32 octets en base64url pour le secret.
	motifTokenID = regexp.MustCompile(`^[A-Za-z0-9]{16}$`)
	motifToken   = regexp.MustCompile(`^[A-Za-z0-9_-]{32,128}$`)
)

// Lire charge et valide le fichier. Un fichier lisible par le groupe ou par
// les autres est refusé : il porte le jeton.
func Lire(chemin string) (Config, error) {
	info, err := os.Stat(chemin)
	if err != nil {
		return Config{}, err
	}
	if info.Mode().Perm()&0o077 != 0 {
		return Config{}, fmt.Errorf("%s est lisible par d'autres que son propriétaire (%04o) : chmod 600", chemin, info.Mode().Perm())
	}
	brut, err := os.ReadFile(chemin)
	if err != nil {
		return Config{}, err
	}
	c := ParDefaut()
	dec := yaml.NewDecoder(strings.NewReader(string(brut)))
	dec.KnownFields(true)
	if err := dec.Decode(&c); err != nil {
		return Config{}, fmt.Errorf("%s : %w", chemin, err)
	}
	return c, c.Valider()
}

func (c Config) Valider() error {
	var erreurs []error
	if !motifUUID.MatchString(c.UUID) {
		erreurs = append(erreurs, errors.New("uuid : UUID du node attendu"))
	}
	if !motifTokenID.MatchString(c.TokenID) {
		erreurs = append(erreurs, errors.New("token_id : 16 caractères alphanumériques attendus"))
	}
	if !motifToken.MatchString(c.Token) {
		erreurs = append(erreurs, errors.New("token : 32 à 128 caractères base64url attendus"))
	}
	if err := ValiderRemote(c.Remote); err != nil {
		erreurs = append(erreurs, err)
	}
	if c.RemoteQuery.Timeout < 1 || c.RemoteQuery.Timeout > 300 {
		erreurs = append(erreurs, errors.New("remote_query.timeout : entre 1 et 300 secondes"))
	}
	if c.RemoteQuery.Intervalle < 5 || c.RemoteQuery.Intervalle > 300 {
		erreurs = append(erreurs, errors.New("remote_query.interval : entre 5 et 300 secondes"))
	}
	for nom, chemin := range map[string]string{
		"system.root_directory": c.System.RootDirectory,
		"system.wings_config":   c.System.WingsConfig,
		"instantanes.directory": c.Instantanes.Directory,
	} {
		if !filepath.IsAbs(chemin) || filepath.Clean(chemin) != chemin {
			erreurs = append(erreurs, fmt.Errorf("%s : chemin absolu et normalisé attendu", nom))
		}
	}
	return errors.Join(erreurs...)
}

// ValiderRemote accepte https, et http seulement vers la machine elle-même
// (panel et node sur le même hôte, en développement).
func ValiderRemote(remote string) error {
	u, err := url.Parse(remote)
	if err != nil || u.Host == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("remote : adresse du panel attendue, sans chemin ni paramètre (https://panel.exemple)")
	}
	switch u.Scheme {
	case "https":
		return nil
	case "http":
		if h := u.Hostname(); h == "localhost" || h == "127.0.0.1" || h == "::1" {
			return nil
		}
	}
	return errors.New("remote : https obligatoire (http seulement vers localhost)")
}

// Fonctions renvoie les fonctions activées, dans l'ordre stable où l'agent
// les annonce au panel.
func (c Config) Fonctions() []string {
	var f []string
	if c.Instantanes.Enabled {
		f = append(f, FonctionInstantanes)
	}
	return f
}

// Ecrire enregistre la configuration en 0600, par un fichier temporaire puis
// un renommage : un config.yml n'est jamais laissé à moitié écrit.
func Ecrire(chemin string, c Config) error {
	if err := c.Valider(); err != nil {
		return err
	}
	brut, err := yaml.Marshal(c)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(chemin), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(chemin), ".config-*.yml")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(fs.FileMode(0o600)); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(brut); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), chemin)
}
