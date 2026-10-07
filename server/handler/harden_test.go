package handler

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/emergent-company/emergent.feedback/server/github"
	"github.com/emergent-company/emergent.feedback/server/middleware"
	"github.com/emergent-company/emergent.feedback/server/store"
	"github.com/labstack/echo/v4"
	mcpauth "github.com/modelcontextprotocol/go-sdk/auth"
)

// newHardeningHandler builds an echo server with the sourcemaps route and a
// test-login middleware (mirrors newLifecycleHandler but no GitHub token is
// ever stored, so userToken always fails).
func newHardeningHandler(t *testing.T) (*Handler, *store.Store, *echo.Echo) {
	t.Helper()
	s, err := store.OpenSQLite(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	h := New(s, &github.AppConfig{}, "secret")

	e := echo.New()
	e.Use(func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			c.Set(middleware.UserLoginKey, c.Request().Header.Get("X-Test-Login"))
			return next(c)
		}
	})
	e.POST("/sourcemaps", h.HandleUploadSourcemaps)
	return h, s, e
}

// TestUploadSourcemapsFailsClosed verifies a caller with no stored GitHub token
// gets 401 (not 403), so the panel prompts a fresh GitHub sign-in.
func TestUploadSourcemapsFailsClosed(t *testing.T) {
	_, _, e := newHardeningHandler(t)

	body := `{"repo":"evil/arbitrary","version":"1.0.0","maps":{"bundle.js.map":"{}"}}`
	req := httptest.NewRequest(http.MethodPost, "/sourcemaps", strings.NewReader(body))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	req.Header.Set("X-Test-Login", "alice")
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (fail closed): %s", rec.Code, rec.Body.String())
	}
}

// TestUploadSourcemapsOutOfScope verifies a caller whose token cannot access the
// target repo is rejected with 403 (fail closed), never an arbitrary upload.
func TestUploadSourcemapsOutOfScope(t *testing.T) {
	h, s, e := newHardeningHandler(t)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/repos/evil/arbitrary" {
			t.Errorf("unexpected path %q", r.URL.Path)
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()
	github.SetBaseURLForTesting(srv.URL)
	defer github.SetBaseURLForTesting("https://api.github.com")

	seedUserToken(t, s, h, "alice", "tok")

	body := `{"repo":"evil/arbitrary","version":"1.0.0","maps":{"bundle.js.map":"{}"}}`
	req := httptest.NewRequest(http.MethodPost, "/sourcemaps", strings.NewReader(body))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	req.Header.Set("X-Test-Login", "alice")
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (fail closed): %s", rec.Code, rec.Body.String())
	}
}

// scopeContext wraps a handler that resolves feedback with the bearer-token
// auth middleware so a TokenInfo lands in the request context (there is no
// public context setter for auth.TokenInfo).
func runScopedFeedback(t *testing.T, scopes []string) (int, string) {
	t.Helper()
	s, err := store.OpenSQLite(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	defer func() { _ = s.Close() }()
	h := New(s, &github.AppConfig{}, "secret")

	ctx := context.Background()
	f, err := s.Create(ctx, store.CreateParams{
		URL:        "https://app.example.com/",
		Selector:   "button",
		Comment:    "broken",
		GitHubUser: "alice",
		Repo:       "org/repo",
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	// Deliberately NOT exported: no MarkExported call.

	verifier := func(_ context.Context, _ string, _ *http.Request) (*mcpauth.TokenInfo, error) {
		return &mcpauth.TokenInfo{Scopes: scopes}, nil
	}
	mw := mcpauth.RequireBearerToken(verifier, &mcpauth.RequireBearerTokenOptions{AllowMissingExpiration: true})

	hdr := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, err := h.scopedFeedback(r.Context(), f.ID)
		if err != nil {
			w.WriteHeader(http.StatusForbidden)
			_, _ = fmt.Fprint(w, err.Error())
			return
		}
		_, _ = fmt.Fprintf(w, "%d", got.ID)
	})
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer test")
	rec := httptest.NewRecorder()
	mw(hdr).ServeHTTP(rec, req)
	return rec.Code, rec.Body.String()
}

// TestScopedFeedbackAllowsUnexported verifies MCP get/verify/mark are allowed on
// repo-scoped items regardless of export state.
func TestScopedFeedbackAllowsUnexported(t *testing.T) {
	code, body := runScopedFeedback(t, []string{"org/repo"})
	if code != http.StatusOK {
		t.Fatalf("un-exported repo-scoped item rejected: code=%d body=%s", code, body)
	}
	if _, err := strconv.ParseInt(body, 10, 64); err != nil {
		t.Fatalf("expected feedback id in body, got %q", body)
	}
}

// TestScopedFeedbackRejectsOutOfScope verifies repo-scope enforcement is intact.
func TestScopedFeedbackRejectsOutOfScope(t *testing.T) {
	code, _ := runScopedFeedback(t, []string{"other/repo"})
	if code != http.StatusForbidden {
		t.Fatalf("out-of-scope item not rejected: code=%d", code)
	}
}
