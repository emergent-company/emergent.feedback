package store

import (
	"context"
	"database/sql"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/emergent-company/emergent.feedback/server/ext"
	_ "github.com/jackc/pgx/v5/stdlib"
	_ "modernc.org/sqlite"
)

const pragmas = `PRAGMA journal_mode=WAL;`

type dialect int

const (
	dialectSQLite dialect = iota
	dialectPostgres
)

func (d dialect) driverName() string {
	if d == dialectPostgres {
		return "pgx"
	}
	return "sqlite"
}

// rebind rewrites SQLite '?' placeholders to Postgres '$1..$n'. Identity for
// SQLite. Safe across single-quoted string literals and doubled-quote escapes.
func (d dialect) rebind(query string) string {
	if d != dialectPostgres || !strings.Contains(query, "?") {
		return query
	}
	var b strings.Builder
	b.Grow(len(query) + 8)
	n := 0
	for i := 0; i < len(query); i++ {
		switch c := query[i]; c {
		case '?':
			n++
			b.WriteByte('$')
			b.WriteString(strconv.Itoa(n))
		case '\'':
			b.WriteByte(c)
			i++
			for i < len(query) {
				b.WriteByte(query[i])
				if query[i] == '\'' {
					if i+1 < len(query) && query[i+1] == '\'' {
						b.WriteByte(query[i+1])
						i++
					} else {
						break
					}
				}
				i++
			}
		default:
			b.WriteByte(c)
		}
	}
	return b.String()
}

func (d dialect) nowExpr() string {
	if d == dialectPostgres {
		return `to_char(now() AT TIME ZONE 'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"')`
	}
	return `strftime('%Y-%m-%dT%H:%M:%SZ','now')`
}

func (d dialect) groupConcat(col string) string {
	if d == dialectPostgres {
		return "STRING_AGG(" + col + "::text, ',' ORDER BY " + col + ")"
	}
	return "GROUP_CONCAT(" + col + ")"
}

func (d dialect) maxOpenConns() int {
	if d == dialectPostgres {
		return 20
	}
	return 4
}

func (d dialect) migrations() []migration {
	if d == dialectPostgres {
		return postgresMigrations
	}
	return sqliteMigrations
}

func (d dialect) schemaMigrationsDDL() string {
	if d == dialectPostgres {
		return `CREATE TABLE IF NOT EXISTS schema_migrations (
  version    BIGINT PRIMARY KEY,
  name       TEXT   NOT NULL,
  applied_at TEXT   NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"'))
);`
	}
	return `CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL,
  applied_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);`
}

func (s *Store) bind(q string) string { return s.d.rebind(q) }

// migration is a single versioned, ordered schema step. Append new migrations
// to the list — never edit an already-released one.
type migration struct {
	version int
	name    string
	stmts   []string
}

// sqliteMigrations are applied in ascending version order, each inside its own
// transaction. version 1 is the initial schema (idempotent).
var sqliteMigrations = []migration{
	{1, "init", []string{
		`CREATE TABLE IF NOT EXISTS feedback (
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
);`,
		`CREATE TABLE IF NOT EXISTS github_issues (
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
);`,
		`CREATE INDEX IF NOT EXISTS feedback_url_idx       ON feedback(url);`,
		`CREATE INDEX IF NOT EXISTS feedback_repo_idx      ON feedback(repo);`,
		`CREATE INDEX IF NOT EXISTS github_issues_url_idx  ON github_issues(page_url);`,
		`CREATE INDEX IF NOT EXISTS github_issues_repo_idx ON github_issues(repo);`,
	}},
	{2, "snapshot", []string{
		`ALTER TABLE feedback ADD COLUMN snapshot BLOB;`,
		`ALTER TABLE feedback ADD COLUMN snapshot_secret TEXT;`,
		`ALTER TABLE feedback ADD COLUMN snapshot_size INTEGER;`,
		`ALTER TABLE github_issues ADD COLUMN feedback_ids TEXT;`,
	}},
	{3, "api_keys", []string{
		`CREATE TABLE IF NOT EXISTS api_keys (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  github_user TEXT NOT NULL,
  key_hash    TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  revoked_at  TEXT
);`,
		`CREATE TABLE IF NOT EXISTS api_key_repos (
  api_key_id  INTEGER NOT NULL,
  repo        TEXT NOT NULL,
  PRIMARY KEY (api_key_id, repo)
);`,
		`CREATE INDEX IF NOT EXISTS api_keys_user_idx ON api_keys(github_user);`,
	}},
	{4, "user_tokens", []string{
		`CREATE TABLE IF NOT EXISTS user_tokens (
  github_user     TEXT PRIMARY KEY,
  token_encrypted BLOB NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);`,
	}},
	{5, "feedback_lifecycle", []string{
		`ALTER TABLE feedback ADD COLUMN applied_at TEXT;`,
		`ALTER TABLE feedback ADD COLUMN verified_at TEXT;`,
		`ALTER TABLE feedback ADD COLUMN resolved_at TEXT;`,
		`ALTER TABLE feedback ADD COLUMN verification_result TEXT;`,
		`ALTER TABLE feedback ADD COLUMN verification_detail TEXT;`,
		`CREATE TABLE IF NOT EXISTS feedback_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  feedback_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  actor TEXT,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);`,
		`CREATE INDEX IF NOT EXISTS feedback_events_feedback_idx ON feedback_events(feedback_id);`,
	}},
	{6, "replay", []string{
		`ALTER TABLE feedback ADD COLUMN replay BLOB;`,
		`ALTER TABLE feedback ADD COLUMN replay_size INTEGER;`,
	}},
	{7, "sourcemaps_dedupe", []string{
		`CREATE TABLE IF NOT EXISTS sourcemaps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL,
  content BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE(repo, version, path)
);`,
		`ALTER TABLE feedback ADD COLUMN dedupe_key TEXT;`,
		`ALTER TABLE feedback ADD COLUMN duplicate_of INTEGER;`,
		`CREATE INDEX IF NOT EXISTS feedback_dedupe_idx ON feedback(repo, dedupe_key);`,
	}},
}

// postgresMigrations mirror sqliteMigrations with PostgreSQL DDL. Same version
// numbers and names so the ledger matches across dialects.
var postgresMigrations = []migration{
	{1, "init", []string{
		`CREATE TABLE IF NOT EXISTS feedback (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  url          TEXT    NOT NULL,
  selector     TEXT    NOT NULL,
  comment      TEXT    NOT NULL,
  context_json TEXT    NOT NULL DEFAULT '{}',
  screenshot   BYTEA,
  github_user  TEXT    NOT NULL,
  repo         TEXT    NOT NULL,
  label        TEXT    NOT NULL DEFAULT 'feedback',
  status       TEXT    NOT NULL DEFAULT 'open',
  issue_url    TEXT,
  created_at   TEXT    NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"'))
);`,
		`CREATE TABLE IF NOT EXISTS github_issues (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  issue_number BIGINT  NOT NULL,
  issue_url    TEXT    NOT NULL,
  repo         TEXT    NOT NULL,
  title        TEXT    NOT NULL,
  page_url     TEXT    NOT NULL,
  selector     TEXT    NOT NULL,
  state        TEXT    NOT NULL DEFAULT 'open',
  created_at   TEXT    NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"')),
  synced_at    TEXT    NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"'))
);`,
		`CREATE INDEX IF NOT EXISTS feedback_url_idx       ON feedback(url);`,
		`CREATE INDEX IF NOT EXISTS feedback_repo_idx      ON feedback(repo);`,
		`CREATE INDEX IF NOT EXISTS github_issues_url_idx  ON github_issues(page_url);`,
		`CREATE INDEX IF NOT EXISTS github_issues_repo_idx ON github_issues(repo);`,
	}},
	{2, "snapshot", []string{
		`ALTER TABLE feedback ADD COLUMN snapshot BYTEA;`,
		`ALTER TABLE feedback ADD COLUMN snapshot_secret TEXT;`,
		`ALTER TABLE feedback ADD COLUMN snapshot_size BIGINT;`,
		`ALTER TABLE github_issues ADD COLUMN feedback_ids TEXT;`,
	}},
	{3, "api_keys", []string{
		`CREATE TABLE IF NOT EXISTS api_keys (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  github_user TEXT NOT NULL,
  key_hash    TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"')),
  revoked_at  TEXT
);`,
		`CREATE TABLE IF NOT EXISTS api_key_repos (
  api_key_id  BIGINT NOT NULL,
  repo        TEXT NOT NULL,
  PRIMARY KEY (api_key_id, repo)
);`,
		`CREATE INDEX IF NOT EXISTS api_keys_user_idx ON api_keys(github_user);`,
	}},
	{4, "user_tokens", []string{
		`CREATE TABLE IF NOT EXISTS user_tokens (
  github_user     TEXT PRIMARY KEY,
  token_encrypted BYTEA NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"')),
  updated_at      TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"'))
);`,
	}},
	{5, "feedback_lifecycle", []string{
		`ALTER TABLE feedback ADD COLUMN applied_at TEXT;`,
		`ALTER TABLE feedback ADD COLUMN verified_at TEXT;`,
		`ALTER TABLE feedback ADD COLUMN resolved_at TEXT;`,
		`ALTER TABLE feedback ADD COLUMN verification_result TEXT;`,
		`ALTER TABLE feedback ADD COLUMN verification_detail TEXT;`,
		`CREATE TABLE IF NOT EXISTS feedback_events (
  seq         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  feedback_id BIGINT NOT NULL,
  type        TEXT NOT NULL,
  actor       TEXT,
  detail      TEXT,
  created_at  TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"'))
);`,
		`CREATE INDEX IF NOT EXISTS feedback_events_feedback_idx ON feedback_events(feedback_id);`,
	}},
	{6, "replay", []string{
		`ALTER TABLE feedback ADD COLUMN replay BYTEA;`,
		`ALTER TABLE feedback ADD COLUMN replay_size BIGINT;`,
	}},
	{7, "sourcemaps_dedupe", []string{
		`CREATE TABLE IF NOT EXISTS sourcemaps (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  repo       TEXT NOT NULL,
  version    TEXT NOT NULL DEFAULT '',
  path       TEXT NOT NULL,
  content    BYTEA NOT NULL,
  created_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"')),
  UNIQUE(repo, version, path)
);`,
		`ALTER TABLE feedback ADD COLUMN dedupe_key TEXT;`,
		`ALTER TABLE feedback ADD COLUMN duplicate_of BIGINT;`,
		`CREATE INDEX IF NOT EXISTS feedback_dedupe_idx ON feedback(repo, dedupe_key);`,
	}},
}

// Store wraps the database connection.
type Store struct {
	db *sql.DB
	d  dialect
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

// OpenSQLite opens (or creates) the SQLite database at path and applies the schema.
func OpenSQLite(path string) (*Store, error) {
	d := dialectSQLite
	db, err := sql.Open(d.driverName(), dsnWithPragmas(path))
	if err != nil {
		return nil, fmt.Errorf("store: open %s: %w", path, err)
	}
	db.SetMaxOpenConns(d.maxOpenConns())
	ctx := context.Background()
	if _, err := db.ExecContext(ctx, pragmas); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("store: apply pragmas: %w", err)
	}
	if err := migrate(ctx, db, d); err != nil {
		_ = db.Close()
		return nil, err
	}
	return &Store{db: db, d: d}, nil
}

// OpenPostgres opens a Postgres database via the pgx stdlib driver and applies the schema.
func OpenPostgres(dsn string) (*Store, error) {
	d := dialectPostgres
	db, err := sql.Open(d.driverName(), dsn)
	if err != nil {
		return nil, fmt.Errorf("store: open postgres: %w", err)
	}
	db.SetMaxOpenConns(d.maxOpenConns())
	ctx := context.Background()
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("store: ping postgres: %w", err)
	}
	if err := migrate(ctx, db, d); err != nil {
		_ = db.Close()
		return nil, err
	}
	return &Store{db: db, d: d}, nil
}

// Close closes the underlying database connection.
func (s *Store) Close() error {
	return s.db.Close()
}

// DB returns the raw *sql.DB for use in sub-packages.
func (s *Store) DB() *sql.DB {
	return s.db
}

// Dialect reports the underlying database engine.
func (s *Store) Dialect() ext.Dialect {
	if s.d == dialectPostgres {
		return ext.DialectPostgres
	}
	return ext.DialectSQLite
}

// Migrate applies extension-owned migrations (versions must exceed the core
// namespace) inside the shared schema_migrations ledger.
func (s *Store) Migrate(ctx context.Context, extra []ext.Migration) error {
	mig := append([]ext.Migration(nil), extra...)
	sort.Slice(mig, func(i, j int) bool { return mig[i].Version < mig[j].Version })
	return withMigrationConn(ctx, s.db, s.d, func(conn *sql.Conn) error {
		applied, err := appliedVersions(ctx, conn, s.d)
		if err != nil {
			return err
		}
		for _, m := range mig {
			if m.Version < extensionMinVersion {
				return fmt.Errorf("store: extension migration %d (%s) must be >= %d", m.Version, m.Name, extensionMinVersion)
			}
			if applied[m.Version] {
				continue // idempotent rerun
			}
			if err := applyMigration(ctx, conn, s.d, migration{version: m.Version, name: m.Name, stmts: m.Statements}); err != nil {
				return err
			}
			applied[m.Version] = true
		}
		return nil
	})
}

const migrationLockKey int64 = 0x656d6665 // "emfe"
const extensionMinVersion = 1000

// withMigrationConn pins a single connection for the whole migration run so a
// Postgres advisory lock and its unlock happen on the same session.
func withMigrationConn(ctx context.Context, db *sql.DB, d dialect, fn func(*sql.Conn) error) error {
	conn, err := db.Conn(ctx)
	if err != nil {
		return fmt.Errorf("store: acquire migration connection: %w", err)
	}
	defer func() { _ = conn.Close() }()
	if d == dialectPostgres {
		if _, err := conn.ExecContext(ctx, `SELECT pg_advisory_lock($1)`, migrationLockKey); err != nil {
			return fmt.Errorf("store: acquire migration lock: %w", err)
		}
		defer func() {
			_, _ = conn.ExecContext(context.Background(), `SELECT pg_advisory_unlock($1)`, migrationLockKey)
		}()
	}
	return fn(conn)
}

func appliedVersions(ctx context.Context, conn *sql.Conn, d dialect) (map[int]bool, error) {
	rows, err := conn.QueryContext(ctx, d.rebind(`SELECT version FROM schema_migrations`))
	if err != nil {
		return nil, fmt.Errorf("store: read schema versions: %w", err)
	}
	defer func() { _ = rows.Close() }()
	applied := map[int]bool{}
	for rows.Next() {
		var v int64
		if err := rows.Scan(&v); err != nil {
			return nil, fmt.Errorf("store: scan schema version: %w", err)
		}
		applied[int(v)] = true
	}
	return applied, rows.Err()
}

func migrate(ctx context.Context, db *sql.DB, d dialect) error {
	return withMigrationConn(ctx, db, d, func(conn *sql.Conn) error {
		if _, err := conn.ExecContext(ctx, d.schemaMigrationsDDL()); err != nil {
			return fmt.Errorf("store: create schema_migrations: %w", err)
		}
		applied, err := appliedVersions(ctx, conn, d)
		if err != nil {
			return err
		}
		for _, m := range d.migrations() {
			if applied[m.version] {
				continue
			}
			if err := applyMigration(ctx, conn, d, m); err != nil {
				return err
			}
		}
		return nil
	})
}

func applyMigration(ctx context.Context, conn *sql.Conn, d dialect, m migration) error {
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: begin migration %d: %w", m.version, err)
	}
	defer tx.Rollback() //nolint:errcheck
	for _, stmt := range m.stmts {
		if _, err := tx.ExecContext(ctx, d.rebind(stmt)); err != nil {
			return fmt.Errorf("store: migrate %d (%s): %w", m.version, m.name, err)
		}
	}
	if _, err := tx.ExecContext(ctx, d.rebind(`INSERT INTO schema_migrations (version, name) VALUES (?, ?)`), m.version, m.name); err != nil {
		return fmt.Errorf("store: record migration %d (%s): %w", m.version, m.name, err)
	}
	return tx.Commit()
}
