package instantanes

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/SysMath/PowerDashboard/agent/internal/config"
	"github.com/SysMath/PowerDashboard/agent/internal/journal"
	"github.com/SysMath/PowerDashboard/agent/internal/panel"
)

// Panel est la part du client du panel dont le module a besoin.
type Panel interface {
	Get(ctx context.Context, chemin string, requete url.Values, etag string, dest any) (string, error)
	Post(ctx context.Context, chemin string, corps, dest any) error
}

// Service est la fonction « instantanés » de l'agent (ADR 0009).
//
// À chaque relevé : lire l'état voulu par le panel, exécuter ses ordres,
// prendre l'instantané automatique dû, faire tourner, tenir le seuil d'espace
// libre, rendre compte. Il ne parle jamais à Docker ni à Wings : il ne voit
// que des fichiers et le système de fichiers qui les porte.
type Service struct {
	Version      string
	Data         string // system.data de Wings
	Sauvegardes  string // backup_directory de Wings
	DossierBtrfs string
	Travail      string // dossier de travail (archives temporaires)
	Mountinfo    string

	Panel   Panel
	Journal *journal.Journal
	Exec    Executant
	// Client HTTP des dépôts S3 : sans l'en-tête d'authentification du panel.
	S3      *http.Client
	Horloge func() time.Time
	// Detecter et Mesurer sont remplaçables dans les tests.
	Detecter func(ctx context.Context) (Pilote, error)
	Mesurer  func(chemin string) (Espace, error)

	mu       sync.Mutex
	reglages Reglages
	gardes   map[string]bool
	enCours  map[string]bool
}

const cleReglages = "instantanes.reglages"

func (s *Service) maintenant() time.Time {
	if s.Horloge != nil {
		return s.Horloge()
	}
	return time.Now()
}

func (s *Service) mesurer() (Espace, error) {
	if s.Mesurer != nil {
		return s.Mesurer(s.Data)
	}
	return MesurerEspace(s.Data)
}

func (s *Service) detecter(ctx context.Context) (Pilote, error) {
	if s.Detecter != nil {
		return s.Detecter(ctx)
	}
	return Detecter(ctx, s.Exec, s.Data, s.Sauvegardes, s.DossierBtrfs, s.Mountinfo)
}

func (s *Service) noter(ctx context.Context, n journal.Niveau, evenement, serveur, detail string) {
	_ = s.Journal.Ecrire(ctx, journal.Entree{
		Horodatage: s.maintenant(), Niveau: n, Fonction: config.FonctionInstantanes,
		Evenement: evenement, Serveur: serveur, Detail: detail,
	})
}

// Releve fait un tour complet. Une erreur de liaison avec le panel n'arrête
// rien : les derniers réglages valides continuent de s'appliquer (« dernier
// état connu »).
func (s *Service) Releve(ctx context.Context) error {
	s.chargerReglages(ctx)

	rapport := Rapport{Version: s.Version, Instantanes: []InstantaneRapporte{}, Ordres: []ResultatOrdre{}}
	p, err := s.detecter(ctx)
	if err != nil {
		var ind *ErrIndisponible
		if !errors.As(err, &ind) {
			return err
		}
		rapport.Motif = ind.Motif
		// Rien à exécuter sans système d'instantanés ; les ordres restent chez
		// le panel, qui les refuse ou les rend à Wings.
		return s.Panel.Post(ctx, CheminRapport, rapport, nil)
	}
	rapport.Systeme = p.Systeme()

	var etat Etat
	_, errPanel := s.Panel.Get(ctx, CheminEtat, nil, "", &etat)
	if errPanel == nil {
		if err := etat.Valider(); err != nil {
			s.noter(ctx, journal.Erreur, "etat_refuse", "", err.Error())
			errPanel = err
			etat = Etat{}
		} else {
			s.retenirReglages(ctx, etat)
		}
	}

	for _, o := range etat.Ordres {
		rapport.Ordres = append(rapport.Ordres, s.executer(ctx, p, o))
	}

	s.mu.Lock()
	r := s.reglages
	s.mu.Unlock()

	if noms, err := p.Lister(ctx); err == nil && APrendreAuto(noms, s.maintenant(), r) {
		if nom, err := s.prendre(ctx, p, r); err != nil {
			s.noter(ctx, journal.Erreur, "auto_echec", "", err.Error())
		} else {
			s.noter(ctx, journal.Info, "auto_pris", "", nom)
		}
	}

	s.tourner(ctx, p, r)
	suspendu := s.tenirSeuil(ctx, p, r)

	noms, err := p.Lister(ctx)
	if err != nil {
		return err
	}
	for _, nom := range noms {
		t, _ := PrisLe(nom)
		serveurs, err := ServeursContenus(p.Racine(nom))
		if err != nil {
			serveurs = []string{}
		}
		ir := InstantaneRapporte{Nom: nom, PrisLe: t, Serveurs: serveurs}
		if o := p.Taille(ctx, nom); o >= 0 {
			ir.Octets = &o
		}
		rapport.Instantanes = append(rapport.Instantanes, ir)
	}
	if e, err := s.mesurer(); err == nil {
		rapport.Espace = &e
	}
	rapport.Suspendu = suspendu

	if err := s.Panel.Post(ctx, CheminRapport, rapport, nil); err != nil {
		return err
	}
	return errPanel
}

// Réglages : gardés en base pour valoir après un redémarrage sans panel ---

func (s *Service) chargerReglages(ctx context.Context) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.gardes != nil {
		return
	}
	s.reglages = ReglagesSurs()
	s.gardes = map[string]bool{}
	s.enCours = map[string]bool{}
	if brut, err := s.Journal.Valeur(ctx, cleReglages); err == nil && brut != "" {
		var e Etat
		if json.Unmarshal([]byte(brut), &e) == nil && e.Reglages.Valider() == nil {
			s.reglages = e.Reglages
			for _, g := range e.Gardes {
				s.gardes[g] = true
			}
		}
	}
}

func (s *Service) retenirReglages(ctx context.Context, e Etat) {
	s.mu.Lock()
	s.reglages = e.Reglages
	s.gardes = map[string]bool{}
	for _, g := range e.Gardes {
		s.gardes[g] = true
	}
	s.mu.Unlock()
	brut, _ := json.Marshal(Etat{Reglages: e.Reglages, Gardes: e.Gardes})
	_ = s.Journal.Poser(ctx, cleReglages, string(brut))
}

// Ordres ------------------------------------------------------------------

func (s *Service) executer(ctx context.Context, p Pilote, o Ordre) ResultatOrdre {
	connu, existe, err := s.Journal.Ordre(ctx, o.ID)
	if err != nil {
		return ResultatOrdre{ID: o.ID, Etat: "echoue", Erreur: err.Error()}
	}
	if existe && connu.Etat != journal.OrdreEnCours {
		// Déjà exécuté : on rend le même résultat, sans rien refaire.
		var r ResultatOrdre
		if json.Unmarshal([]byte(connu.Resultat), &r) == nil {
			return r
		}
	}
	if existe {
		// Resté « en cours » : l'agent s'est arrêté pendant l'exécution.
		// Chaque ordre se rejoue sans dommage.
		_ = s.Journal.Rouvrir(ctx, o.ID)
	}
	if _, err := s.Journal.Commencer(ctx, o.ID, config.FonctionInstantanes, s.maintenant()); err != nil {
		return ResultatOrdre{ID: o.ID, Etat: "echoue", Erreur: err.Error()}
	}

	s.mu.Lock()
	r := s.reglages
	s.mu.Unlock()

	res := ResultatOrdre{ID: o.ID}
	var errOrdre error
	switch {
	case !r.Actif && o.Type != OrdreDetruire:
		errOrdre = errors.New("instantanés désactivés sur ce node")
	case o.Type == OrdrePrendre:
		res.Instantane, errOrdre = s.prendreRegroupe(ctx, p, r)
	case o.Type == OrdreDetruire:
		errOrdre = s.detruire(ctx, p, o.Instantane)
	case o.Type == OrdreRestaurer:
		res.Instantane, errOrdre = s.restaurer(ctx, p, r, o)
	case o.Type == OrdreArchiver:
		res.Instantane, res.DepotCommence, errOrdre = s.archiver(ctx, p, r, o)
	}
	etat := journal.OrdreReussi
	res.Etat = string(journal.OrdreReussi)
	niveau, evenement := journal.Info, "ordre_"+string(o.Type)
	if errOrdre != nil {
		etat = journal.OrdreEchoue
		res.Etat = string(journal.OrdreEchoue)
		res.Erreur = errOrdre.Error()
		niveau = journal.Erreur
		evenement += "_echec"
	}
	s.noter(ctx, niveau, evenement, o.Serveur, fmt.Sprintf("ordre %s %s %s", o.ID, res.Instantane, res.Erreur))
	brut, _ := json.Marshal(res)
	_ = s.Journal.Terminer(ctx, o.ID, etat, string(brut), s.maintenant())
	return res
}

// prendre prend un nouvel instantané, après avoir vérifié l'espace libre.
func (s *Service) prendre(ctx context.Context, p Pilote, r Reglages) (string, error) {
	if s.tenirSeuil(ctx, p, r) {
		return "", errors.New("espace disque insuffisant : instantanés suspendus")
	}
	noms, err := p.Lister(ctx)
	if err != nil {
		return "", err
	}
	nom := NomPour(s.maintenant())
	for existe(noms, nom) {
		// Deux prises dans la même milliseconde : on attend la suivante.
		time.Sleep(time.Millisecond)
		nom = NomPour(s.maintenant())
	}
	if err := p.Prendre(ctx, nom); err != nil {
		return "", err
	}
	return nom, nil
}

func (s *Service) prendreRegroupe(ctx context.Context, p Pilote, r Reglages) (string, error) {
	noms, err := p.Lister(ctx)
	if err != nil {
		return "", err
	}
	if nom, ok := Reutilisable(noms, s.maintenant(), r.Regroupement()); ok {
		return nom, nil
	}
	return s.prendre(ctx, p, r)
}

func (s *Service) detruire(ctx context.Context, p Pilote, nom string) error {
	noms, err := p.Lister(ctx)
	if err != nil {
		return err
	}
	if !existe(noms, nom) {
		return nil // déjà détruit : l'ordre est atteint
	}
	s.mu.Lock()
	occupe := s.enCours[nom]
	s.mu.Unlock()
	if occupe {
		return errors.New("instantané en cours d'utilisation")
	}
	return p.Detruire(ctx, nom)
}

func (s *Service) occuper(nom string) func() {
	s.mu.Lock()
	s.enCours[nom] = true
	s.mu.Unlock()
	return func() {
		s.mu.Lock()
		delete(s.enCours, nom)
		s.mu.Unlock()
	}
}

// restaurer : instantané de sûreté du node, puis recopie du seul dossier du
// serveur. Le panel ne donne l'ordre qu'une fois Wings l'a rapporté arrêté.
func (s *Service) restaurer(ctx context.Context, p Pilote, r Reglages, o Ordre) (string, error) {
	noms, err := p.Lister(ctx)
	if err != nil {
		return "", err
	}
	if !existe(noms, o.Instantane) {
		return "", errIntrouvable
	}
	libere := s.occuper(o.Instantane)
	defer libere()

	source := filepath.Join(p.Racine(o.Instantane), o.Serveur)
	if info, err := os.Lstat(source); err != nil || !info.IsDir() {
		return "", errors.New("ce serveur n'est pas dans cet instantané")
	}
	vivant := filepath.Join(s.Data, o.Serveur)
	if info, err := os.Lstat(vivant); err != nil || !info.IsDir() {
		return "", errors.New("dossier du serveur introuvable sur ce node")
	}
	surete, err := s.prendre(ctx, p, r)
	if err != nil {
		return "", fmt.Errorf("instantané de sûreté : %w", err)
	}
	s.noter(ctx, journal.Info, "surete_pris", o.Serveur, surete)
	if err := Restaurer(ctx, source, vivant); err != nil {
		return surete, err
	}
	return surete, nil
}

// archiver : sauvegarde S3 cohérente tirée d'un instantané (ADR 0009).
func (s *Service) archiver(ctx context.Context, p Pilote, r Reglages, o Ordre) (string, bool, error) {
	nom, err := s.prendreRegroupe(ctx, p, r)
	if err != nil {
		return "", false, err
	}
	libere := s.occuper(nom)
	defer libere()

	source := filepath.Join(p.Racine(nom), o.Serveur)
	if info, err := os.Lstat(source); err != nil || !info.IsDir() {
		return nom, false, errors.New("ce serveur n'est pas dans l'instantané")
	}
	if err := os.MkdirAll(s.Travail, 0o700); err != nil {
		return nom, false, err
	}
	tmp, err := os.CreateTemp(s.Travail, o.Sauvegarde+"-*.tar.gz")
	if err != nil {
		return nom, false, err
	}
	defer os.Remove(tmp.Name())
	if err := Archiver(ctx, source, o.Exclusions, tmp); err != nil {
		tmp.Close()
		return nom, false, err
	}
	if err := tmp.Close(); err != nil {
		return nom, false, err
	}
	somme, taille, err := Empreinte(tmp.Name())
	if err != nil {
		return nom, false, err
	}

	var liens LiensDepot
	if _, err := s.Panel.Get(ctx, CheminDepot+o.Sauvegarde, url.Values{"size": {strconv.FormatInt(taille, 10)}}, "", &liens); err != nil {
		return nom, false, err
	}
	parties, err := Televerser(ctx, s.S3, tmp.Name(), taille, liens)
	compte := CompteRendu{Checksum: somme, ChecksumType: "sha1", Size: taille, Successful: err == nil, Parts: parties}
	if errCR := s.Panel.Post(ctx, CheminDepot+o.Sauvegarde, compte, nil); errCR != nil && err == nil {
		err = errCR
	}
	return nom, true, err
}

// Rotation et espace --------------------------------------------------------

func (s *Service) tourner(ctx context.Context, p Pilote, r Reglages) {
	noms, err := p.Lister(ctx)
	if err != nil {
		return
	}
	s.mu.Lock()
	gardes, enCours := copier(s.gardes), copier(s.enCours)
	s.mu.Unlock()
	for _, nom := range ADetruire(noms, s.maintenant(), r, gardes, enCours) {
		if err := p.Detruire(ctx, nom); err != nil {
			s.noter(ctx, journal.Erreur, "rotation_echec", "", nom+" : "+err.Error())
			continue
		}
		s.noter(ctx, journal.Info, "rotation", "", nom)
	}
}

// tenirSeuil détruit sous le seuil d'espace libre, les plus anciens non
// gardés d'abord, **un seul par appel** : btrfs et ZFS libèrent l'espace en
// arrière-plan, et mesurer juste après une destruction ferait tout détruire.
// Le relevé suivant (15 s) mesure de nouveau. Rend vrai tant que l'espace
// reste insuffisant.
func (s *Service) tenirSeuil(ctx context.Context, p Pilote, r Reglages) bool {
	e, err := s.mesurer()
	if err != nil || e.PourcentLibre() >= r.SeuilLibrePct {
		return false
	}
	s.noter(ctx, journal.Alerte, "espace_insuffisant", "", fmt.Sprintf("%.1f %% libre, seuil %.0f %%", e.PourcentLibre(), r.SeuilLibrePct))
	noms, err := p.Lister(ctx)
	if err != nil {
		return true
	}
	s.mu.Lock()
	gardes, enCours := copier(s.gardes), copier(s.enCours)
	s.mu.Unlock()
	for _, nom := range OrdreDeSacrifice(noms, gardes, enCours) {
		if err := p.Detruire(ctx, nom); err != nil {
			s.noter(ctx, journal.Erreur, "espace_sacrifice_echec", "", nom+" : "+err.Error())
			continue
		}
		s.noter(ctx, journal.Alerte, "espace_sacrifie", "", nom)
		break
	}
	return true
}

func existe(noms []string, nom string) bool {
	for _, n := range noms {
		if n == nom {
			return true
		}
	}
	return false
}

func copier(m map[string]bool) map[string]bool {
	out := make(map[string]bool, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

var _ Panel = (*panel.Client)(nil)
