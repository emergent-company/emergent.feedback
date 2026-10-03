package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
)

func TestMigrateCreatesSchema(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test.db")

	s, err := OpenSQLite(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	for _, table := range []string{"feedback", "github_issues", "schema_migrations", "feedback_events"} {
		var n int
		if err := s.db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?`, table).Scan(&n); err != nil {
			t.Fatalf("query %s: %v", table, err)
		}
		if n != 1 {
			t.Fatalf("table %s missing", table)
		}
	}

	var v int
	if err := s.db.QueryRow(`SELECT MAX(version) FROM schema_migrations`).Scan(&v); err != nil {
		t.Fatal(err)
	}
	if v != 7 {
		t.Fatalf("schema version = %d, want 7", v)
	}

	for _, col := range []string{"applied_at", "verified_at", "resolved_at", "verification_result", "verification_detail", "replay", "replay_size"} {
		var n int
		if err := s.db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('feedback') WHERE name=?`, col).Scan(&n); err != nil {
			t.Fatalf("column %s: %v", col, err)
		}
		if n != 1 {
			t.Fatalf("feedback column %s missing", col)
		}
	}

	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestMigrateUpgradeFromV4(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test.db")

	// Build a database at schema version 4 (all migrations except the new one).
	db, err := sql.Open("sqlite", dsnWithPragmas(path))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	ctx := context.Background()
	if _, err := db.ExecContext(ctx, dialectSQLite.schemaMigrationsDDL()); err != nil {
		t.Fatalf("schema_migrations: %v", err)
	}
	for _, m := range sqliteMigrations[:4] {
		if err := applyMigration(ctx, db, dialectSQLite, m); err != nil {
			t.Fatalf("migration %d: %v", m.version, err)
		}
	}
	_ = db.Close()

	// Reopen via Open, which applies migration 5.
	s, err := OpenSQLite(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = s.Close() }()

	var v int
	if err := s.db.QueryRow(`SELECT MAX(version) FROM schema_migrations`).Scan(&v); err != nil {
		t.Fatal(err)
	}
	if v != 7 {
		t.Fatalf("schema version = %d, want 7", v)
	}
	var n int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='feedback_events'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatal("feedback_events table missing after upgrade")
	}
}

func TestMigrateIdempotent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test.db")

	s1, err := OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := s1.Close(); err != nil {
		t.Fatal(err)
	}

	s2, err := OpenSQLite(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer func() { _ = s2.Close() }()

	var v int
	if err := s2.db.QueryRow(`SELECT MAX(version) FROM schema_migrations`).Scan(&v); err != nil {
		t.Fatal(err)
	}
	if v != 7 {
		t.Fatalf("schema version = %d, want 7", v)
	}
}

func TestSetGitHubIssueState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test.db")
	s, err := OpenSQLite(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = s.Close() }()

	ctx := context.Background()
	if err := s.CreateGitHubIssue(ctx, GitHubIssue{
		IssueNumber: 42,
		IssueURL:    "https://github.com/org/repo/issues/42",
		Repo:        "org/repo",
		Title:       "t",
		PageURL:     "https://app.example.com/",
		Selector:    "div",
	}); err != nil {
		t.Fatalf("CreateGitHubIssue: %v", err)
	}

	open, err := s.ListOpenGitHubIssuesByURL(ctx, "https://app.example.com/")
	if err != nil {
		t.Fatal(err)
	}
	if len(open) != 1 {
		t.Fatalf("expected 1 open issue, got %d", len(open))
	}

	if err := s.SetGitHubIssueState(ctx, 42, "org/repo", "closed"); err != nil {
		t.Fatalf("SetGitHubIssueState: %v", err)
	}

	open, err = s.ListOpenGitHubIssuesByURL(ctx, "https://app.example.com/")
	if err != nil {
		t.Fatal(err)
	}
	if len(open) != 0 {
		t.Fatalf("expected 0 open issues after close, got %d", len(open))
	}
}

func TestForeignKeysEnforced(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test.db")

	s, err := OpenSQLite(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = s.Close() }()

	// Create a child table referencing feedback.id.
	if _, err := s.db.Exec(`CREATE TABLE child (id INTEGER PRIMARY KEY, feedback_id INTEGER REFERENCES feedback(id))`); err != nil {
		t.Fatalf("create child: %v", err)
	}
	// Inserting a row whose feedback_id doesn't exist must fail — this proves
	// foreign_keys is enforced on every pooled connection (via the DSN _pragma).
	if _, err := s.db.Exec(`INSERT INTO child (feedback_id) VALUES (999999)`); err == nil {
		t.Fatal("expected foreign key violation, got nil error")
	}
}
