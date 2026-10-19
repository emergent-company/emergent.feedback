package handler

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/labstack/echo/v4"
)

func TestOAuthStateRoundtrip(t *testing.T) {
	h := &Handler{JWTSecret: "secret"}
	s := h.generateState("")
	if reason := validateStateReason(h, s); reason != stateValid {
		t.Fatalf("valid state reason = %q, want valid", reason)
	}
}

func TestOAuthStateCarriesOrigin(t *testing.T) {
	h := &Handler{JWTSecret: "secret"}
	origin := "https://app.example.com"
	s := h.generateState(origin)
	got, reason := h.validateState(s)
	if reason != stateValid {
		t.Fatalf("valid state reason = %q, want valid", reason)
	}
	if got != origin {
		t.Fatalf("origin = %q, want %q", got, origin)
	}
}

func TestOAuthStateRejectsInvalid(t *testing.T) {
	h := &Handler{JWTSecret: "secret"}
	// "garbage", "1234", "1234.", "abc.def", "1234.00" are malformed/bad-signature,
	// but all must be non-valid. "" is missing.
	for _, bad := range []string{"garbage", "1234", "1234.", "abc.def", ".abc", "1234.00"} {
		if reason := validateStateReason(h, bad); reason == stateValid {
			t.Fatalf("state %q should not validate", bad)
		}
	}
}

func TestOAuthStateMissing(t *testing.T) {
	h := &Handler{JWTSecret: "secret"}
	if reason := validateStateReason(h, ""); reason != stateMissing {
		t.Fatalf("reason = %q, want %q", reason, stateMissing)
	}
}

func TestOAuthStateMalformed(t *testing.T) {
	h := &Handler{JWTSecret: "secret"}
	// A well-formed "payload.sig" whose payload has no parseable expiry.
	for _, bad := range []string{"garbage", "notanumber.sig"} {
		if reason := validateStateReason(h, bad); reason != stateMalformed && reason != stateBadSig {
			t.Fatalf("state %q reason = %q, want malformed or bad_signature", bad, reason)
		}
	}
	// Specifically: no dot at all -> malformed.
	if reason := validateStateReason(h, "garbage"); reason != stateMalformed {
		t.Fatalf("no-dot state reason = %q, want malformed", reason)
	}
}

func TestOAuthStateBadSignature(t *testing.T) {
	h := &Handler{JWTSecret: "secret"}
	payload := strconv.FormatInt(time.Now().Add(time.Minute).Unix(), 10)
	s := payload + "." + signState(payload, "wrong-secret")
	if reason := validateStateReason(h, s); reason != stateBadSig {
		t.Fatalf("reason = %q, want %q", reason, stateBadSig)
	}
}

func TestOAuthStateRejectsTampered(t *testing.T) {
	h := &Handler{JWTSecret: "secret"}
	s := h.generateState("")
	b := []byte(s)
	if b[len(b)-1] == '0' {
		b[len(b)-1] = '1'
	} else {
		b[len(b)-1] = '0'
	}
	if reason := validateStateReason(h, string(b)); reason != stateBadSig {
		t.Fatalf("tampered state reason = %q, want %q", reason, stateBadSig)
	}
}

func TestOAuthStateExpired(t *testing.T) {
	h := &Handler{JWTSecret: "secret"}
	payload := strconv.FormatInt(time.Now().Add(-time.Minute).Unix(), 10)
	s := payload + "." + signState(payload, "secret")
	if reason := validateStateReason(h, s); reason != stateExpired {
		t.Fatalf("expired state reason = %q, want %q", reason, stateExpired)
	}
}

func TestOAuthStateExpiredPreservesOrigin(t *testing.T) {
	h := &Handler{JWTSecret: "secret"}
	origin := "https://app.example.com"
	payload := strconv.FormatInt(time.Now().Add(-time.Minute).Unix(), 10) +
		":" + base64.RawURLEncoding.EncodeToString([]byte(origin))
	s := payload + "." + signState(payload, "secret")
	got, reason := h.validateState(s)
	if reason != stateExpired {
		t.Fatalf("reason = %q, want %q", reason, stateExpired)
	}
	if got != origin {
		t.Fatalf("origin = %q, want %q", got, origin)
	}
}

// --- handler-level tests ---

func TestHandleGitHubSetupRendersPageWithoutToken(t *testing.T) {
	h := &Handler{JWTSecret: "secret"}
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/auth/setup?installation_id=123&setup_action=install", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	if err := h.HandleGitHubSetup(c); err != nil {
		t.Fatalf("HandleGitHubSetup: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "App access updated") {
		t.Fatalf("body missing setup confirmation: %s", body)
	}
	if strings.Contains(body, "emergent_feedback_auth") {
		t.Fatalf("setup page must not issue an auth token/message: %s", body)
	}
	if strings.Contains(body, "postMessage") {
		t.Fatalf("setup page should not post to an opener: %s", body)
	}
}

func TestHandleGitHubCallbackSetupRedirectWithoutState(t *testing.T) {
	h := &Handler{JWTSecret: "secret"}
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/auth/callback?installation_id=123&setup_action=install", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	if err := h.HandleGitHubCallback(c); err != nil {
		t.Fatalf("HandleGitHubCallback: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "App access updated") {
		t.Fatalf("body missing setup confirmation: %s", body)
	}
	if strings.Contains(body, "emergent_feedback_auth") {
		t.Fatalf("setup redirect must not issue auth token: %s", body)
	}
}

func TestHandleGitHubCallbackExpiredStateRendersRetry(t *testing.T) {
	h := &Handler{JWTSecret: "secret"}
	origin := "https://app.example.com"
	payload := strconv.FormatInt(time.Now().Add(-time.Minute).Unix(), 10) +
		":" + base64.RawURLEncoding.EncodeToString([]byte(origin))
	state := payload + "." + signState(payload, "secret")

	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/auth/callback?state="+state, nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	if err := h.HandleGitHubCallback(c); err != nil {
		t.Fatalf("HandleGitHubCallback: %v", err)
	}
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "state_expired") {
		t.Fatalf("body missing state_expired message: %s", body)
	}
	if !strings.Contains(body, "/auth/github?origin=") {
		t.Fatalf("body missing retry sign-in link: %s", body)
	}
	// Retry link must carry the recovered origin, URL-encoded.
	if !strings.Contains(body, url.QueryEscape(origin)) {
		t.Fatalf("retry link missing recovered origin: %s", body)
	}
	// Target origin in the postMessage must be the JSON-marshalled trusted origin.
	var wantTarget = mustJSONString(t, origin)
	if !strings.Contains(body, wantTarget) {
		t.Fatalf("body missing JSON target origin %s: %s", wantTarget, body)
	}
}

func TestHandleGitHubCallbackInvalidStateNoRetry(t *testing.T) {
	h := &Handler{JWTSecret: "secret"}
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/auth/callback?state=garbage", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	if err := h.HandleGitHubCallback(c); err != nil {
		t.Fatalf("HandleGitHubCallback: %v", err)
	}
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	body := rec.Body.String()
	if strings.Contains(body, "/auth/github?origin=") {
		t.Fatalf("malformed state must not offer a targeted retry: %s", body)
	}
	if !strings.Contains(body, "/panel") {
		t.Fatalf("body missing fallback panel link: %s", body)
	}
	if !strings.Contains(body, "state_invalid") {
		t.Fatalf("body missing state_invalid opener message: %s", body)
	}
}

// --- helpers ---

// validateStateReason reports the validation reason, discarding the origin.
func validateStateReason(h *Handler, s string) stateReason {
	_, reason := h.validateState(s)
	return reason
}

func mustJSONString(t *testing.T, v string) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}
	return string(b)
}
