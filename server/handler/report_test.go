package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/emergent-company/emergent.feedback/server/github"
	"github.com/emergent-company/emergent.feedback/server/middleware"
	"github.com/emergent-company/emergent.feedback/server/store"
	"github.com/labstack/echo/v4"
)

// newReportsHandler wires the reports endpoints against a temp SQLite store and
// a fake GitHub API that only lists repositories.
func newReportsHandler(t *testing.T) (*Handler, *store.Store, *echo.Echo) {
	t.Helper()
	s, err := store.OpenSQLite(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })

	h := New(s, &github.AppConfig{}, "secret")

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/user/repos" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`[{"full_name":"org/repo","permissions":{"admin":true}}]`))
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(srv.Close)
	github.SetBaseURLForTesting(srv.URL)
	t.Cleanup(func() { github.SetBaseURLForTesting("https://api.github.com") })

	enc, err := encryptToken("test-token", "secret")
	if err != nil {
		t.Fatalf("encryptToken: %v", err)
	}
	if err := s.UpsertUserToken(context.Background(), "alice", enc); err != nil {
		t.Fatalf("UpsertUserToken: %v", err)
	}

	e := echo.New()
	e.Use(func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			c.Set(middleware.UserLoginKey, "alice")
			return next(c)
		}
	})
	e.GET("/api/reports", h.HandleListReports)
	e.GET("/api/reports/:id", h.HandleGetReport)
	return h, s, e
}

func TestHandleListReportsIncludesIssueState(t *testing.T) {
	_, s, e := newReportsHandler(t)
	ctx := context.Background()

	f, err := s.Create(ctx, store.CreateParams{
		URL:        "https://app.example.com/panel",
		Selector:   "button.save",
		Comment:    "change the label",
		GitHubUser: "alice",
		Repo:       "org/repo",
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	issueURL := "https://github.com/org/repo/issues/57"
	if err := s.MarkExported(ctx, []int64{f.ID}, issueURL); err != nil {
		t.Fatalf("MarkExported: %v", err)
	}
	if err := s.CreateGitHubIssue(ctx, store.GitHubIssue{
		IssueNumber: 57,
		IssueURL:    issueURL,
		Repo:        "org/repo",
		Title:       "change the label",
		PageURL:     "https://app.example.com/panel",
		Selector:    "button.save",
	}); err != nil {
		t.Fatalf("CreateGitHubIssue: %v", err)
	}
	if err := s.SetGitHubIssueState(ctx, 57, "org/repo", "closed"); err != nil {
		t.Fatalf("SetGitHubIssueState: %v", err)
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/reports", nil)
	e.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}

	var got []reportSummary
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d reports, want 1", len(got))
	}
	r := got[0]
	if r.IssueNumber != 57 {
		t.Fatalf("issue_number = %d, want 57", r.IssueNumber)
	}
	if r.IssueState != "closed" {
		t.Fatalf("issue_state = %q, want closed", r.IssueState)
	}
	if _, err := time.Parse(time.RFC3339, r.CreatedAt); err != nil {
		t.Fatalf("created_at %q is not RFC3339: %v", r.CreatedAt, err)
	}
	if r.IssueStateSyncedAt == "" {
		t.Fatal("issue_state_synced_at is empty")
	}

	// Detail carries the same status for the preview pane.
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/reports/"+strconv.FormatInt(f.ID, 10), nil)
	e.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("detail status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	var detail reportDetail
	if err := json.Unmarshal(rec.Body.Bytes(), &detail); err != nil {
		t.Fatalf("unmarshal detail: %v", err)
	}
	if detail.IssueState != "closed" || detail.IssueNumber != 57 {
		t.Fatalf("detail issue = (%d, %q), want (57, closed)", detail.IssueNumber, detail.IssueState)
	}
}
