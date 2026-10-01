package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// UpsertSourcemap stores (or replaces) a source map for (repo, version, path).
func (s *Store) UpsertSourcemap(ctx context.Context, repo, version, path string, content []byte) error {
	const q = `
INSERT INTO sourcemaps (repo, version, path, content) VALUES (?, ?, ?, ?)
ON CONFLICT(repo, version, path) DO UPDATE SET content = excluded.content`
	if _, err := s.db.ExecContext(ctx, q, repo, version, path, content); err != nil {
		return fmt.Errorf("store: upsert sourcemap: %w", err)
	}
	return nil
}

// GetSourcemap returns the source map content for (repo, version, path).
func (s *Store) GetSourcemap(ctx context.Context, repo, version, path string) ([]byte, error) {
	var content []byte
	err := s.db.QueryRowContext(ctx, `SELECT content FROM sourcemaps WHERE repo = ? AND version = ? AND path = ?`, repo, version, path).Scan(&content)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("store: sourcemap %s@%s/%s not found", repo, version, path)
	}
	if err != nil {
		return nil, fmt.Errorf("store: get sourcemap: %w", err)
	}
	return content, nil
}
