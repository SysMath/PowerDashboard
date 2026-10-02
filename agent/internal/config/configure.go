package config

import (
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

// Configuration est la réponse du panel à `gamedashboard-agent configure`,
// sans enveloppe, comme celle que lit `wings configure`.
type Configuration struct {
	UUID    string `json:"uuid"`
	TokenID string `json:"token_id"`
	Token   string `json:"token"`
	Remote  string `json:"remote"`
}

// CheminConfiguration suit `wings configure` : même préfixe
// /api/application (déjà routé par le vhost et le relais cPanel), même portée
// `nodes.configure`, réservée à la plateforme.
func CheminConfiguration(node string) string {
	return "/api/application/nodes/" + url.PathEscape(node) + "/agent-configuration"
}

// Telecharger va chercher la configuration du node avec une clé applicative
// de courte durée, pour que personne ne recopie de jeton à la main.
func Telecharger(ctx context.Context, panelURL, cle, node string) (Configuration, error) {
	var c Configuration
	if err := ValiderRemote(panelURL); err != nil {
		return c, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimSuffix(panelURL, "/")+CheminConfiguration(node), nil)
	if err != nil {
		return c, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+cle)
	client := &http.Client{
		Timeout: 30 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	res, err := client.Do(req)
	if err != nil {
		return c, err
	}
	defer res.Body.Close()
	switch {
	case res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden:
		return c, fmt.Errorf("le panel refuse la clé (HTTP %d) : clé expirée, déjà utilisée ou sans la portée nodes.configure", res.StatusCode)
	case res.StatusCode == http.StatusNotFound:
		return c, errors.New("node inconnu du panel, ou panel sans agent de node")
	case res.StatusCode != http.StatusOK:
		return c, fmt.Errorf("le panel répond HTTP %d", res.StatusCode)
	}
	brut, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return c, err
	}
	if err := json.Unmarshal(brut, &c); err != nil {
		return c, fmt.Errorf("réponse du panel illisible : %w", err)
	}
	return c, nil
}

// Appliquer fusionne la configuration reçue dans `base` (défauts ou fichier
// existant). Si Wings est déjà configuré sur la machine, son uuid et son
// remote doivent être les mêmes : un node ne sert pas deux panels.
func Appliquer(base Config, recu Configuration, uuidWings, remoteWings string) (Config, error) {
	if uuidWings != "" && uuidWings != recu.UUID {
		return base, fmt.Errorf("Wings sert le node %s, le panel a répondu pour %s", uuidWings, recu.UUID)
	}
	if remoteWings != "" && strings.TrimSuffix(remoteWings, "/") != strings.TrimSuffix(recu.Remote, "/") {
		return base, fmt.Errorf("Wings parle à %s, le panel se présente comme %s", remoteWings, recu.Remote)
	}
	base.UUID, base.TokenID, base.Token, base.Remote = recu.UUID, recu.TokenID, recu.Token, strings.TrimSuffix(recu.Remote, "/")
	return base, base.Valider()
}
