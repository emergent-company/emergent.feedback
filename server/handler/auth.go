package handler

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"html"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/emergent-company/emergent.feedback/server/github"
	"github.com/emergent-company/emergent.feedback/server/middleware"
	"github.com/labstack/echo/v4"
)

const oauthStateTTL = 30 * time.Minute

// stateReason classifies why an OAuth state token failed validation. An empty
// value means the state was valid.
type stateReason string

const (
	stateValid     stateReason = ""
	stateMissing   stateReason = "missing"
	stateMalformed stateReason = "malformed"
	stateBadSig    stateReason = "bad_signature"
	stateExpired   stateReason = "expired"
)

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
// returns the embedded opener origin together with a reason. The origin is
// populated only when the signature was valid (including for an expired token),
// since a signature-valid token is the only trustable source of an origin.
func (h *Handler) validateState(s string) (origin string, reason stateReason) {
	if s == "" {
		return "", stateMissing
	}
	payload, sig, ok := strings.Cut(s, ".")
	if !ok {
		return "", stateMalformed
	}
	if !hmac.Equal([]byte(sig), []byte(signState(payload, h.JWTSecret))) {
		return "", stateBadSig
	}
	expStr, originEnc, hasOrigin := strings.Cut(payload, ":")
	exp, err := strconv.ParseInt(expStr, 10, 64)
	if err != nil {
		return "", stateMalformed
	}
	if hasOrigin {
		if b, err := base64.RawURLEncoding.DecodeString(originEnc); err == nil {
			origin = string(b)
		}
	}
	if time.Now().Unix() > exp {
		return origin, stateExpired
	}
	return origin, stateValid
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
	installationID := c.QueryParam("installation_id")
	setupAction := c.QueryParam("setup_action")
	hasSetupParams := installationID != "" || setupAction != ""

	origin, reason := h.validateState(state)

	if reason != stateValid {
		// Never log the state value or any token — only the failure reason and
		// enough request context to diagnose setup-redirect vs. genuine failures.
		c.Logger().Warnf("oauth state invalid: reason=%s host=%s installation_id=%t setup_action=%t",
			reason, c.Request().Host, installationID != "", setupAction != "")

		// GitHub App install/setup redirects arrive without a state. Treat them as
		// an informational setup confirmation, not an OAuth failure.
		if hasSetupParams {
			return h.renderSetup(c, installationID, setupAction)
		}
		return h.renderStateError(c, reason, origin)
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

// HandleGitHubSetup serves the same informational setup-confirmation page as the
// callback path, so a GitHub App Setup URL can point at /auth/setup directly.
func (h *Handler) HandleGitHubSetup(c echo.Context) error {
	return h.renderSetup(c, c.QueryParam("installation_id"), c.QueryParam("setup_action"))
}

// renderSetup renders the "App access updated" confirmation page for a GitHub App
// install/setup redirect. It never issues a session token and never touches state.
func (h *Handler) renderSetup(c echo.Context, installationID, setupAction string) error {
	instJSON, _ := json.Marshal(installationID)
	actJSON, _ := json.Marshal(setupAction)
	page := `<!DOCTYPE html><html><head><meta charset="utf-8"><title>App access updated</title></head>
<body>
<h1>App access updated</h1>
<p>Close this tab, return to the app, and click Retry.</p>
<button type="button" onclick="window.close()">Close</button>
<script>
(function(){
  var installationId = ` + string(instJSON) + `;
  var setupAction = ` + string(actJSON) + `;
  if (window.opener) {
    window.opener.postMessage({
      type: 'emergent_feedback_app_setup',
      installation_id: installationId,
      setup_action: setupAction
    }, '*');
  }
})();
</script>
</body></html>`
	return c.HTML(http.StatusOK, page)
}

// renderStateError renders a friendly HTML error page for an invalid or expired
// OAuth state. It returns HTTP 400 so integrations can still detect the failure,
// but explains the cause and offers a retry path.
func (h *Handler) renderStateError(c echo.Context, reason stateReason, origin string) error {
	// Only a signature-valid expired state carries a trustable origin, so only
	// then may we offer a targeted retry and message the opener at that origin.
	retryAllowed := reason == stateExpired && origin != ""
	targetOrigin := "*"
	if retryAllowed {
		targetOrigin = origin
	}

	actionHTML := `<a href="/panel">Go to the panel</a>`
	if retryAllowed {
		retryURL := html.EscapeString("/auth/github?origin=" + url.QueryEscape(origin))
		actionHTML = `<a href="` + retryURL + `">Retry sign-in</a>`
	}

	// Tell a popup opener immediately, including for untrusted/malformed states
	// (the payload carries only a reason code, never a token or origin). Without
	// this the overlay would sit on its 15-minute popup timeout.
	reasonCode := "state_invalid"
	if reason == stateExpired {
		reasonCode = "state_expired"
	}
	reasonJSON, _ := json.Marshal(reasonCode)
	targetJSON, _ := json.Marshal(targetOrigin)
	script := `<script>
if (window.opener) {
  window.opener.postMessage({type:'emergent_feedback_auth_error', code:` + string(reasonJSON) + `}, ` + string(targetJSON) + `);
}
</script>`

	page := `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Sign-in link expired</title></head>
<body>
<h1>Sign-in link expired or invalid</h1>
<p>This sign-in link has expired or is no longer valid. Please start the sign-in again.</p>
` + actionHTML + `
` + script + `
</body></html>`
	return c.HTML(http.StatusBadRequest, page)
}

// HandleMe returns the authenticated user's profile.
func (h *Handler) HandleMe(c echo.Context) error {
	avatar, _ := c.Get("avatar_url").(string)
	return c.JSON(http.StatusOK, map[string]string{
		"login":      middleware.GetLogin(c),
		"avatar_url": avatar,
	})
}
