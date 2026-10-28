package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// ErrMemoryDestinationNotFound is returned when no Memory destination exists
// for a repository.
var ErrMemoryDestinationNotFound = errors.New("memory destination not found")

// ErrMemoryOAuthStateNotFound is returned when an OAuth state row is missing or
// expired.
var ErrMemoryOAuthStateNotFound = errors.New("memory oauth state not found")

// MemoryDestination is the per-repository connection to an emergent.memory
// project. The Memory token is encrypted at rest with the feedback JWT secret.
type MemoryDestination struct {
	ID              int64
	Repo            string
	BaseURL         string
	ProjectID       string
	ProjectName     string
	ClientID        string
	TokenEncrypted  []byte
	TokenID         string
	Scopes          string
	Mode            string
	FeedbackBaseURL string
	LastSyncAt      *time.Time
	LastError       string
	CreatedBy       string
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

// MemoryLink records the Memory graph object created for a feedback row.
type MemoryLink struct {
	FeedbackID    int64
	DestinationID int64
	ObjectKey     string
	CanonicalID   string
	LastSyncedAt  *time.Time
	LastError     string
}

// MemoryOutboxItem is a durable, retryable Memory write.
type MemoryOutboxItem struct {
	ID            int64
	FeedbackID    int64
	DestinationID int64
	Op            string // "upsert" | "patch"
	Payload       string // JSON
	Attempts      int
	NextAttemptAt time.Time
	LastError     string
	CreatedAt     time.Time
}

// MemoryOAuthState is a short-lived PKCE/state row for the connect flow.
type MemoryOAuthState struct {
	State           string
	Repo            string
	GitHubUser      string
	BaseURL         string
	Verifier        string
	RedirectURI     string
	FeedbackBaseURL string
	CreatedAt       time.Time
	ExpiresAt       time.Time
}

// MemoryOAuthClient is the dynamically registered OAuth client for a Memory
// instance. One feedback instance registers once per Memory base URL.
type MemoryOAuthClient struct {
	BaseURL     string
	ClientID    string
	RedirectURI string
	CreatedAt   time.Time
}

func parseTimePtr(s sql.NullString) *time.Time {
	if !s.Valid || s.String == "" {
		return nil
	}
	t, err := time.Parse(time.RFC3339, s.String)
	if err != nil {
		return nil
	}
	return &t
}

// UpsertMemoryDestination inserts or replaces the destination for a repo.
func (s *Store) UpsertMemoryDestination(ctx context.Context, d MemoryDestination) error {
	mode := d.Mode
	if mode == "" {
		mode = "ask"
	}
	q := `
INSERT INTO memory_destinations
  (repo, base_url, project_id, project_name, client_id, token_encrypted, token_id, scopes, mode, feedback_base_url, created_by)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(repo) DO UPDATE SET
  base_url = excluded.base_url,
  project_id = excluded.project_id,
  project_name = excluded.project_name,
  client_id = excluded.client_id,
  token_encrypted = excluded.token_encrypted,
  token_id = excluded.token_id,
  scopes = excluded.scopes,
  mode = excluded.mode,
  feedback_base_url = excluded.feedback_base_url,
  last_error = '',
  updated_at = ` + s.d.nowExpr()
	_, err := s.db.ExecContext(ctx, s.bind(q),
		d.Repo, d.BaseURL, d.ProjectID, d.ProjectName, d.ClientID, d.TokenEncrypted,
		d.TokenID, d.Scopes, mode, d.FeedbackBaseURL, d.CreatedBy,
	)
	if err != nil {
		return fmt.Errorf("store: upsert memory destination: %w", err)
	}
	return nil
}

const memoryDestinationColumns = `
  id, repo, base_url, project_id, project_name, client_id, token_encrypted, token_id,
  scopes, mode, feedback_base_url, last_sync_at, last_error, created_by, created_at, updated_at`

func scanMemoryDestination(sc interface {
	Scan(dest ...any) error
}) (MemoryDestination, error) {
	var d MemoryDestination
	var lastSync sql.NullString
	var createdAt, updatedAt string
	if err := sc.Scan(
		&d.ID, &d.Repo, &d.BaseURL, &d.ProjectID, &d.ProjectName, &d.ClientID,
		&d.TokenEncrypted, &d.TokenID, &d.Scopes, &d.Mode, &d.FeedbackBaseURL,
		&lastSync, &d.LastError, &d.CreatedBy, &createdAt, &updatedAt,
	); err != nil {
		return MemoryDestination{}, err
	}
	d.LastSyncAt = parseTimePtr(lastSync)
	d.CreatedAt, _ = time.Parse(time.RFC3339, createdAt)
	d.UpdatedAt, _ = time.Parse(time.RFC3339, updatedAt)
	return d, nil
}

// GetMemoryDestination returns the destination for a repo.
func (s *Store) GetMemoryDestination(ctx context.Context, repo string) (MemoryDestination, error) {
	q := `SELECT ` + memoryDestinationColumns + ` FROM memory_destinations WHERE repo = ?`
	d, err := scanMemoryDestination(s.db.QueryRowContext(ctx, s.bind(q), repo))
	if errors.Is(err, sql.ErrNoRows) {
		return MemoryDestination{}, ErrMemoryDestinationNotFound
	}
	if err != nil {
		return MemoryDestination{}, fmt.Errorf("store: get memory destination: %w", err)
	}
	return d, nil
}

// GetMemoryDestinationByID returns the destination by primary key.
func (s *Store) GetMemoryDestinationByID(ctx context.Context, id int64) (MemoryDestination, error) {
	q := `SELECT ` + memoryDestinationColumns + ` FROM memory_destinations WHERE id = ?`
	d, err := scanMemoryDestination(s.db.QueryRowContext(ctx, s.bind(q), id))
	if errors.Is(err, sql.ErrNoRows) {
		return MemoryDestination{}, ErrMemoryDestinationNotFound
	}
	if err != nil {
		return MemoryDestination{}, fmt.Errorf("store: get memory destination by id: %w", err)
	}
	return d, nil
}

// ListMemoryDestinations returns all destinations (admin/test use).
func (s *Store) ListMemoryDestinations(ctx context.Context) ([]MemoryDestination, error) {
	q := `SELECT ` + memoryDestinationColumns + ` FROM memory_destinations ORDER BY repo`
	return s.queryMemoryDestinations(ctx, q)
}

// ListMemoryDestinationsByUser returns the destinations created by a user.
func (s *Store) ListMemoryDestinationsByUser(ctx context.Context, login string) ([]MemoryDestination, error) {
	q := `SELECT ` + memoryDestinationColumns + ` FROM memory_destinations WHERE created_by = ? ORDER BY repo`
	return s.queryMemoryDestinations(ctx, q, login)
}

func (s *Store) queryMemoryDestinations(ctx context.Context, q string, args ...any) ([]MemoryDestination, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(q), args...)
	if err != nil {
		return nil, fmt.Errorf("store: list memory destinations: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var out []MemoryDestination
	for rows.Next() {
		d, err := scanMemoryDestination(rows)
		if err != nil {
			return nil, fmt.Errorf("store: scan memory destination: %w", err)
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// DeleteMemoryDestination removes a destination and its links/outbox rows.
func (s *Store) DeleteMemoryDestination(ctx context.Context, repo string) error {
	d, err := s.GetMemoryDestination(ctx, repo)
	if err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck
	if _, err := tx.ExecContext(ctx, s.bind(`DELETE FROM memory_links WHERE destination_id = ?`), d.ID); err != nil {
		return fmt.Errorf("store: delete memory links: %w", err)
	}
	if _, err := tx.ExecContext(ctx, s.bind(`DELETE FROM memory_outbox WHERE destination_id = ?`), d.ID); err != nil {
		return fmt.Errorf("store: delete memory outbox: %w", err)
	}
	res, err := tx.ExecContext(ctx, s.bind(`DELETE FROM memory_destinations WHERE id = ?`), d.ID)
	if err != nil {
		return fmt.Errorf("store: delete memory destination: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrMemoryDestinationNotFound
	}
	return tx.Commit()
}

// SetMemoryDestinationMode updates the per-repo submit mode.
func (s *Store) SetMemoryDestinationMode(ctx context.Context, repo, mode string) error {
	q := `UPDATE memory_destinations SET mode = ?, updated_at = ` + s.d.nowExpr() + ` WHERE repo = ?`
	res, err := s.db.ExecContext(ctx, s.bind(q), mode, repo)
	if err != nil {
		return fmt.Errorf("store: set memory destination mode: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrMemoryDestinationNotFound
	}
	return nil
}

// SetMemoryDestinationError records the latest sync/connection error.
func (s *Store) SetMemoryDestinationError(ctx context.Context, id int64, msg string) error {
	q := `UPDATE memory_destinations SET last_error = ?, updated_at = ` + s.d.nowExpr() + ` WHERE id = ?`
	_, err := s.db.ExecContext(ctx, s.bind(q), msg, id)
	return err
}

// MarkMemoryDestinationSynced records a successful push.
func (s *Store) MarkMemoryDestinationSynced(ctx context.Context, id int64) error {
	q := `UPDATE memory_destinations SET last_sync_at = ` + s.d.nowExpr() + `, last_error = '', updated_at = ` + s.d.nowExpr() + ` WHERE id = ?`
	_, err := s.db.ExecContext(ctx, s.bind(q), id)
	return err
}

// UpsertMemoryLink records the object key/canonical id for a feedback row.
func (s *Store) UpsertMemoryLink(ctx context.Context, l MemoryLink) error {
	q := `
INSERT INTO memory_links (feedback_id, destination_id, object_key, canonical_id, last_synced_at, last_error)
VALUES (?, ?, ?, ?, ` + s.d.nowExpr() + `, '')
ON CONFLICT(feedback_id, destination_id) DO UPDATE SET
  object_key = excluded.object_key,
  canonical_id = excluded.canonical_id,
  last_synced_at = excluded.last_synced_at,
  last_error = ''`
	_, err := s.db.ExecContext(ctx, s.bind(q), l.FeedbackID, l.DestinationID, l.ObjectKey, l.CanonicalID)
	if err != nil {
		return fmt.Errorf("store: upsert memory link: %w", err)
	}
	return nil
}

// GetMemoryLink returns the link for a feedback/destination pair.
func (s *Store) GetMemoryLink(ctx context.Context, feedbackID, destinationID int64) (MemoryLink, error) {
	q := `SELECT feedback_id, destination_id, object_key, canonical_id, last_synced_at, last_error
FROM memory_links WHERE feedback_id = ? AND destination_id = ?`
	var l MemoryLink
	var lastSync sql.NullString
	err := s.db.QueryRowContext(ctx, s.bind(q), feedbackID, destinationID).Scan(
		&l.FeedbackID, &l.DestinationID, &l.ObjectKey, &l.CanonicalID, &lastSync, &l.LastError,
	)
	if err != nil {
		return MemoryLink{}, err
	}
	l.LastSyncedAt = parseTimePtr(lastSync)
	return l, nil
}

// EnqueueMemoryOutbox adds a durable write and returns its id.
func (s *Store) EnqueueMemoryOutbox(ctx context.Context, item MemoryOutboxItem) (int64, error) {
	next := item.NextAttemptAt
	if next.IsZero() {
		next = time.Now().UTC()
	}
	q := `INSERT INTO memory_outbox (feedback_id, destination_id, op, payload, attempts, next_attempt_at)
VALUES (?, ?, ?, ?, ?, ?) RETURNING id`
	var id int64
	err := s.db.QueryRowContext(ctx, s.bind(q),
		item.FeedbackID, item.DestinationID, item.Op, item.Payload, item.Attempts,
		next.UTC().Format(time.RFC3339),
	).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("store: enqueue memory outbox: %w", err)
	}
	return id, nil
}

// ListDueMemoryOutbox returns due rows, oldest first.
func (s *Store) ListDueMemoryOutbox(ctx context.Context, limit int) ([]MemoryOutboxItem, error) {
	if limit <= 0 {
		limit = 20
	}
	q := `SELECT id, feedback_id, destination_id, op, payload, attempts, next_attempt_at, last_error, created_at
FROM memory_outbox WHERE next_attempt_at <= ? ORDER BY id LIMIT ?`
	rows, err := s.db.QueryContext(ctx, s.bind(q), time.Now().UTC().Format(time.RFC3339), limit)
	if err != nil {
		return nil, fmt.Errorf("store: list memory outbox: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var out []MemoryOutboxItem
	for rows.Next() {
		var it MemoryOutboxItem
		var next, created string
		if err := rows.Scan(&it.ID, &it.FeedbackID, &it.DestinationID, &it.Op, &it.Payload,
			&it.Attempts, &next, &it.LastError, &created); err != nil {
			return nil, fmt.Errorf("store: scan memory outbox: %w", err)
		}
		it.NextAttemptAt, _ = time.Parse(time.RFC3339, next)
		it.CreatedAt, _ = time.Parse(time.RFC3339, created)
		out = append(out, it)
	}
	return out, rows.Err()
}

// RescheduleMemoryOutbox records a failed attempt and its next retry time.
func (s *Store) RescheduleMemoryOutbox(ctx context.Context, id int64, attempts int, next time.Time, lastErr string) error {
	q := `UPDATE memory_outbox SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?`
	_, err := s.db.ExecContext(ctx, s.bind(q), attempts, next.UTC().Format(time.RFC3339), lastErr, id)
	return err
}

// DeleteMemoryOutbox removes a completed write.
func (s *Store) DeleteMemoryOutbox(ctx context.Context, id int64) error {
	_, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM memory_outbox WHERE id = ?`), id)
	return err
}

// CreateMemoryOAuthState stores a short-lived PKCE state row.
func (s *Store) CreateMemoryOAuthState(ctx context.Context, st MemoryOAuthState) error {
	q := `INSERT INTO memory_oauth_states
  (state, repo, github_user, base_url, verifier, redirect_uri, feedback_base_url, expires_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	_, err := s.db.ExecContext(ctx, s.bind(q),
		st.State, st.Repo, st.GitHubUser, st.BaseURL, st.Verifier, st.RedirectURI,
		st.FeedbackBaseURL, st.ExpiresAt.UTC().Format(time.RFC3339),
	)
	if err != nil {
		return fmt.Errorf("store: create memory oauth state: %w", err)
	}
	return nil
}

// ConsumeMemoryOAuthState returns and deletes a state row (single use).
func (s *Store) ConsumeMemoryOAuthState(ctx context.Context, state string) (MemoryOAuthState, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return MemoryOAuthState{}, err
	}
	defer tx.Rollback() //nolint:errcheck

	q := `SELECT state, repo, github_user, base_url, verifier, redirect_uri, feedback_base_url, created_at, expires_at
FROM memory_oauth_states WHERE state = ?`
	var st MemoryOAuthState
	var created, expires string
	err = tx.QueryRowContext(ctx, s.bind(q), state).Scan(
		&st.State, &st.Repo, &st.GitHubUser, &st.BaseURL, &st.Verifier,
		&st.RedirectURI, &st.FeedbackBaseURL, &created, &expires,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return MemoryOAuthState{}, ErrMemoryOAuthStateNotFound
	}
	if err != nil {
		return MemoryOAuthState{}, err
	}
	if _, err := tx.ExecContext(ctx, s.bind(`DELETE FROM memory_oauth_states WHERE state = ?`), state); err != nil {
		return MemoryOAuthState{}, err
	}
	if err := tx.Commit(); err != nil {
		return MemoryOAuthState{}, err
	}
	st.CreatedAt, _ = time.Parse(time.RFC3339, created)
	st.ExpiresAt, _ = time.Parse(time.RFC3339, expires)
	if time.Now().After(st.ExpiresAt) {
		return MemoryOAuthState{}, ErrMemoryOAuthStateNotFound
	}
	return st, nil
}

// CleanupMemoryOAuthStates removes expired rows.
func (s *Store) CleanupMemoryOAuthStates(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM memory_oauth_states WHERE expires_at < ?`),
		time.Now().UTC().Format(time.RFC3339))
	return err
}

// GetMemoryOAuthClient returns the registered client for a Memory base URL.
func (s *Store) GetMemoryOAuthClient(ctx context.Context, baseURL string) (MemoryOAuthClient, error) {
	q := `SELECT base_url, client_id, redirect_uri, created_at FROM memory_oauth_clients WHERE base_url = ?`
	var c MemoryOAuthClient
	var created string
	err := s.db.QueryRowContext(ctx, s.bind(q), baseURL).Scan(&c.BaseURL, &c.ClientID, &c.RedirectURI, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return MemoryOAuthClient{}, sql.ErrNoRows
	}
	if err != nil {
		return MemoryOAuthClient{}, err
	}
	c.CreatedAt, _ = time.Parse(time.RFC3339, created)
	return c, nil
}

// UpsertMemoryOAuthClient stores/replaces the registered client for a base URL.
func (s *Store) UpsertMemoryOAuthClient(ctx context.Context, c MemoryOAuthClient) error {
	q := `INSERT INTO memory_oauth_clients (base_url, client_id, redirect_uri)
VALUES (?, ?, ?)
ON CONFLICT(base_url) DO UPDATE SET client_id = excluded.client_id, redirect_uri = excluded.redirect_uri`
	_, err := s.db.ExecContext(ctx, s.bind(q), c.BaseURL, c.ClientID, c.RedirectURI)
	if err != nil {
		return fmt.Errorf("store: upsert memory oauth client: %w", err)
	}
	return nil
}
