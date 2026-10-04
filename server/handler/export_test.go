package handler

import (
	"context"
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
// middleware (no GitHub token is stored, so userRepos always fails).
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

// TestExportIssueRepoMismatch verifies req.Repo must match every item's repo.
func TestExportIssueRepoMismatch(t *testing.T) {
	_, s, e := newExportHandler(t)
	ctx := context.Background()

	f, err := s.Create(ctx, store.CreateParams{URL: "https://app.example.com/", Selector: "button", Comment: "broken", GitHubUser: "alice", Repo: "owner/repo"})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	body := fmt.Sprintf(`{"ids":[%d],"repo":"other/repo"}`, f.ID)
	req := httptest.NewRequest(http.MethodPost, "/issue/export", strings.NewReader(body))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	req.Header.Set("X-Test-Login", "alice")
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", rec.Code, rec.Body.String())
	}
}

// TestExportIssueScopeFailsClosed verifies the caller's repos must cover
// req.Repo, failing closed (403) when the scope cannot be determined.
func TestExportIssueScopeFailsClosed(t *testing.T) {
	_, s, e := newExportHandler(t)
	ctx := context.Background()

	f, err := s.Create(ctx, store.CreateParams{URL: "https://app.example.com/", Selector: "button", Comment: "broken", GitHubUser: "alice", Repo: "owner/repo"})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	// Matching repo, but no stored GitHub token → userRepos fails → 403.
	body := fmt.Sprintf(`{"ids":[%d],"repo":"owner/repo"}`, f.ID)
	req := httptest.NewRequest(http.MethodPost, "/issue/export", strings.NewReader(body))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	req.Header.Set("X-Test-Login", "alice")
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403: %s", rec.Code, rec.Body.String())
	}
}
