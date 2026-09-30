// Package wings lit le config.yml de Wings, en lecture seule.
//
// L'agent n'écrit jamais dans la configuration de Wings et ne parle jamais à
// Docker (ADR 0009, « L'agent ne touche jamais à la conteneurisation ») : il
// lui faut seulement savoir où Wings range les serveurs et ses sauvegardes
// locales, et quel node et quel panel Wings sert (commande `configure`).
package wings

import (
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

type Config struct {
	UUID   string `yaml:"uuid"`
	Remote string `yaml:"remote"`
	System struct {
		RootDirectory   string `yaml:"root_directory"`
		Data            string `yaml:"data"`
		BackupDirectory string `yaml:"backup_directory"`
	} `yaml:"system"`
}

// Lire charge le fichier et applique les mêmes défauts que Wings
// (config/config.go de Wings v1.13.3).
func Lire(chemin string) (Config, error) {
	var c Config
	brut, err := os.ReadFile(chemin)
	if err != nil {
		return c, err
	}
	if err := yaml.Unmarshal(brut, &c); err != nil {
		return c, err
	}
	if c.System.RootDirectory == "" {
		c.System.RootDirectory = "/var/lib/pterodactyl"
	}
	if c.System.Data == "" {
		c.System.Data = "/var/lib/pterodactyl/volumes"
	}
	if c.System.BackupDirectory == "" {
		c.System.BackupDirectory = "/var/lib/pterodactyl/backups"
	}
	// Wings résout les liens symboliques de system.data au démarrage : on
	// raisonne sur le même chemin que lui.
	if d, err := filepath.EvalSymlinks(c.System.Data); err == nil {
		c.System.Data = d
	}
	if d, err := filepath.EvalSymlinks(c.System.BackupDirectory); err == nil {
		c.System.BackupDirectory = d
	}
	return c, nil
}
