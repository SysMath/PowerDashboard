package instantanes

import (
	"sort"
	"time"
)

// Règles de rotation, sans effet de bord : ce qu'il faut prendre, garder et
// sacrifier, calculé à partir des seuls noms (qui portent leur instant).

type pris struct {
	nom string
	t   time.Time
}

func dater(noms []string) []pris {
	out := make([]pris, 0, len(noms))
	for _, n := range noms {
		if t, ok := PrisLe(n); ok {
			out = append(out, pris{n, t})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].t.Before(out[j].t) })
	return out
}

func case_(t time.Time, intervalle time.Duration) int64 {
	return t.UTC().UnixNano() / int64(intervalle)
}

// APrendreAuto dit si un instantané automatique est dû : pour un niveau au
// moins, aucun instantané n'a encore été pris dans la case de temps en cours
// (toutes les heures : dans l'heure pleine en cours). Un seul instantané
// sert tous les niveaux.
func APrendreAuto(noms []string, maintenant time.Time, r Reglages) bool {
	if !r.Actif {
		return false
	}
	liste := dater(noms)
	for _, n := range r.Niveaux {
		c := case_(maintenant, n.Intervalle())
		trouve := false
		for _, p := range liste {
			if case_(p.t, n.Intervalle()) == c {
				trouve = true
				break
			}
		}
		if !trouve {
			return true
		}
	}
	return false
}

// DelaiDeGrace : un instantané tout juste pris (manuel, de sûreté) n'est pas
// encore connu du panel, qui ne peut donc pas encore le garder. La rotation
// ne le touche pas pendant ce délai.
const DelaiDeGrace = time.Hour

// AConserver rend l'ensemble des instantanés que la rotation garde : pour
// chaque niveau, le plus ancien de chaque case dans sa rétention ; plus les
// gardes du panel et ceux de moins d'une heure ; jamais au-delà de la durée
// maximale. Ceux d'un ordre en cours sont toujours gardés.
func AConserver(noms []string, maintenant time.Time, r Reglages, gardes, enCours map[string]bool) map[string]bool {
	garder := map[string]bool{}
	liste := dater(noms)
	for _, n := range r.Niveaux {
		vues := map[int64]bool{}
		for _, p := range liste {
			if maintenant.Sub(p.t) > n.Retention() {
				continue
			}
			c := case_(p.t, n.Intervalle())
			if !vues[c] {
				vues[c] = true
				garder[p.nom] = true
			}
		}
	}
	for _, p := range liste {
		if gardes[p.nom] || maintenant.Sub(p.t) < DelaiDeGrace {
			garder[p.nom] = true
		}
		if maintenant.Sub(p.t) > r.DureeMax() {
			delete(garder, p.nom)
		}
		if enCours[p.nom] {
			garder[p.nom] = true
		}
	}
	return garder
}

// ADetruire rend, du plus ancien au plus récent, ce que la rotation ne garde
// pas.
func ADetruire(noms []string, maintenant time.Time, r Reglages, gardes, enCours map[string]bool) []string {
	garder := AConserver(noms, maintenant, r, gardes, enCours)
	var out []string
	for _, p := range dater(noms) {
		if !garder[p.nom] {
			out = append(out, p.nom)
		}
	}
	return out
}

// OrdreDeSacrifice rend l'ordre dans lequel détruire sous le seuil d'espace
// libre : d'abord les plus anciens non gardés par le panel, puis les gardés
// les plus anciens. Jamais ceux d'un ordre en cours.
func OrdreDeSacrifice(noms []string, gardes, enCours map[string]bool) []string {
	var libres, gardesListe []string
	for _, p := range dater(noms) {
		switch {
		case enCours[p.nom]:
		case gardes[p.nom]:
			gardesListe = append(gardesListe, p.nom)
		default:
			libres = append(libres, p.nom)
		}
	}
	return append(libres, gardesListe...)
}

// Reutilisable rend le plus récent instantané pris dans la fenêtre de
// regroupement, s'il y en a un.
func Reutilisable(noms []string, maintenant time.Time, fenetre time.Duration) (string, bool) {
	if fenetre <= 0 {
		return "", false
	}
	liste := dater(noms)
	for i := len(liste) - 1; i >= 0; i-- {
		age := maintenant.Sub(liste[i].t)
		if age >= 0 && age <= fenetre {
			return liste[i].nom, true
		}
	}
	return "", false
}
