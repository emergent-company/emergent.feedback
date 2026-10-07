package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/emergent-company/emergent.feedback/server/github"
	"github.com/emergent-company/emergent.feedback/server/middleware"
	"github.com/emergent-company/emergent.feedback/server/store"
	"github.com/labstack/echo/v4"
)

// newExportHandler builds an echo server with the export route and a test-login
// middleware (no GitHub token is stored, so userToken always fails).
func newExportHandler(t *testing.T) (*Handler, *store.Store, *echo.Echo) {
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
	e.POST("/issue/export", h.HandleExportIssue)
	return h, s, e
}

// seedUserToken stores an encrypted GitHub token for login.
func seedUserToken(t *testing.T, s *store.Store, h *Handler, login, token string) {
	t.Helper()
	enc, err := encryptToken(token, h.JWTSecret)
	if err != nil {
		t.Fatalf("encryptToken: %v", err)
	}
	if err := s.UpsertUserToken(context.Background(), login, enc); err != nil {
		t.Fatalf("UpsertUserToken: %v", err)
	}
}

// newExportFeedback creates a feedback item owned by "alice" in "owner/repo".
func newExportFeedback(t *testing.T, s *store.Store) int64 {
	t.Helper()
	f, err := s.Create(context.Background(), store.CreateParams{
		URL:        "https://app.example.com/",
		Selector:   "button",
		Comment:    "broken",
		GitHubUser: "alice",
		Repo:       "owner/repo",
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	return f.ID
}

// doExport POSTs an export request for a feedback id and returns the response.
func doExport(e *echo.Echo, id int64, repo, login string) *httptest.ResponseRecorder {
	body := fmt.Sprintf(`{"ids":[%d],"repo":%q}`, id, repo)
	req := httptest.NewRequest(http.MethodPost, "/issue/export", strings.NewReader(body))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	req.Header.Set("X-Test-Login", login)
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	return rec
}

// TestExportIssueRepoMismatch verifies req.Repo must match every item's repo.
func TestExportIssueRepoMismatch(t *testing.T) {
	_, s, e := newExportHandler(t)

	id := newExportFeedback(t, s)

	rec := doExport(e, id, "other/repo", "alice")

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", rec.Code, rec.Body.String())
	}
}

// TestExportIssueScopeFailsClosed verifies a caller with no stored GitHub token
// gets 401 (not 403), so the panel prompts a fresh GitHub sign-in.
func TestExportIssueScopeFailsClosed(t *testing.T) {
	_, s, e := newExportHandler(t)

	id := newExportFeedback(t, s)

	// Matching repo, but no stored GitHub token → userToken errors with 401.
	rec := doExport(e, id, "owner/repo", "alice")

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401: %s", rec.Code, rec.Body.String())
	}
}

// TestExportIssueProbeAccessible verifies a repo the token can access proceeds.
func TestExportIssueProbeAccessible(t *testing.T) {
	h, s, e := newExportHandler(t)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/repos/owner/repo":
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{}`))
		case r.Method == http.MethodPost && r.URL.Path == "/repos/owner/repo/issues":
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"html_url":"https://github.com/owner/repo/issues/1","number":1}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	github.SetBaseURLForTesting(srv.URL)
	defer github.SetBaseURLForTesting("https://api.github.com")

	seedUserToken(t, s, h, "alice", "tok")
	id := newExportFeedback(t, s)

	rec := doExport(e, id, "owner/repo", "alice")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
}

// TestExportIssueProbeNotFoundWithInstallation verifies a 404 probe plus a
// matching installation yields a structured app_access_required 403.
func TestExportIssueProbeNotFoundWithInstallation(t *testing.T) {
	h, s, e := newExportHandler(t)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/owner/repo":
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"message":"Not Found"}`))
		case "/user/installations":
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"installations":[{"id":1,"app_slug":"my-app","repository_selection":"selected","html_url":"https://github.com/settings/installations/1","account":{"login":"owner","type":"Organization"}}]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	github.SetBaseURLForTesting(srv.URL)
	defer github.SetBaseURLForTesting("https://api.github.com")

	seedUserToken(t, s, h, "alice", "tok")
	id := newExportFeedback(t, s)

	rec := doExport(e, id, "owner/repo", "alice")

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403: %s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("expected JSON body, got %q: %v", rec.Body.String(), err)
	}
	if body["error"] != "app_access_required" {
		t.Fatalf("error = %v, want app_access_required", body["error"])
	}
	if repo, _ := body["repo"].(string); repo != "owner/repo" {
		t.Fatalf("repo = %v, want owner/repo", body["repo"])
	}
	if au, _ := body["authorize_url"].(string); au == "" {
		t.Fatalf("authorize_url is empty")
	}
}

// TestExportIssueProbeNotFoundNoGuidance verifies a 404 probe with no
// installations and no GH_APP_SLUG yields a plain 403 "repo not in scope".
func TestExportIssueProbeNotFoundNoGuidance(t *testing.T) {
	h, s, e := newExportHandler(t)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/owner/repo":
			w.WriteHeader(http.StatusNotFound)
		case "/user/installations":
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"installations":[]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	github.SetBaseURLForTesting(srv.URL)
	defer github.SetBaseURLForTesting("https://api.github.com")

	seedUserToken(t, s, h, "alice", "tok")
	id := newExportFeedback(t, s)

	rec := doExport(e, id, "owner/repo", "alice")

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403: %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "app_access_required") {
		t.Fatalf("expected plain 403, got %q", rec.Body.String())
	}
}

// TestExportIssueProbeUnauthorized verifies a GitHub API 401 maps to HTTP 401.
func TestExportIssueProbeUnauthorized(t *testing.T) {
	h, s, e := newExportHandler(t)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()
	github.SetBaseURLForTesting(srv.URL)
	defer github.SetBaseURLForTesting("https://api.github.com")

	seedUserToken(t, s, h, "alice", "tok")
	id := newExportFeedback(t, s)

	rec := doExport(e, id, "owner/repo", "alice")

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401: %s", rec.Code, rec.Body.String())
	}
}

// TestExportIssueProbeUpstreamError verifies an upstream 500 maps to 502.
func TestExportIssueProbeUpstreamError(t *testing.T) {
	h, s, e := newExportHandler(t)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()
	github.SetBaseURLForTesting(srv.URL)
	defer github.SetBaseURLForTesting("https://api.github.com")

	seedUserToken(t, s, h, "alice", "tok")
	id := newExportFeedback(t, s)

	rec := doExport(e, id, "owner/repo", "alice")

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502: %s", rec.Code, rec.Body.String())
	}
}
