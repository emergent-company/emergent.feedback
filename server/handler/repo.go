package handler

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/emergent-company/emergent.feedback/server/github"
	"github.com/emergent-company/emergent.feedback/server/middleware"
	"github.com/labstack/echo/v4"
)

// tokenEncryptKey derives an AES-256 key from the JWT secret (domain-separated).
func tokenEncryptKey(jwtSecret string) []byte {
	// Retained for data compatibility: this salt must stay stable so previously
	// stored GitHub tokens continue to decrypt. Not a display name.
	sum := sha256.Sum256([]byte("feedback-overlay:token:" + jwtSecret))
	return sum[:]
}

func encryptToken(plain, jwtSecret string) ([]byte, error) {
	block, err := aes.NewCipher(tokenEncryptKey(jwtSecret))
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return gcm.Seal(nonce, nonce, []byte(plain), nil), nil
}

func decryptToken(encrypted []byte, jwtSecret string) (string, error) {
	block, err := aes.NewCipher(tokenEncryptKey(jwtSecret))
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	ns := gcm.NonceSize()
	if len(encrypted) < ns {
		return "", errors.New("token ciphertext too short")
	}
	plain, err := gcm.Open(nil, encrypted[:ns], encrypted[ns:], nil)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

// userToken returns the authenticated user's decrypted GitHub access token.
func (h *Handler) userToken(c echo.Context) (string, error) {
	login := middleware.GetLogin(c)
	enc, err := h.Store.GetUserToken(c.Request().Context(), login)
	if err != nil {
		return "", echo.NewHTTPError(http.StatusUnauthorized, "no GitHub token stored; please log in again")
	}
	token, err := decryptToken(enc, h.JWTSecret)
	if err != nil {
		return "", echo.NewHTTPError(http.StatusUnauthorized, "failed to decrypt GitHub token")
	}
	return token, nil
}

// userTokenFor returns the decrypted GitHub token stored for login, if any.
func (h *Handler) userTokenFor(ctx context.Context, login string) (string, error) {
	enc, err := h.Store.GetUserToken(ctx, login)
	if err != nil {
		return "", err
	}
	return decryptToken(enc, h.JWTSecret)
}

// gitHubAuthExpired reports whether err is a GitHub auth failure (HTTP 401),
// meaning the stored OAuth token is no longer accepted and the user must
// re-authenticate. It deliberately ignores 403 so a rate limit or a permissions
// gap does not sign the user out in a loop.
func gitHubAuthExpired(err error) bool {
	var apiErr *github.APIError
	return errors.As(err, &apiErr) && apiErr.Status == http.StatusUnauthorized
}

// repoListError maps a GitHub repo-listing failure to an HTTP error. An auth
// failure becomes 401 so the panel signs the user out and prompts a fresh
// GitHub login; anything else is a 502 upstream error.
func repoListError(err error) error {
	if gitHubAuthExpired(err) {
		return echo.NewHTTPError(http.StatusUnauthorized, "GitHub authorization expired. Sign in again to continue.")
	}
	return echo.NewHTTPError(http.StatusBadGateway, "failed to list repos")
}

// userRepos returns the authenticated user's GitHub repos (full_name list).
func (h *Handler) userRepos(c echo.Context) ([]string, error) {
	token, err := h.userToken(c)
	if err != nil {
		return nil, err
	}
	repos, err := github.ListUserRepos(c.Request().Context(), token)
	if err != nil {
		return nil, repoListError(err)
	}
	names := make([]string, 0, len(repos))
	for _, r := range repos {
		names = append(names, r.FullName)
	}
	return names, nil
}

// HandleListRepos handles GET /api/repos — lists the user's GitHub repos.
func (h *Handler) HandleListRepos(c echo.Context) error {
	token, err := h.userToken(c)
	if err != nil {
		return err
	}
	repos, err := github.ListUserRepos(c.Request().Context(), token)
	if err != nil {
		return repoListError(err)
	}
	return c.JSON(http.StatusOK, repos)
}

// callerCanAccessRepo probes whether the caller's token can access repo
// ("owner/name") directly, rather than via list membership. A userToken error
// (echo 401) is propagated as-is.
func (h *Handler) callerCanAccessRepo(c echo.Context, repo string) (bool, error) {
	token, err := h.userToken(c)
	if err != nil {
		return false, err
	}
	return github.RepoAccessible(c.Request().Context(), token, repo)
}

// repoAccessError maps a repo-access-probe error to an HTTP error. An echo 401
// (missing token) passes through unchanged; a GitHub API 401 becomes a 401 so
// the panel re-signs-in the user; anything else is a 502 upstream error.
func (h *Handler) repoAccessError(err error) error {
	var he *echo.HTTPError
	if errors.As(err, &he) && he.Code == http.StatusUnauthorized {
		return he
	}
	if gitHubAuthExpired(err) {
		return echo.NewHTTPError(http.StatusUnauthorized, "GitHub authorization expired. Sign in again to continue.")
	}
	return echo.NewHTTPError(http.StatusBadGateway, "failed to verify repository access")
}

// repoAccessDenied returns the 403 for a repo the caller's token cannot access:
// a structured app_access_required body when a grant URL can be built, else the
// plain fail-closed message.
func (h *Handler) repoAccessDenied(c echo.Context, repo string) error {
	if authorizeURL := h.repoAccessGuidance(c, repo); authorizeURL != "" {
		return echo.NewHTTPError(http.StatusForbidden, map[string]any{
			"error":         "app_access_required",
			"message":       fmt.Sprintf("The feedback app does not have access to %s. Grant access in GitHub, then try again.", repo),
			"repo":          repo,
			"authorize_url": authorizeURL,
		})
	}
	return echo.NewHTTPError(http.StatusForbidden, "repo not in scope")
}

// repoAccessGuidance builds a URL the user can follow to grant the feedback app
// access to repo ("owner/name"), or "" when none can be built. Preference order:
// the matching installation's HTMLURL, that installation's AppSlug install URL,
// any installation's AppSlug install URL, then the configured AppSlug.
func (h *Handler) repoAccessGuidance(c echo.Context, repo string) string {
	token, err := h.userToken(c)
	if err != nil {
		return ""
	}
	owner := repo
	if i := strings.IndexByte(repo, '/'); i >= 0 {
		owner = repo[:i]
	}
	installs, err := github.ListUserInstallations(c.Request().Context(), token)
	if err != nil {
		return ""
	}

	var matched *github.Installation
	for i := range installs {
		if strings.EqualFold(installs[i].Account.Login, owner) {
			matched = &installs[i]
			break
		}
	}
	if matched != nil {
		if matched.HTMLURL != "" {
			return matched.HTMLURL
		}
		if matched.AppSlug != "" {
			return fmt.Sprintf("https://github.com/apps/%s/installations/new", matched.AppSlug)
		}
	}
	// No install for this owner: fall back to any installation's AppSlug.
	for i := range installs {
		if installs[i].AppSlug != "" {
			return fmt.Sprintf("https://github.com/apps/%s/installations/new", installs[i].AppSlug)
		}
	}
	if h.GHConfig.AppSlug != "" {
		return fmt.Sprintf("https://github.com/apps/%s/installations/new", h.GHConfig.AppSlug)
	}
	return ""
}
