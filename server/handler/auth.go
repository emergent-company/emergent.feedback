package handler

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/emergent-company/emergent.feedback/server/github"
	"github.com/emergent-company/emergent.feedback/server/middleware"
	"github.com/labstack/echo/v4"
)

const oauthStateTTL = 10 * time.Minute

// generateState returns a self-contained, HMAC-signed OAuth state token that
// embeds an expiry timestamp and the opener origin. It needs no server-side
// storage, so it works across replicas and survives restarts.
func (h *Handler) generateState(origin string) string {
	payload := strconv.FormatInt(time.Now().Add(oauthStateTTL).Unix(), 10)
	if origin != "" {
		payload += ":" + base64.RawURLEncoding.EncodeToString([]byte(origin))
	}
	return payload + "." + signState(payload, h.JWTSecret)
}

// validateState verifies the signature and expiry of an OAuth state token and
// returns the embedded opener origin (empty when none was provided).
func (h *Handler) validateState(s string) (string, bool) {
	payload, sig, ok := strings.Cut(s, ".")
	if !ok {
		return "", false
	}
	if !hmac.Equal([]byte(sig), []byte(signState(payload, h.JWTSecret))) {
		return "", false
	}
	expStr, originEnc, hasOrigin := strings.Cut(payload, ":")
	exp, err := strconv.ParseInt(expStr, 10, 64)
	if err != nil {
		return "", false
	}
	if time.Now().Unix() > exp {
		return "", false
	}
	origin := ""
	if hasOrigin {
		if b, err := base64.RawURLEncoding.DecodeString(originEnc); err == nil {
			origin = string(b)
		}
	}
	return origin, true
}

func signState(payload, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(payload))
	return hex.EncodeToString(mac.Sum(nil))
}

// HandleGitHubLogin redirects the user to the GitHub App OAuth authorization page.
// The opener origin is threaded through the signed state so the callback can
// target postMessage at it instead of "*".
func (h *Handler) HandleGitHubLogin(c echo.Context) error {
	origin := c.QueryParam("origin")
	return c.Redirect(http.StatusTemporaryRedirect, h.GHConfig.AuthCodeURL(h.generateState(origin)))
}

// HandleGitHubCallback handles the OAuth callback from GitHub App.
// It exchanges the code for a user access token, fetches the user profile,
// issues a session JWT, and closes the popup.
func (h *Handler) HandleGitHubCallback(c echo.Context) error {
	state := c.QueryParam("state")
	origin, ok := h.validateState(state)
	if !ok {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid or expired OAuth state")
	}

	code := c.QueryParam("code")
	if code == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "missing code parameter")
	}

	userToken, err := h.GHConfig.ExchangeCode(c.Request().Context(), code)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to exchange OAuth code")
	}

	user, err := github.GetUser(c.Request().Context(), userToken)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to fetch GitHub user")
	}

	// Persist the user's GitHub token (encrypted) so /api/repos can list
	// their repositories later.
	if enc, err := encryptToken(userToken, h.JWTSecret); err == nil {
		if err := h.Store.UpsertUserToken(c.Request().Context(), user.Login, enc); err != nil {
			c.Logger().Errorf("store user token: %v", err)
		}
	}

	// The JWT only carries identity — no GitHub token stored in it.
	// Issue creation uses a server-side installation token instead.
	jwtToken, err := middleware.IssueToken(h.JWTSecret, user.Login, user.AvatarURL)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to issue session token")
	}

	targetOrigin := origin
	if targetOrigin == "" {
		targetOrigin = "*"
	}
	tokJSON, _ := json.Marshal(jwtToken)
	loginJSON, _ := json.Marshal(user.Login)
	avatarJSON, _ := json.Marshal(user.AvatarURL)
	targetJSON, _ := json.Marshal(targetOrigin)
	html := `<!DOCTYPE html><html><body><script>
if(window.opener){
  window.opener.postMessage({type:'emergent_feedback_auth',token:` + string(tokJSON) + `,login:` + string(loginJSON) + `,avatar:` + string(avatarJSON) + `},` + string(targetJSON) + `);
  window.close();
}else{
  document.cookie = "ef_panel_token=" + encodeURIComponent(` + string(tokJSON) + `) + "; path=/; samesite=lax; max-age=120";
  window.location.replace("/panel");
}
</script></body></html>`

	return c.HTML(http.StatusOK, html)
}

// HandleMe returns the authenticated user's profile.
func (h *Handler) HandleMe(c echo.Context) error {
	avatar, _ := c.Get("avatar_url").(string)
	return c.JSON(http.StatusOK, map[string]string{
		"login":      middleware.GetLogin(c),
		"avatar_url": avatar,
	})
}
