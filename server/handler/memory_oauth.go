package handler

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/emergent-company/emergent.feedback/server/memory"
	"github.com/emergent-company/emergent.feedback/server/middleware"
	"github.com/emergent-company/emergent.feedback/server/store"
	"github.com/labstack/echo/v4"
)

type memoryOAuthStartRequest struct {
	Repo    string `json:"repo"`
	BaseURL string `json:"base_url"`
}

func randomURLToken(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func pkceChallenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func memoryOAuthMetadata(ctx context.Context, base string, httpClient *http.Client) memory.Metadata {
	meta, err := memory.Discover(ctx, base, httpClient)
	if err != nil {
		return memory.Metadata{}
	}
	return meta
}

func memoryEndpoint(meta memory.Metadata, field, base, fallback string) string {
	var v string
	switch field {
	case "authorize":
		v = meta.AuthorizationEndpoint
	case "token":
		v = meta.TokenEndpoint
	case "register":
		v = meta.RegistrationEndpoint
	case "revoke":
		v = meta.RevocationEndpoint
	}
	if strings.TrimSpace(v) != "" {
		// Metadata is supplied by the Memory server. Never hand a non-http(s)
		// endpoint to the browser (e.g. javascript:) or the HTTP client.
		if u, err := url.Parse(v); err == nil && u.Host != "" && (u.Scheme == "http" || u.Scheme == "https") {
			return v
		}
	}
	return strings.TrimRight(base, "/") + fallback
}

// HandleMemoryOAuthStart begins the OAuth connect flow. It is an authenticated
// JSON endpoint (the panel calls it with its bearer token), registers a public
// client with Memory if needed, and returns the browser authorize URL.
//
// POST /api/memory/oauth/start
func (h *Handler) HandleMemoryOAuthStart(c echo.Context) error {
	var req memoryOAuthStartRequest
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request body")
	}
	req.Repo = strings.TrimSpace(req.Repo)
	if req.Repo == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "repo is required")
	}
	base, err := normalizeMemoryBaseURL(req.BaseURL)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, err.Error())
	}
	ok, err := h.callerCanAccessRepo(c, req.Repo)
	if err != nil {
		return h.repoAccessError(err)
	}
	if !ok {
		return echo.NewHTTPError(http.StatusForbidden, "you do not have access to this repository")
	}

	ctx, cancel := context.WithTimeout(c.Request().Context(), 20*time.Second)
	defer cancel()
	meta := memoryOAuthMetadata(ctx, base, h.MemoryHTTP)

	feedbackBase := h.publicBaseURL(c)
	redirectURI := feedbackBase + "/oauth/memory/callback"

	client, err := h.Store.GetMemoryOAuthClient(ctx, base)
	if err != nil || client.RedirectURI != redirectURI {
		regEndpoint := memoryEndpoint(meta, "register", base, "/api/oauth/register")
		clientID, rerr := memory.RegisterClient(ctx, regEndpoint, "emergent.feedback", []string{redirectURI}, memoryScopeString, h.MemoryHTTP)
		if rerr != nil {
			var apiErr *memory.APIError
			if errors.As(rerr, &apiErr) && (apiErr.Status == http.StatusForbidden || apiErr.Status == http.StatusNotFound) {
				return echo.NewHTTPError(http.StatusBadGateway, "Memory has not enabled app connections. Paste a project token instead.")
			}
			return echo.NewHTTPError(http.StatusBadGateway, "could not register with Memory: "+memoryErrorMessage(rerr))
		}
		client = store.MemoryOAuthClient{BaseURL: base, ClientID: clientID, RedirectURI: redirectURI}
		if err := h.Store.UpsertMemoryOAuthClient(ctx, client); err != nil {
			return echo.NewHTTPError(http.StatusInternalServerError, "failed to save the Memory client registration")
		}
	}

	state, err := randomURLToken(32)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to create OAuth state")
	}
	verifier, err := randomURLToken(48)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to create PKCE verifier")
	}
	st := store.MemoryOAuthState{
		State:           state,
		Repo:            req.Repo,
		GitHubUser:      middleware.GetLogin(c),
		BaseURL:         base,
		Verifier:        verifier,
		RedirectURI:     redirectURI,
		FeedbackBaseURL: feedbackBase,
		ExpiresAt:       time.Now().UTC().Add(10 * time.Minute),
	}
	if err := h.Store.CreateMemoryOAuthState(ctx, st); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to save OAuth state")
	}

	authorizeEndpoint := memoryEndpoint(meta, "authorize", base, "/oauth/authorize")
	u, err := url.Parse(authorizeEndpoint)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadGateway, "Memory returned an invalid authorization endpoint")
	}
	q := u.Query()
	q.Set("response_type", "code")
	q.Set("client_id", client.ClientID)
	q.Set("redirect_uri", redirectURI)
	q.Set("scope", memoryScopeString)
	q.Set("state", state)
	q.Set("code_challenge", pkceChallenge(verifier))
	q.Set("code_challenge_method", "S256")
	u.RawQuery = q.Encode()

	return c.JSON(http.StatusOK, map[string]any{
		"authorize_url": u.String(),
		"repo":          req.Repo,
	})
}

// HandleMemoryOAuthCallback completes the connect flow. It is public because
// the browser arrives here from Memory; the single-use state row is the
// credential, and PKCE protects the code exchange.
//
// GET /oauth/memory/callback?code=…&state=…
func (h *Handler) HandleMemoryOAuthCallback(c echo.Context) error {
	if oauthErr := c.QueryParam("error"); oauthErr != "" {
		msg := c.QueryParam("error_description")
		if msg == "" {
			msg = oauthErr
		}
		return memoryOAuthRedirectError(c, msg)
	}
	state := c.QueryParam("state")
	code := c.QueryParam("code")
	if state == "" || code == "" {
		return memoryOAuthRedirectError(c, "Memory did not return an authorization code.")
	}

	ctx, cancel := context.WithTimeout(c.Request().Context(), 25*time.Second)
	defer cancel()
	st, err := h.Store.ConsumeMemoryOAuthState(ctx, state)
	if err != nil {
		if errors.Is(err, store.ErrMemoryOAuthStateNotFound) {
			return memoryOAuthRedirectError(c, "The connection request expired. Try again.")
		}
		return memoryOAuthRedirectError(c, "Could not complete the connection.")
	}

	client, err := h.Store.GetMemoryOAuthClient(ctx, st.BaseURL)
	if err != nil {
		return memoryOAuthRedirectError(c, "The Memory client registration is missing. Try connecting again.")
	}
	meta := memoryOAuthMetadata(ctx, st.BaseURL, h.MemoryHTTP)
	tokenEndpoint := memoryEndpoint(meta, "token", st.BaseURL, "/api/oauth/token")

	// The token request must repeat the redirect_uri used at authorization
	// time, which is the one captured in the state. The client row can have
	// been re-registered for a different deployment between start and callback.
	token, err := memory.ExchangeCode(ctx, tokenEndpoint, client.ClientID, code, st.RedirectURI, st.Verifier, h.MemoryHTTP)
	if err != nil {
		return memoryOAuthRedirectError(c, "Memory rejected the authorization code: "+memoryErrorMessage(err))
	}
	if !strings.HasPrefix(token.AccessToken, "emt_") {
		return memoryOAuthRedirectError(c, "Memory returned an unexpected token type.")
	}
	if token.ProjectID == "" {
		return memoryOAuthRedirectError(c, "Memory did not return a project id.")
	}

	enc, err := encryptToken(token.AccessToken, h.JWTSecret)
	if err != nil {
		return memoryOAuthRedirectError(c, "Could not store the Memory token.")
	}
	mode := memoryModeAsk
	if existing, gerr := h.Store.GetMemoryDestination(ctx, st.Repo); gerr == nil && existing.Mode != "" {
		mode = existing.Mode
	}
	projectName := token.ProjectName
	if projectName == "" {
		projectName = "Memory project"
	}
	d := store.MemoryDestination{
		Repo:            st.Repo,
		BaseURL:         st.BaseURL,
		ProjectID:       token.ProjectID,
		ProjectName:     projectName,
		ClientID:        client.ClientID,
		TokenEncrypted:  enc,
		Scopes:          token.Scope,
		Mode:            mode,
		FeedbackBaseURL: st.FeedbackBaseURL,
		CreatedBy:       st.GitHubUser,
	}
	if d.CreatedBy == "" {
		d.CreatedBy = middleware.GetLogin(c)
	}
	if err := h.Store.UpsertMemoryDestination(ctx, d); err != nil {
		return memoryOAuthRedirectError(c, "Could not save the Memory destination.")
	}
	return c.Redirect(http.StatusFound, "/panel/destinations?connected="+url.QueryEscape(st.Repo))
}

func memoryOAuthRedirectError(c echo.Context, msg string) error {
	return c.Redirect(http.StatusFound, "/panel/destinations?memory_error="+url.QueryEscape(msg))
}

// revokeMemoryToken asks Memory to revoke the project token. Best-effort:
// disconnecting locally must always succeed.
func (h *Handler) revokeMemoryToken(ctx context.Context, d store.MemoryDestination) {
	if d.ClientID == "" {
		return
	}
	token, err := decryptToken(d.TokenEncrypted, h.JWTSecret)
	if err != nil {
		return
	}
	meta := memoryOAuthMetadata(ctx, d.BaseURL, h.MemoryHTTP)
	endpoint := memoryEndpoint(meta, "revoke", d.BaseURL, "/api/oauth/revoke")
	if err := memory.RevokeToken(ctx, endpoint, d.ClientID, token, h.MemoryHTTP); err != nil {
		// Log at most a short message; never the token.
		fmt.Printf("memory: revoke token for %s failed: %v\n", d.Repo, err)
	}
}
