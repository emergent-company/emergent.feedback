package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// ErrKeyNotFound is returned when an API key is missing or revoked.
var ErrKeyNotFound = errors.New("api key not found")

// APIKey is a user-managed key granting scoped access to feedback data.
type APIKey struct {
	ID         int64
	GitHubUser string
	Repos      []string
	CreatedAt  time.Time
	RevokedAt  *time.Time
}

// CreateAPIKey inserts a key and its repo scope, returning the new key id.
func (s *Store) CreateAPIKey(ctx context.Context, githubUser, keyHash string, repos []string) (int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("store: create api key: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	var id int64
	if err := tx.QueryRowContext(ctx,
		s.bind(`INSERT INTO api_keys (github_user, key_hash) VALUES (?, ?) RETURNING id`),
		githubUser, keyHash,
	).Scan(&id); err != nil {
		return 0, fmt.Errorf("store: insert api key: %w", err)
	}
	for _, repo := range repos {
		if _, err := tx.ExecContext(ctx,
			s.bind(`INSERT INTO api_key_repos (api_key_id, repo) VALUES (?, ?)`),
			id, repo,
		); err != nil {
			return 0, fmt.Errorf("store: insert api key repo: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("store: commit api key: %w", err)
	}
	return id, nil
}

// ListAPIKeys returns a user's keys (newest first) with their repo scopes.
func (s *Store) ListAPIKeys(ctx context.Context, githubUser string) ([]APIKey, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`
SELECT id, github_user, created_at, revoked_at
FROM api_keys WHERE github_user = ? ORDER BY id DESC`), githubUser)
	if err != nil {
		return nil, fmt.Errorf("store: list api keys: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var keys []APIKey
	for rows.Next() {
		var k APIKey
		var createdAt string
		var revokedAt sql.NullString
		if err := rows.Scan(&k.ID, &k.GitHubUser, &createdAt, &revokedAt); err != nil {
			return nil, fmt.Errorf("store: scan api key: %w", err)
		}
		k.CreatedAt, _ = time.Parse(time.RFC3339, createdAt)
		if revokedAt.Valid {
			t, _ := time.Parse(time.RFC3339, revokedAt.String)
			k.RevokedAt = &t
		}
		keys = append(keys, k)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	for i := range keys {
		repos, err := s.keyRepos(ctx, keys[i].ID)
		if err != nil {
			return nil, err
		}
		keys[i].Repos = repos
	}
	return keys, nil
}

// keyRepos returns the repo scope for a key id.
func (s *Store) keyRepos(ctx context.Context, id int64) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT repo FROM api_key_repos WHERE api_key_id = ? ORDER BY repo`), id)
	if err != nil {
		return nil, fmt.Errorf("store: list key repos: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var repos []string
	for rows.Next() {
		var r string
		if err := rows.Scan(&r); err != nil {
			return nil, err
		}
		repos = append(repos, r)
	}
	return repos, rows.Err()
}

// RevokeAPIKey sets revoked_at for a key owned by githubUser.
func (s *Store) RevokeAPIKey(ctx context.Context, id int64, githubUser string) error {
	q := `UPDATE api_keys SET revoked_at = ` + s.d.nowExpr() + ` WHERE id = ? AND github_user = ?`
	res, err := s.db.ExecContext(ctx, s.bind(q), id, githubUser)
	if err != nil {
		return fmt.Errorf("store: revoke api key: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrKeyNotFound
	}
	return nil
}

// LookupAPIKeyScopes returns the repo scope for a non-revoked key hash.
func (s *Store) LookupAPIKeyScopes(ctx context.Context, keyHash string) ([]string, error) {
	var id int64
	err := s.db.QueryRowContext(ctx,
		s.bind(`SELECT id FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL`), keyHash,
	).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrKeyNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("store: lookup api key: %w", err)
	}
	return s.keyRepos(ctx, id)
}
