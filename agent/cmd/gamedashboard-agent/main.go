// gamedashboard-agent : l'agent facultatif d'un node de jeu, installé à côté
// de Wings, sans jamais le modifier ni toucher à Docker (ADR 0008, ADR 0009).
//
// Chaque fonction tourne dans son propre service systemd :
//
//	gamedashboard-agent configure --panel-url … --token … --node …
//	gamedashboard-agent instantanes            (service des instantanés)
//	gamedashboard-agent instantanes verifier   (diagnostic, sans rien changer)
//	gamedashboard-agent instantanes purger --oui
//	gamedashboard-agent version
//
// Le pare-feu, le bilan de santé et la mise à jour de Wings (ADR 0008)
// s'ajouteront comme d'autres sous-commandes, chacune avec son service.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/SysMath/PowerDashboard/agent/internal/config"
	"github.com/SysMath/PowerDashboard/agent/internal/instantanes"
	"github.com/SysMath/PowerDashboard/agent/internal/journal"
	"github.com/SysMath/PowerDashboard/agent/internal/panel"
	"github.com/SysMath/PowerDashboard/agent/internal/socle"
	"github.com/SysMath/PowerDashboard/agent/internal/wings"
)

// Version est posée à la construction (-ldflags "-X main.Version=…").
var Version = "dev"

func main() {
	if err := lancer(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "gamedashboard-agent :", err)
		os.Exit(1)
	}
}

func lancer(args []string) error {
	if len(args) == 0 {
		return errors.New("commande attendue : configure, instantanes, version")
	}
	switch args[0] {
	case "version":
		fmt.Println(Version)
		return nil
	case "configure":
		return configurer(args[1:])
	case "instantanes":
		return instantanesCmd(args[1:])
	default:
		return fmt.Errorf("commande inconnue : %s", args[0])
	}
}

func configurer(args []string) error {
	fs := flag.NewFlagSet("configure", flag.ContinueOnError)
	chemin := fs.String("config", config.CheminParDefaut, "fichier de configuration")
	panelURL := fs.String("panel-url", "", "adresse du panel")
	cle := fs.String("token", "", "clé applicative de mise en service (portée nodes.configure)")
	node := fs.String("node", "", "identifiant du node")
	wingsConf := fs.String("wings-config", "/etc/pterodactyl/config.yml", "config.yml de Wings")
	ecraser := fs.Bool("override", false, "remplacer une configuration existante")
	activer := fs.String("activer", "", "fonctions à activer (instantanes)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *panelURL == "" || *cle == "" || *node == "" {
		return errors.New("--panel-url, --token et --node sont obligatoires")
	}
	base := config.ParDefaut()
	if _, err := os.Stat(*chemin); err == nil {
		if !*ecraser {
			return fmt.Errorf("%s existe déjà : --override pour le remplacer", *chemin)
		}
		if existante, err := config.Lire(*chemin); err == nil {
			base = existante
		}
	}
	var uuidWings, remoteWings string
	if w, err := wings.Lire(*wingsConf); err == nil {
		uuidWings, remoteWings = w.UUID, w.Remote
	}
	ctx, fin := context.WithTimeout(context.Background(), time.Minute)
	defer fin()
	recu, err := config.Telecharger(ctx, *panelURL, *cle, *node)
	if err != nil {
		return err
	}
	c, err := config.Appliquer(base, recu, uuidWings, remoteWings)
	if err != nil {
		return err
	}
	switch *activer {
	case "":
	case config.FonctionInstantanes:
		c.Instantanes.Enabled = true
	default:
		return fmt.Errorf("fonction inconnue : %s", *activer)
	}
	if err := config.Ecrire(*chemin, c); err != nil {
		return err
	}
	fmt.Printf("Configuration écrite dans %s (node %s, panel %s).\n", *chemin, c.UUID, c.Remote)
	return nil
}

type contexte struct {
	cfg     config.Config
	wings   wings.Config
	journal *journal.Journal
	service *instantanes.Service
	client  *panel.Client
}

func preparer(chemin string) (*contexte, error) {
	cfg, err := config.Lire(chemin)
	if err != nil {
		return nil, err
	}
	w, err := wings.Lire(cfg.System.WingsConfig)
	if err != nil {
		return nil, fmt.Errorf("config.yml de Wings : %w", err)
	}
	j, err := journal.Ouvrir(filepath.Join(cfg.System.RootDirectory, "agent.db"))
	if err != nil {
		return nil, err
	}
	client := panel.Nouveau(cfg.Remote, cfg.TokenID, cfg.Token, Version, time.Duration(cfg.RemoteQuery.Timeout)*time.Second)
	s := &instantanes.Service{
		Version:      Version,
		Data:         w.System.Data,
		Sauvegardes:  w.System.BackupDirectory,
		DossierBtrfs: cfg.Instantanes.Directory,
		Travail:      filepath.Join(cfg.System.RootDirectory, "tmp"),
		Mountinfo:    "/proc/self/mountinfo",
		Panel:        client,
		Journal:      j,
		Exec:         instantanes.ExecutantSysteme{},
		S3:           &http.Client{Timeout: 2 * time.Hour},
	}
	return &contexte{cfg: cfg, wings: w, journal: j, service: s, client: client}, nil
}

func instantanesCmd(args []string) error {
	sous := ""
	if len(args) > 0 && args[0] != "" && args[0][0] != '-' {
		sous, args = args[0], args[1:]
	}
	fs := flag.NewFlagSet("instantanes", flag.ContinueOnError)
	chemin := fs.String("config", config.CheminParDefaut, "fichier de configuration")
	oui := fs.Bool("oui", false, "confirmer la purge")
	if err := fs.Parse(args); err != nil {
		return err
	}
	c, err := preparer(*chemin)
	if err != nil {
		return err
	}
	defer c.journal.Fermer()

	switch sous {
	case "":
		return servir(c)
	case "verifier":
		return verifier(c)
	case "purger":
		if !*oui {
			return errors.New("détruit tous les instantanés de l'agent sur ce node : relancer avec --oui")
		}
		return purger(c)
	default:
		return fmt.Errorf("sous-commande inconnue : %s", sous)
	}
}

func servir(c *contexte) error {
	if !c.cfg.Instantanes.Enabled {
		return errors.New("fonction « instantanes » désactivée dans config.yml (instantanes.enabled)")
	}
	niveau := slog.LevelInfo
	if c.cfg.Debug {
		niveau = slog.LevelDebug
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: niveau}))
	ctx, fin := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer fin()
	log.Info("démarrage", "version", Version, "fonction", config.FonctionInstantanes, "data", c.wings.System.Data)
	b := &socle.Boucle{
		Version:    Version,
		Fonction:   config.FonctionInstantanes,
		Fonctions:  c.cfg.Fonctions(),
		Intervalle: time.Duration(c.cfg.RemoteQuery.Intervalle) * time.Second,
		Panel:      c.client,
		Journal:    c.journal,
		Module:     c.service,
		Log:        log,
	}
	b.Tourner(ctx)
	return nil
}

func verifier(c *contexte) error {
	ctx := context.Background()
	p, err := instantanes.Detecter(ctx, instantanes.ExecutantSysteme{}, c.wings.System.Data, c.wings.System.BackupDirectory, c.cfg.Instantanes.Directory, "/proc/self/mountinfo")
	if err != nil {
		return fmt.Errorf("instantanés impossibles sur ce node : %w", err)
	}
	fmt.Printf("system.data : %s (%s)\n", c.wings.System.Data, p.Systeme())
	if e, err := instantanes.MesurerEspace(c.wings.System.Data); err == nil {
		fmt.Printf("espace libre : %.1f %%\n", e.PourcentLibre())
	}
	noms, err := p.Lister(ctx)
	if err != nil {
		return err
	}
	fmt.Printf("instantanés de l'agent : %d\n", len(noms))
	for _, n := range noms {
		fmt.Println("  " + n)
	}
	return nil
}

func purger(c *contexte) error {
	ctx := context.Background()
	p, err := instantanes.Detecter(ctx, instantanes.ExecutantSysteme{}, c.wings.System.Data, c.wings.System.BackupDirectory, c.cfg.Instantanes.Directory, "/proc/self/mountinfo")
	if err != nil {
		return err
	}
	noms, err := p.Lister(ctx)
	if err != nil {
		return err
	}
	var erreurs []error
	for _, n := range noms {
		if err := p.Detruire(ctx, n); err != nil {
			erreurs = append(erreurs, err)
			continue
		}
		_ = c.journal.Ecrire(ctx, journal.Entree{Niveau: journal.Alerte, Fonction: config.FonctionInstantanes, Evenement: "purge", Detail: n})
		fmt.Println("détruit", n)
	}
	return errors.Join(erreurs...)
}
