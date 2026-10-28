package memory

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// Metadata is the subset of RFC 8414 authorization-server metadata that the
// feedback connect flow needs.
type Metadata struct {
	Issuer                string `json:"issuer"`
	AuthorizationEndpoint string `json:"authorization_endpoint"`
	TokenEndpoint         string `json:"token_endpoint"`
	RegistrationEndpoint  string `json:"registration_endpoint"`
	RevocationEndpoint    string `json:"revocation_endpoint"`
}

// Discover fetches the Memory authorization-server metadata. If the server
// does not advertise it, the caller can fall back to conventional paths.
func Discover(ctx context.Context, baseURL string, httpClient *http.Client) (Metadata, error) {
	var md Metadata
	u := strings.TrimRight(baseURL, "/") + "/.well-known/oauth-authorization-server"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return md, err
	}
	req.Header.Set("Accept", "application/json")
	if httpClient == nil {
		httpClient = SafeHTTPClient(false)
	}
	res, err := httpClient.Do(req)
	if err != nil {
		return md, fmt.Errorf("memory: discover authorization server: %w", err)
	}
	defer func() { _ = res.Body.Close() }()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return md, &APIError{Status: res.StatusCode, Body: string(raw), Message: "authorization server metadata unavailable"}
	}
	if err := json.Unmarshal(raw, &md); err != nil {
		return md, fmt.Errorf("memory: decode authorization server metadata: %w", err)
	}
	return md, nil
}

// RegisterClient performs RFC 7591 dynamic client registration and returns the
// public client_id. No client secret is used (token_endpoint_auth_method=none).
func RegisterClient(ctx context.Context, registrationEndpoint, clientName string, redirectURIs []string, scope string, httpClient *http.Client) (string, error) {
	body := map[string]any{
		"client_name":                clientName,
		"redirect_uris":              redirectURIs,
		"grant_types":                []string{"authorization_code"},
		"response_types":             []string{"code"},
		"token_endpoint_auth_method": "none",
	}
	if scope != "" {
		body["scope"] = scope
	}
	b, err := json.Marshal(body)
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, registrationEndpoint, strings.NewReader(string(b)))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if httpClient == nil {
		httpClient = SafeHTTPClient(false)
	}
	res, err := httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("memory: register client: %w", err)
	}
	defer func() { _ = res.Body.Close() }()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		apiErr := &APIError{Status: res.StatusCode, Body: string(raw)}
		var parsed struct {
			Error       string `json:"error"`
			Description string `json:"error_description"`
			Message     string `json:"message"`
		}
		if json.Unmarshal(raw, &parsed) == nil {
			apiErr.Message = parsed.Description
			if apiErr.Message == "" {
				apiErr.Message = parsed.Message
			}
			if apiErr.Message == "" {
				apiErr.Message = parsed.Error
			}
		}
		return "", apiErr
	}
	var out struct {
		ClientID string `json:"client_id"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", fmt.Errorf("memory: decode registration response: %w", err)
	}
	if out.ClientID == "" {
		return "", fmt.Errorf("memory: registration response did not include client_id")
	}
	return out.ClientID, nil
}

// TokenResponse is the response from POST /api/oauth/token.
type TokenResponse struct {
	AccessToken string `json:"access_token"`
	TokenType   string `json:"token_type"`
	Scope       string `json:"scope"`
	ProjectID   string `json:"project_id"`
	ProjectName string `json:"project_name"`
}

// ExchangeCode redeems an authorization code with a PKCE verifier.
func ExchangeCode(ctx context.Context, tokenEndpoint, clientID, code, redirectURI, verifier string, httpClient *http.Client) (TokenResponse, error) {
	var out TokenResponse
	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("client_id", clientID)
	form.Set("code", code)
	form.Set("redirect_uri", redirectURI)
	form.Set("code_verifier", verifier)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenEndpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return out, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	if httpClient == nil {
		httpClient = SafeHTTPClient(false)
	}
	res, err := httpClient.Do(req)
	if err != nil {
		return out, fmt.Errorf("memory: exchange code: %w", err)
	}
	defer func() { _ = res.Body.Close() }()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		apiErr := &APIError{Status: res.StatusCode, Body: string(raw)}
		var parsed struct {
			Error       string `json:"error"`
			Description string `json:"error_description"`
		}
		if json.Unmarshal(raw, &parsed) == nil {
			apiErr.Message = parsed.Description
			if apiErr.Message == "" {
				apiErr.Message = parsed.Error
			}
		}
		return out, apiErr
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return out, fmt.Errorf("memory: decode token response: %w", err)
	}
	if out.AccessToken == "" {
		return out, fmt.Errorf("memory: token response did not include access_token")
	}
	return out, nil
}

// RevokeToken attempts RFC 7009 revocation. It is best-effort: the local
// destination is removed regardless of the result.
func RevokeToken(ctx context.Context, revocationEndpoint, clientID, token string, httpClient *http.Client) error {
	if revocationEndpoint == "" {
		return nil
	}
	form := url.Values{}
	form.Set("token", token)
	if clientID != "" {
		form.Set("client_id", clientID)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, revocationEndpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if httpClient == nil {
		httpClient = SafeHTTPClient(false)
	}
	res, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return &APIError{Status: res.StatusCode}
	}
	return nil
}
