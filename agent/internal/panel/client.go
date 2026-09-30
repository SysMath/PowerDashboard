// Package panel parle au panel, dans un seul sens : l'agent appelle, le panel
// répond. Le panel n'appelle jamais l'agent (ADR 0008), qui n'écoute rien.
//
// L'authentification est celle de Wings : `Authorization: Bearer
// <token_id>.<token>`, vérifiée côté panel par la même garde (recherche par
// identifiant, comparaison à durée constante).
package panel

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Une réponse du panel à l'agent tient en quelques kilo-octets ; au-delà, on
// refuse plutôt que de charger n'importe quoi en mémoire.
const TailleMaxReponse = 4 << 20

// Préfixe de toutes les routes de l'agent sur le panel (vhost et relais
// cPanel : ADR 0008).
const Prefixe = "/api/node-agent"

type Client struct {
	remote  string
	tokenID string
	token   string
	version string
	http    *http.Client
}

func Nouveau(remote, tokenID, token, version string, delai time.Duration) *Client {
	return &Client{
		remote:  strings.TrimSuffix(remote, "/"),
		tokenID: tokenID,
		token:   token,
		version: version,
		http: &http.Client{
			Timeout: delai,
			// Une redirection emporterait le jeton ailleurs, ou signale un
			// panel mal configuré (page de connexion) : on s'arrête là.
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}
}

// ErreurHTTP porte le statut d'une réponse refusée, sans son corps (qui peut
// venir d'un relais et n'a rien à faire dans les journaux).
type ErreurHTTP struct {
	Methode, Chemin string
	Statut          int
}

func (e *ErreurHTTP) Error() string {
	return fmt.Sprintf("panel : %s %s → HTTP %d", e.Methode, e.Chemin, e.Statut)
}

// NonModifie signale une réponse 304 à un relevé conditionnel.
var NonModifie = errors.New("panel : non modifié")

// Get lit une réponse JSON. `etag` non vide ajoute If-None-Match ; le nouvel
// ETag est rendu.
func (c *Client) Get(ctx context.Context, chemin string, requete url.Values, etag string, dest any) (string, error) {
	if len(requete) > 0 {
		chemin += "?" + requete.Encode()
	}
	req, err := c.requete(ctx, http.MethodGet, chemin, nil)
	if err != nil {
		return "", err
	}
	if etag != "" {
		req.Header.Set("If-None-Match", etag)
	}
	return c.faire(req, chemin, dest)
}

// Post envoie un corps JSON et lit la réponse JSON (dest peut être nil).
func (c *Client) Post(ctx context.Context, chemin string, corps, dest any) error {
	brut, err := json.Marshal(corps)
	if err != nil {
		return err
	}
	req, err := c.requete(ctx, http.MethodPost, chemin, bytes.NewReader(brut))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	_, err = c.faire(req, chemin, dest)
	return err
}

func (c *Client) requete(ctx context.Context, methode, chemin string, corps io.Reader) (*http.Request, error) {
	if !strings.HasPrefix(chemin, Prefixe+"/") {
		return nil, fmt.Errorf("panel : chemin hors de %s : %s", Prefixe, chemin)
	}
	req, err := http.NewRequestWithContext(ctx, methode, c.remote+chemin, corps)
	if err != nil {
		return nil, err
	}
	// Les mêmes en-têtes que Wings (remote/http.go), à l'agent près.
	req.Header.Set("User-Agent", fmt.Sprintf("GameDashboard Agent/v%s (id:%s)", c.version, c.tokenID))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s.%s", c.tokenID, c.token))
	return req, nil
}

func (c *Client) faire(req *http.Request, chemin string, dest any) (string, error) {
	res, err := c.http.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNotModified {
		return res.Header.Get("ETag"), NonModifie
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, TailleMaxReponse))
		return "", &ErreurHTTP{Methode: req.Method, Chemin: chemin, Statut: res.StatusCode}
	}
	if dest == nil || res.StatusCode == http.StatusNoContent {
		return res.Header.Get("ETag"), nil
	}
	lu, err := io.ReadAll(io.LimitReader(res.Body, TailleMaxReponse+1))
	if err != nil {
		return "", err
	}
	if len(lu) > TailleMaxReponse {
		return "", fmt.Errorf("panel : réponse de %s trop volumineuse", chemin)
	}
	if err := json.Unmarshal(lu, dest); err != nil {
		return "", fmt.Errorf("panel : réponse illisible de %s : %w", chemin, err)
	}
	return res.Header.Get("ETag"), nil
}
