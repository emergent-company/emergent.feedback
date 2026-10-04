// Package ext is the public extension surface for the Enterprise edition.
// It has no dependencies on other emergent.feedback packages.
package ext

import (
	"context"
	"database/sql"
)

// Dialect identifies the underlying database engine.
type Dialect string

const (
	DialectSQLite   Dialect = "sqlite"
	DialectPostgres Dialect = "postgres"
)

// Migration is a versioned schema step owned by an extension. Extensions MUST
// use versions >= 1000 to avoid colliding with the core migrations (1..N).
// Each element of Statements is executed as a single statement.
type Migration struct {
	Version    int
	Name       string
	Statements []string
}

// Store is the minimal data-layer surface an extension needs. *store.Store
// satisfies it.
type Store interface {
	DB() *sql.DB
	Migrate(ctx context.Context, extra []Migration) error
	Dialect() Dialect
}
