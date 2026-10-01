package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// FeedbackStatus represents the lifecycle state of a feedback item.
type FeedbackStatus string

const (
	StatusOpen     FeedbackStatus = "open"
	StatusApplied  FeedbackStatus = "applied"
	StatusVerified FeedbackStatus = "verified"
	StatusResolved FeedbackStatus = "resolved"
	StatusExported FeedbackStatus = "exported"
)

// Feedback is a single user-submitted feedback item.
type Feedback struct {
	ID           int64
	URL          string
	Selector     string
	Comment      string
	ContextJSON  string
	Screenshot   []byte // may be nil
	Snapshot     []byte // may be nil
	SnapshotSize int
	GitHubUser   string
	Repo         string
	Label        string
	Status       FeedbackStatus
	IssueURL     string
	CreatedAt    time.Time

	AppliedAt          *time.Time
	VerifiedAt         *time.Time
	ResolvedAt         *time.Time
	VerificationResult string
	VerificationDetail string

	Replay     []byte
	ReplaySize int
}

// URLSummary is a lightweight projection returned for badge rendering.
type URLSummary struct {
	Selector string
	Count    int64
	// IDs of the individual feedback items behind this badge.
	IDs []int64
}

// CreateParams holds the data required to create a feedback item.
type CreateParams struct {
	URL         string
	Selector    string
	Comment     string
	ContextJSON string
	Screenshot  []byte
	Snapshot    []byte
	Replay      []byte
	GitHubUser  string
	Repo        string
	Label       string
}

// Create inserts a new feedback item and returns it with the generated ID and
// timestamp. It also records a "created" lifecycle event so new items surface
// in feedback_watch / ListEventsSince.
func (s *Store) Create(ctx context.Context, p CreateParams) (Feedback, error) {
	label := p.Label
	if label == "" {
		label = "feedback"
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Feedback{}, err
	}
	defer tx.Rollback() //nolint:errcheck

	const q = `
INSERT INTO feedback (url, selector, comment, context_json, screenshot, github_user, repo, label, snapshot, snapshot_size, replay, replay_size)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
RETURNING id, created_at`

	var f Feedback
	var createdAt string
	if err := tx.QueryRowContext(ctx, q,
		p.URL, p.Selector, p.Comment, p.ContextJSON, p.Screenshot, p.GitHubUser, p.Repo, label, p.Snapshot, len(p.Snapshot), p.Replay, len(p.Replay),
	).Scan(&f.ID, &createdAt); err != nil {
		return Feedback{}, fmt.Errorf("store: create feedback: %w", err)
	}

	if _, err := tx.ExecContext(ctx, `INSERT INTO feedback_events (feedback_id, type, actor, detail) VALUES (?, 'created', ?, '')`, f.ID, p.GitHubUser); err != nil {
		return Feedback{}, fmt.Errorf("store: create event: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return Feedback{}, err
	}

	f.URL = p.URL
	f.Selector = p.Selector
	f.Comment = p.Comment
	f.ContextJSON = p.ContextJSON
	f.Screenshot = p.Screenshot
	f.Snapshot = p.Snapshot
	f.SnapshotSize = len(p.Snapshot)
	f.Replay = p.Replay
	f.ReplaySize = len(p.Replay)
	f.GitHubUser = p.GitHubUser
	f.Repo = p.Repo
	f.Label = label
	f.Status = StatusOpen
	f.CreatedAt, _ = time.Parse(time.RFC3339, createdAt)
	return f, nil
}

// Get returns a single feedback item by ID.
func (s *Store) Get(ctx context.Context, id int64) (Feedback, error) {
	const q = `
SELECT id, url, selector, comment, context_json, screenshot, github_user, repo, label, status, COALESCE(issue_url,''), created_at,
       COALESCE(snapshot_size,0), snapshot,
       COALESCE(applied_at,''), COALESCE(verified_at,''), COALESCE(resolved_at,''),
       COALESCE(verification_result,''), COALESCE(verification_detail,''),
       COALESCE(replay_size,0), replay
FROM feedback WHERE id = ?`

	var f Feedback
	var createdAt, appliedAt, verifiedAt, resolvedAt string
	err := s.db.QueryRowContext(ctx, q, id).Scan(
		&f.ID, &f.URL, &f.Selector, &f.Comment, &f.ContextJSON,
		&f.Screenshot, &f.GitHubUser, &f.Repo, &f.Label, &f.Status, &f.IssueURL, &createdAt,
		&f.SnapshotSize, &f.Snapshot,
		&appliedAt, &verifiedAt, &resolvedAt,
		&f.VerificationResult, &f.VerificationDetail,
		&f.ReplaySize, &f.Replay,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return Feedback{}, fmt.Errorf("store: feedback %d not found", id)
	}
	if err != nil {
		return Feedback{}, fmt.Errorf("store: get feedback: %w", err)
	}
	f.CreatedAt, _ = time.Parse(time.RFC3339, createdAt)
	f.AppliedAt = optionalTime(appliedAt)
	f.VerifiedAt = optionalTime(verifiedAt)
	f.ResolvedAt = optionalTime(resolvedAt)
	return f, nil
}

// ListByURL returns all open feedback items for a given page URL, newest first.
func (s *Store) ListByURL(ctx context.Context, url string) ([]Feedback, error) {
	const q = `
SELECT id, url, selector, comment, context_json, COALESCE(length(screenshot), 0), github_user, repo, label, status, COALESCE(issue_url,''), created_at
FROM feedback WHERE url = ? AND status = 'open'
ORDER BY created_at DESC`

	rows, err := s.db.QueryContext(ctx, q, url)
	if err != nil {
		return nil, fmt.Errorf("store: list by url: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var items []Feedback
	for rows.Next() {
		var f Feedback
		var createdAt string
		var screenshotLen int
		if err := rows.Scan(
			&f.ID, &f.URL, &f.Selector, &f.Comment, &f.ContextJSON,
			&screenshotLen, &f.GitHubUser, &f.Repo, &f.Label, &f.Status, &f.IssueURL, &createdAt,
		); err != nil {
			return nil, fmt.Errorf("store: scan feedback: %w", err)
		}
		f.CreatedAt, _ = time.Parse(time.RFC3339, createdAt)
		items = append(items, f)
	}
	return items, rows.Err()
}

// ListByURLSummary returns per-selector badge counts for a given page URL.
func (s *Store) ListByURLSummary(ctx context.Context, url string) ([]URLSummary, error) {
	const q = `
SELECT selector, COUNT(*) as cnt, GROUP_CONCAT(id) as ids
FROM feedback WHERE url = ? AND status = 'open'
GROUP BY selector
ORDER BY selector`

	rows, err := s.db.QueryContext(ctx, q, url)
	if err != nil {
		return nil, fmt.Errorf("store: summary by url: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var summaries []URLSummary
	for rows.Next() {
		var s URLSummary
		var idList string
		if err := rows.Scan(&s.Selector, &s.Count, &idList); err != nil {
			return nil, err
		}
		// Parse comma-separated IDs.
		var ids []int64
		for _, part := range splitCSV(idList) {
			var id int64
			if _, err := fmt.Sscanf(part, "%d", &id); err == nil {
				ids = append(ids, id)
			}
		}
		s.IDs = ids
		summaries = append(summaries, s)
	}
	return summaries, rows.Err()
}

// ListExported returns exported feedback items (issue_url set) whose repo is
// in the given list, newest first, capped.
func (s *Store) ListExported(ctx context.Context, repos []string) ([]Feedback, error) {
	if len(repos) == 0 {
		return nil, nil
	}
	ph := strings.TrimSuffix(strings.Repeat("?,", len(repos)), ",")
	args := make([]any, 0, len(repos))
	for _, r := range repos {
		args = append(args, r)
	}
	q := fmt.Sprintf(`
SELECT id, url, selector, comment, repo, label, status, COALESCE(issue_url,''), created_at
FROM feedback
WHERE issue_url != '' AND repo IN (%s)
ORDER BY id DESC LIMIT 500`, ph)
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("store: list exported: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var out []Feedback
	for rows.Next() {
		var f Feedback
		var createdAt string
		if err := rows.Scan(&f.ID, &f.URL, &f.Selector, &f.Comment, &f.Repo, &f.Label, &f.Status, &f.IssueURL, &createdAt); err != nil {
			return nil, fmt.Errorf("store: scan exported: %w", err)
		}
		f.CreatedAt, _ = time.Parse(time.RFC3339, createdAt)
		out = append(out, f)
	}
	return out, rows.Err()
}

// Delete removes a feedback item by ID. Returns an error if the item doesn't
// belong to the given githubUser.
func (s *Store) Delete(ctx context.Context, id int64, githubUser string) error {
	const q = `DELETE FROM feedback WHERE id = ? AND github_user = ?`
	res, err := s.db.ExecContext(ctx, q, id, githubUser)
	if err != nil {
		return fmt.Errorf("store: delete feedback: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("store: feedback %d not found or not owned by %s", id, githubUser)
	}
	return nil
}

// MarkExported sets issue_url and status='exported' for the given IDs.
func (s *Store) MarkExported(ctx context.Context, ids []int64, issueURL string) error {
	if len(ids) == 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck
	const q = `UPDATE feedback SET issue_url = ?, status = ? WHERE id = ?`
	for _, id := range ids {
		if _, err := tx.ExecContext(ctx, q, issueURL, StatusExported, id); err != nil {
			return fmt.Errorf("store: mark exported %d: %w", id, err)
		}
	}
	return tx.Commit()
}

// FeedbackEvent is a single lifecycle transition recorded in feedback_events.
type FeedbackEvent struct {
	Seq        int64
	FeedbackID int64
	Type       string
	Actor      string
	Detail     string
	CreatedAt  time.Time
}

// ExportedLite is a lightweight projection of exported feedback — enough to
// render the feedback_list tool without loading screenshot/snapshot blobs.
type ExportedLite struct {
	ID          int64
	Comment     string
	ContextJSON string
	Label       string
	Status      FeedbackStatus
	IssueURL    string
	CreatedAt   time.Time
}

// VerifyPendingItem is a feedback item awaiting verification on a page.
type VerifyPendingItem struct {
	ID          int64
	Selector    string
	ContextJSON string
}

// optionalTime parses an RFC3339 timestamp string into *time.Time (nil if empty).
func optionalTime(s string) *time.Time {
	if s == "" {
		return nil
	}
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return nil
	}
	return &t
}

// SetStatus updates a feedback item's status plus the matching *_at timestamp
// and records a feedback_events row (type applied|verified|resolved|open).
func (s *Store) SetStatus(ctx context.Context, id int64, status FeedbackStatus, actor, detail string) error {
	var tsCol string
	switch status {
	case StatusApplied:
		tsCol = "applied_at"
	case StatusVerified:
		tsCol = "verified_at"
	case StatusResolved:
		tsCol = "resolved_at"
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck

	if tsCol != "" {
		q := fmt.Sprintf(`UPDATE feedback SET status = ?, %s = strftime('%%Y-%%m-%%dT%%H:%%M:%%SZ','now') WHERE id = ?`, tsCol)
		if _, err := tx.ExecContext(ctx, q, status, id); err != nil {
			return fmt.Errorf("store: set status %s: %w", status, err)
		}
	} else {
		if _, err := tx.ExecContext(ctx, `UPDATE feedback SET status = ? WHERE id = ?`, status, id); err != nil {
			return fmt.Errorf("store: set status %s: %w", status, err)
		}
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO feedback_events (feedback_id, type, actor, detail) VALUES (?, ?, ?, ?)`, id, string(status), actor, detail); err != nil {
		return fmt.Errorf("store: insert event: %w", err)
	}
	return tx.Commit()
}

// SetVerificationResult records a verification outcome and sets verified_at.
// It does NOT emit an event: event emission is owned by SetStatus, so a green
// transition (SetVerificationResult + SetStatus(verified)) produces exactly one
// "verified" event.
func (s *Store) SetVerificationResult(ctx context.Context, id int64, result, detail string) error {
	if _, err := s.db.ExecContext(ctx, `UPDATE feedback SET verification_result = ?, verification_detail = ?, verified_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`, result, detail, id); err != nil {
		return fmt.Errorf("store: set verification result: %w", err)
	}
	return nil
}

// ListEventsSince returns lifecycle events with seq > sinceSeq, ascending.
func (s *Store) ListEventsSince(ctx context.Context, sinceSeq int64, limit int) ([]FeedbackEvent, error) {
	return s.listEvents(ctx, sinceSeq, limit, nil)
}

// ListEventsSinceForRepos is ListEventsSince restricted to feedback whose repo
// is in repos (used to scope feedback_watch to an API key).
func (s *Store) ListEventsSinceForRepos(ctx context.Context, sinceSeq int64, limit int, repos []string) ([]FeedbackEvent, error) {
	return s.listEvents(ctx, sinceSeq, limit, repos)
}

func (s *Store) listEvents(ctx context.Context, sinceSeq int64, limit int, repos []string) ([]FeedbackEvent, error) {
	if limit <= 0 {
		limit = 100
	}
	q := `SELECT e.seq, e.feedback_id, e.type, COALESCE(e.actor,''), COALESCE(e.detail,''), e.created_at
FROM feedback_events e`
	args := make([]any, 0, len(repos)+2)
	if len(repos) > 0 {
		ph := strings.TrimSuffix(strings.Repeat("?,", len(repos)), ",")
		q += fmt.Sprintf(` JOIN feedback f ON f.id = e.feedback_id WHERE e.seq > ? AND f.repo IN (%s)`, ph)
		args = append(args, sinceSeq)
		for _, r := range repos {
			args = append(args, r)
		}
	} else {
		q += ` WHERE e.seq > ?`
		args = append(args, sinceSeq)
	}
	q += ` ORDER BY e.seq ASC LIMIT ?`
	args = append(args, limit)

	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("store: list events: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var out []FeedbackEvent
	for rows.Next() {
		var e FeedbackEvent
		var createdAt string
		if err := rows.Scan(&e.Seq, &e.FeedbackID, &e.Type, &e.Actor, &e.Detail, &createdAt); err != nil {
			return nil, fmt.Errorf("store: scan event: %w", err)
		}
		e.CreatedAt, _ = time.Parse(time.RFC3339, createdAt)
		out = append(out, e)
	}
	return out, rows.Err()
}

// ListExportedLite returns exported feedback (issue_url set) within repos,
// without loading screenshot/snapshot blobs.
func (s *Store) ListExportedLite(ctx context.Context, repos []string) ([]ExportedLite, error) {
	if len(repos) == 0 {
		return nil, nil
	}
	ph := strings.TrimSuffix(strings.Repeat("?,", len(repos)), ",")
	args := make([]any, 0, len(repos))
	for _, r := range repos {
		args = append(args, r)
	}
	q := fmt.Sprintf(`
SELECT id, comment, context_json, label, status, COALESCE(issue_url,''), created_at
FROM feedback
WHERE issue_url != '' AND repo IN (%s)
ORDER BY id DESC LIMIT 500`, ph)
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("store: list exported lite: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var out []ExportedLite
	for rows.Next() {
		var e ExportedLite
		var createdAt string
		if err := rows.Scan(&e.ID, &e.Comment, &e.ContextJSON, &e.Label, &e.Status, &e.IssueURL, &createdAt); err != nil {
			return nil, fmt.Errorf("store: scan exported lite: %w", err)
		}
		e.CreatedAt, _ = time.Parse(time.RFC3339, createdAt)
		out = append(out, e)
	}
	return out, rows.Err()
}

// ListVerifyPending returns items on a URL that are open or applied and have
// no green verification result yet.
func (s *Store) ListVerifyPending(ctx context.Context, url string) ([]VerifyPendingItem, error) {
	const q = `
SELECT id, selector, context_json
FROM feedback
WHERE url = ? AND status IN ('open','applied')
  AND (verification_result IS NULL OR verification_result != 'green')
ORDER BY created_at DESC`
	rows, err := s.db.QueryContext(ctx, q, url)
	if err != nil {
		return nil, fmt.Errorf("store: list verify pending: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var out []VerifyPendingItem
	for rows.Next() {
		var v VerifyPendingItem
		if err := rows.Scan(&v.ID, &v.Selector, &v.ContextJSON); err != nil {
			return nil, fmt.Errorf("store: scan verify pending: %w", err)
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func splitCSV(s string) []string {
	if s == "" {
		return nil
	}
	var out []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == ',' {
			out = append(out, s[start:i])
			start = i + 1
		}
	}
	out = append(out, s[start:])
	return out
}
