package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// UpsertSourcemap stores (or replaces) a source map for (repo, version, path).
func (s *Store) UpsertSourcemap(ctx context.Context, repo, version, path string, content []byte) error {
	q := `
INSERT INTO sourcemaps (repo, version, path, content) VALUES (?, ?, ?, ?)
ON CONFLICT(repo, version, path) DO UPDATE SET content = excluded.content`
	if _, err := s.db.ExecContext(ctx, s.bind(q), repo, version, path, content); err != nil {
		return fmt.Errorf("store: upsert sourcemap: %w", err)
	}
	return nil
}

// GetSourcemap returns the source map content for (repo, version, path).
// It tries an exact path match first, then falls back to a suffix match so
// CI uploads keyed by full asset path (e.g. dist/assets/bundle.js.map) still
// resolve a basename probe (bundle.js.map) from the stack-frame unmapper.
func (s *Store) GetSourcemap(ctx context.Context, repo, version, path string) ([]byte, error) {
	var content []byte
	err := s.db.QueryRowContext(ctx, s.bind(`SELECT content FROM sourcemaps WHERE repo = ? AND version = ? AND path = ?`), repo, version, path).Scan(&content)
	if err == nil {
		return content, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("store: get sourcemap: %w", err)
	}

	// Suffix fallback: prefer the shortest matching path (closest to exact).
	err = s.db.QueryRowContext(ctx, s.bind(`SELECT content FROM sourcemaps WHERE repo = ? AND version = ? AND path LIKE '%' || ? ORDER BY length(path) ASC LIMIT 1`), repo, version, path).Scan(&content)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("store: sourcemap %s@%s/%s not found", repo, version, path)
	}
	if err != nil {
		return nil, fmt.Errorf("store: get sourcemap: %w", err)
	}
	return content, nil
}
