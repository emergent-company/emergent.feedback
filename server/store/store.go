package store

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	_ "modernc.org/sqlite"
)

const pragmas = `PRAGMA journal_mode=WAL;`

const schemaMigrations = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL,
  applied_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);`

// migration is a single versioned, ordered schema step. Append new migrations
// to the list — never edit an already-released one.
type migration struct {
	version int
	name    string
	stmts   string
}

// migrations are applied in ascending version order, each inside its own
// transaction. version 1 is the initial schema (idempotent).
var migrations = []migration{
	{1, "init", `
CREATE TABLE IF NOT EXISTS feedback (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  url          TEXT    NOT NULL,
  selector     TEXT    NOT NULL,
  comment      TEXT    NOT NULL,
  context_json TEXT    NOT NULL DEFAULT '{}',
  screenshot   BLOB,
  github_user  TEXT    NOT NULL,
  repo         TEXT    NOT NULL,
  label        TEXT    NOT NULL DEFAULT 'feedback',
  status       TEXT    NOT NULL DEFAULT 'open',
  issue_url    TEXT,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS github_issues (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_number INTEGER NOT NULL,
  issue_url    TEXT    NOT NULL,
  repo         TEXT    NOT NULL,
  title        TEXT    NOT NULL,
  page_url     TEXT    NOT NULL,
  selector     TEXT    NOT NULL,
  state        TEXT    NOT NULL DEFAULT 'open',
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  synced_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS feedback_url_idx       ON feedback(url);
CREATE INDEX IF NOT EXISTS feedback_repo_idx      ON feedback(repo);
CREATE INDEX IF NOT EXISTS github_issues_url_idx  ON github_issues(page_url);
CREATE INDEX IF NOT EXISTS github_issues_repo_idx ON github_issues(repo);
`},
	{2, "snapshot", `
ALTER TABLE feedback ADD COLUMN snapshot BLOB;
ALTER TABLE feedback ADD COLUMN snapshot_secret TEXT;
ALTER TABLE feedback ADD COLUMN snapshot_size INTEGER;
ALTER TABLE github_issues ADD COLUMN feedback_ids TEXT;
`},
	{3, "api_keys", `
CREATE TABLE IF NOT EXISTS api_keys (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  github_user TEXT NOT NULL,
  key_hash    TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  revoked_at  TEXT
);

CREATE TABLE IF NOT EXISTS api_key_repos (
  api_key_id  INTEGER NOT NULL,
  repo        TEXT NOT NULL,
  PRIMARY KEY (api_key_id, repo)
);

CREATE INDEX IF NOT EXISTS api_keys_user_idx ON api_keys(github_user);
`},
	{4, "user_tokens", `
CREATE TABLE IF NOT EXISTS user_tokens (
  github_user     TEXT PRIMARY KEY,
  token_encrypted BLOB NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
`},
	{5, "feedback_lifecycle", `
ALTER TABLE feedback ADD COLUMN applied_at TEXT;
ALTER TABLE feedback ADD COLUMN verified_at TEXT;
ALTER TABLE feedback ADD COLUMN resolved_at TEXT;
ALTER TABLE feedback ADD COLUMN verification_result TEXT;
ALTER TABLE feedback ADD COLUMN verification_detail TEXT;
CREATE TABLE IF NOT EXISTS feedback_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  feedback_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  actor TEXT,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS feedback_events_feedback_idx ON feedback_events(feedback_id);
`},
	{6, "replay", `
ALTER TABLE feedback ADD COLUMN replay BLOB;
ALTER TABLE feedback ADD COLUMN replay_size INTEGER;
`},
	{7, "sourcemaps_dedupe", `
CREATE TABLE IF NOT EXISTS sourcemaps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL,
  content BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE(repo, version, path)
);
ALTER TABLE feedback ADD COLUMN dedupe_key TEXT;
ALTER TABLE feedback ADD COLUMN duplicate_of INTEGER;
CREATE INDEX IF NOT EXISTS feedback_dedupe_idx ON feedback(repo, dedupe_key);
`},
}

// Store wraps the SQLite database connection.
type Store struct {
	db *sql.DB
}

// dsnWithPragmas appends per-connection PRAGMAs to the SQLite DSN. Every
// connection in the pool gets foreign-key enforcement and a busy timeout, so
// concurrent access waits rather than failing with SQLITE_BUSY.
func dsnWithPragmas(path string) string {
	sep := "?"
	if strings.Contains(path, "?") {
		sep = "&"
	}
	return path + sep + "_pragma=foreign_keys(1)&_pragma=busy_timeout(10000)"
}

// Open opens (or creates) the SQLite database at path and applies the schema.
func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", dsnWithPragmas(path))
	if err != nil {
		return nil, fmt.Errorf("store: open %s: %w", path, err)
	}
	// SQLite with WAL supports concurrent readers plus a single writer; allow
	// a small pool so read-heavy endpoints don't serialize behind one connection.
	db.SetMaxOpenConns(4)

	ctx := context.Background()
	if _, err := db.ExecContext(ctx, pragmas); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("store: apply pragmas: %w", err)
	}
	if err := migrate(ctx, db); err != nil {
		_ = db.Close()
		return nil, err
	}
	return &Store{db: db}, nil
}

// Close closes the underlying database connection.
func (s *Store) Close() error {
	return s.db.Close()
}

// DB returns the raw *sql.DB for use in sub-packages.
func (s *Store) DB() *sql.DB {
	return s.db
}

// migrate applies any pending schema migrations in order.
func migrate(ctx context.Context, db *sql.DB) error {
	if _, err := db.ExecContext(ctx, schemaMigrations); err != nil {
		return fmt.Errorf("store: create schema_migrations: %w", err)
	}

	var current int
	if err := db.QueryRowContext(ctx, `SELECT COALESCE(MAX(version), 0) FROM schema_migrations`).Scan(&current); err != nil {
		return fmt.Errorf("store: read schema version: %w", err)
	}

	for _, m := range migrations {
		if m.version <= current {
			continue
		}
		if err := applyMigration(ctx, db, m); err != nil {
			return err
		}
	}
	return nil
}

func applyMigration(ctx context.Context, db *sql.DB, m migration) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: begin migration %d: %w", m.version, err)
	}
	defer tx.Rollback() //nolint:errcheck

	if _, err := tx.ExecContext(ctx, m.stmts); err != nil {
		return fmt.Errorf("store: migrate %d (%s): %w", m.version, m.name, err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO schema_migrations (version, name) VALUES (?, ?)`, m.version, m.name); err != nil {
		return fmt.Errorf("store: record migration %d (%s): %w", m.version, m.name, err)
	}
	return tx.Commit()
}
