package store

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// runStoreContractTests exercises the full public data-layer surface against a
// freshly-opened store per subtest. Identifiers include a time-based run suffix
// so the suite is re-runnable and subtests never collide on a shared database.
func runStoreContractTests(t *testing.T, open func(t *testing.T) *Store) {
	runID := time.Now().UnixNano()
	seq := 0
	newSuffix := func() string {
		seq++
		return fmt.Sprintf("%d-%d", runID, seq)
	}
	ctx := context.Background()

	t.Run("feedback", func(t *testing.T) {
		s := open(t)
		suf := newSuffix()
		url := "https://app.example.com/page-" + suf
		githubUser := "alice-" + suf
		repo := "owner/repo-" + suf
		issueURL := "https://github.com/owner/repo/issues/" + suf

		f, err := s.Create(ctx, CreateParams{
			URL:         url,
			Selector:    "button.foo",
			Comment:     "hello world",
			ContextJSON: `{"page":"dashboard"}`,
			GitHubUser:  githubUser,
			Repo:        repo,
			Label:       "feedback",
		})
		if err != nil {
			t.Fatalf("Create: %v", err)
		}
		if f.ID <= 0 {
			t.Fatalf("Create: id = %d, want > 0", f.ID)
		}
		if f.CreatedAt.IsZero() {
			t.Fatalf("Create: created_at = %v, want non-zero RFC3339 time", f.CreatedAt)
		}

		got, err := s.Get(ctx, f.ID)
		if err != nil {
			t.Fatalf("Get: %v", err)
		}
		if got.ID != f.ID || got.URL != url || got.GitHubUser != githubUser || got.Repo != repo {
			t.Fatalf("Get: got %+v, want id=%d url=%q user=%q repo=%q", got, f.ID, url, githubUser, repo)
		}
		if got.Status != StatusOpen {
			t.Fatalf("Get: status = %q, want %q", got.Status, StatusOpen)
		}

		listed, err := s.ListByURL(ctx, url)
		if err != nil {
			t.Fatalf("ListByURL: %v", err)
		}
		if len(listed) != 1 || listed[0].ID != f.ID {
			t.Fatalf("ListByURL: got %d items, want 1 (id %d)", len(listed), f.ID)
		}

		summaries, err := s.ListByURLSummary(ctx, url)
		if err != nil {
			t.Fatalf("ListByURLSummary: %v", err)
		}
		if len(summaries) != 1 {
			t.Fatalf("ListByURLSummary: got %d summaries, want 1", len(summaries))
		}
		if summaries[0].Count != 1 || summaries[0].Selector != "button.foo" {
			t.Fatalf("ListByURLSummary: got %+v, want count=1 selector=button.foo", summaries[0])
		}
		if len(summaries[0].IDs) != 1 || summaries[0].IDs[0] != f.ID {
			t.Fatalf("ListByURLSummary: ids = %v, want [%d]", summaries[0].IDs, f.ID)
		}

		if err := s.MarkExported(ctx, []int64{f.ID}, issueURL); err != nil {
			t.Fatalf("MarkExported: %v", err)
		}
		exported, err := s.Get(ctx, f.ID)
		if err != nil {
			t.Fatalf("Get after export: %v", err)
		}
		if exported.IssueURL != issueURL {
			t.Fatalf("Get after export: issue_url = %q, want %q", exported.IssueURL, issueURL)
		}
		if exported.Status != StatusExported {
			t.Fatalf("Get after export: status = %q, want %q", exported.Status, StatusExported)
		}

		if err := s.Delete(ctx, f.ID, githubUser); err != nil {
			t.Fatalf("Delete: %v", err)
		}
		if _, err := s.Get(ctx, f.ID); err == nil {
			t.Fatalf("Get after delete: expected error, got nil")
		}
	})

	t.Run("github issues", func(t *testing.T) {
		s := open(t)
		suf := newSuffix()
		issueNumber := runID + int64(seq)
		pageURL := "https://app.example.com/issues-" + suf
		repo := "org/repo-" + suf
		issueURL := "https://github.com/org/repo/issues/" + suf

		if err := s.CreateGitHubIssue(ctx, GitHubIssue{
			IssueNumber: issueNumber,
			IssueURL:    issueURL,
			Repo:        repo,
			Title:       "Feedback on button",
			PageURL:     pageURL,
			Selector:    "div",
			FeedbackIDs: "[1,2]",
		}); err != nil {
			t.Fatalf("CreateGitHubIssue: %v", err)
		}

		gi, err := s.GetGitHubIssueByNumber(ctx, issueNumber)
		if err != nil {
			t.Fatalf("GetGitHubIssueByNumber: %v", err)
		}
		if gi.IssueNumber != issueNumber || gi.Repo != repo || gi.FeedbackIDs != "[1,2]" {
			t.Fatalf("GetGitHubIssueByNumber: got %+v", gi)
		}

		open, err := s.ListOpenGitHubIssuesByURL(ctx, pageURL)
		if err != nil {
			t.Fatalf("ListOpenGitHubIssuesByURL: %v", err)
		}
		if len(open) != 1 {
			t.Fatalf("ListOpenGitHubIssuesByURL: got %d, want 1", len(open))
		}

		if err := s.SetGitHubIssueState(ctx, issueNumber, repo, "closed"); err != nil {
			t.Fatalf("SetGitHubIssueState: %v", err)
		}
		open, err = s.ListOpenGitHubIssuesByURL(ctx, pageURL)
		if err != nil {
			t.Fatalf("ListOpenGitHubIssuesByURL after close: %v", err)
		}
		if len(open) != 0 {
			t.Fatalf("ListOpenGitHubIssuesByURL after close: got %d, want 0", len(open))
		}
	})

	t.Run("api keys", func(t *testing.T) {
		s := open(t)
		suf := newSuffix()
		githubUser := "alice-" + suf
		keyHash := "hash-" + suf
		repos := []string{"org/repo-a-" + suf, "org/repo-b-" + suf}

		id, err := s.CreateAPIKey(ctx, githubUser, keyHash, repos)
		if err != nil {
			t.Fatalf("CreateAPIKey: %v", err)
		}
		if id <= 0 {
			t.Fatalf("CreateAPIKey: id = %d, want > 0", id)
		}

		scopes, err := s.LookupAPIKeyScopes(ctx, keyHash)
		if err != nil {
			t.Fatalf("LookupAPIKeyScopes: %v", err)
		}
		if len(scopes) != 2 || scopes[0] != repos[0] || scopes[1] != repos[1] {
			t.Fatalf("LookupAPIKeyScopes: got %v, want %v", scopes, repos)
		}

		keys, err := s.ListAPIKeys(ctx, githubUser)
		if err != nil {
			t.Fatalf("ListAPIKeys: %v", err)
		}
		if len(keys) != 1 {
			t.Fatalf("ListAPIKeys: got %d keys, want 1", len(keys))
		}
		if len(keys[0].Repos) != 2 || keys[0].Repos[0] != repos[0] || keys[0].Repos[1] != repos[1] {
			t.Fatalf("ListAPIKeys: repos = %v, want %v", keys[0].Repos, repos)
		}

		if err := s.RevokeAPIKey(ctx, id, githubUser); err != nil {
			t.Fatalf("RevokeAPIKey: %v", err)
		}
		if _, err := s.LookupAPIKeyScopes(ctx, keyHash); !errors.Is(err, ErrKeyNotFound) {
			t.Fatalf("LookupAPIKeyScopes after revoke: err = %v, want ErrKeyNotFound", err)
		}
	})

	t.Run("user tokens", func(t *testing.T) {
		s := open(t)
		suf := newSuffix()
		githubUser := "alice-" + suf

		if err := s.UpsertUserToken(ctx, githubUser, []byte("enc-token-1")); err != nil {
			t.Fatalf("UpsertUserToken: %v", err)
		}
		got, err := s.GetUserToken(ctx, githubUser)
		if err != nil {
			t.Fatalf("GetUserToken: %v", err)
		}
		if string(got) != "enc-token-1" {
			t.Fatalf("GetUserToken: got %q, want enc-token-1", string(got))
		}

		if err := s.UpsertUserToken(ctx, githubUser, []byte("enc-token-2")); err != nil {
			t.Fatalf("UpsertUserToken (overwrite): %v", err)
		}
		got, err = s.GetUserToken(ctx, githubUser)
		if err != nil {
			t.Fatalf("GetUserToken after overwrite: %v", err)
		}
		if string(got) != "enc-token-2" {
			t.Fatalf("GetUserToken after overwrite: got %q, want enc-token-2", string(got))
		}
	})

	t.Run("sourcemaps", func(t *testing.T) {
		s := open(t)
		suf := newSuffix()
		repo := "org/repo-" + suf
		version := "1.0.0-" + suf
		content := []byte(`{"version":3,"file":"bundle.js","sources":["src/App.tsx"],"names":[],"mappings":"AAAA"}`)

		if err := s.UpsertSourcemap(ctx, repo, version, "dist/assets/bundle.js.map", content); err != nil {
			t.Fatalf("UpsertSourcemap: %v", err)
		}

		got, err := s.GetSourcemap(ctx, repo, version, "dist/assets/bundle.js.map")
		if err != nil {
			t.Fatalf("GetSourcemap (exact): %v", err)
		}
		if string(got) != string(content) {
			t.Fatalf("GetSourcemap exact content = %q, want %q", got, content)
		}

		got, err = s.GetSourcemap(ctx, repo, version, "bundle.js.map")
		if err != nil {
			t.Fatalf("GetSourcemap (suffix): %v", err)
		}
		if string(got) != string(content) {
			t.Fatalf("GetSourcemap suffix content = %q, want %q", got, content)
		}

		if _, err := s.GetSourcemap(ctx, repo, version, "other.js.map"); err == nil {
			t.Fatal("expected not-found for unrelated basename")
		}
	})
}

func TestStoreContractSQLite(t *testing.T) {
	runStoreContractTests(t, func(t *testing.T) *Store {
		s, err := OpenSQLite(filepath.Join(t.TempDir(), "contract.db"))
		if err != nil {
			t.Fatalf("OpenSQLite: %v", err)
		}
		t.Cleanup(func() { _ = s.Close() })
		return s
	})
}

func TestStoreContractPostgres(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL unset; skipping Postgres contract tests")
	}
	runStoreContractTests(t, func(t *testing.T) *Store {
		s, err := OpenPostgres(dsn)
		if err != nil {
			t.Fatalf("OpenPostgres: %v", err)
		}
		t.Cleanup(func() { _ = s.Close() })
		return s
	})
}
