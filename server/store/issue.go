package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// GitHubIssue mirrors a GitHub issue linked to a page element.
type GitHubIssue struct {
	ID          int64
	IssueNumber int64
	IssueURL    string
	Repo        string
	Title       string
	PageURL     string
	Selector    string
	FeedbackIDs string
	State       string // "open" | "closed"
	CreatedAt   time.Time
	SyncedAt    time.Time
}

// CreateGitHubIssue inserts a new GitHub issue record. Silently ignores
// duplicates (same issue_number + repo) so re-exports don't fail.
func (s *Store) CreateGitHubIssue(ctx context.Context, p GitHubIssue) error {
	q := `
INSERT INTO github_issues (issue_number, issue_url, repo, title, page_url, selector, state, feedback_ids)
VALUES (?, ?, ?, ?, ?, ?, 'open', ?)
ON CONFLICT DO NOTHING`
	_, err := s.db.ExecContext(ctx, s.bind(q),
		p.IssueNumber, p.IssueURL, p.Repo, p.Title, p.PageURL, p.Selector, p.FeedbackIDs,
	)
	if err != nil {
		return fmt.Errorf("store: create github issue: %w", err)
	}
	return nil
}

// GetGitHubIssueByNumber returns the most recent GitHub issue record for a
// given issue number.
func (s *Store) GetGitHubIssueByNumber(ctx context.Context, issueNumber int64) (GitHubIssue, error) {
	q := `
SELECT id, issue_number, issue_url, repo, title, page_url, selector, state, created_at, synced_at, COALESCE(feedback_ids,'')
FROM github_issues
WHERE issue_number = ?
ORDER BY id DESC LIMIT 1`

	var gi GitHubIssue
	var createdAt, syncedAt string
	err := s.db.QueryRowContext(ctx, s.bind(q), issueNumber).Scan(
		&gi.ID, &gi.IssueNumber, &gi.IssueURL, &gi.Repo, &gi.Title,
		&gi.PageURL, &gi.Selector, &gi.State, &createdAt, &syncedAt, &gi.FeedbackIDs,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return GitHubIssue{}, fmt.Errorf("store: github issue %d not found", issueNumber)
	}
	if err != nil {
		return GitHubIssue{}, fmt.Errorf("store: get github issue by number: %w", err)
	}
	gi.CreatedAt, _ = time.Parse(time.RFC3339, createdAt)
	gi.SyncedAt, _ = time.Parse(time.RFC3339, syncedAt)
	return gi, nil
}

// ListOpenGitHubIssuesByURL returns all open GitHub issues recorded for a page URL.
func (s *Store) ListOpenGitHubIssuesByURL(ctx context.Context, pageURL string) ([]GitHubIssue, error) {
	q := `
SELECT id, issue_number, issue_url, repo, title, page_url, selector, state, created_at, synced_at
FROM github_issues
WHERE page_url = ? AND state = 'open'
ORDER BY issue_number DESC`

	rows, err := s.db.QueryContext(ctx, s.bind(q), pageURL)
	if err != nil {
		return nil, fmt.Errorf("store: list github issues: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var issues []GitHubIssue
	for rows.Next() {
		var gi GitHubIssue
		var createdAt, syncedAt string
		if err := rows.Scan(
			&gi.ID, &gi.IssueNumber, &gi.IssueURL, &gi.Repo, &gi.Title,
			&gi.PageURL, &gi.Selector, &gi.State, &createdAt, &syncedAt,
		); err != nil {
			return nil, fmt.Errorf("store: scan github issue: %w", err)
		}
		gi.CreatedAt, _ = time.Parse(time.RFC3339, createdAt)
		gi.SyncedAt, _ = time.Parse(time.RFC3339, syncedAt)
		issues = append(issues, gi)
	}
	return issues, rows.Err()
}

// SetGitHubIssueState updates the state of a GitHub issue (e.g. "open" → "closed").
func (s *Store) SetGitHubIssueState(ctx context.Context, issueNumber int64, repo, state string) error {
	q := `UPDATE github_issues SET state = ?, synced_at = ` + s.d.nowExpr() + `
WHERE issue_number = ? AND repo = ?`
	_, err := s.db.ExecContext(ctx, s.bind(q), state, issueNumber, repo)
	if err != nil {
		return fmt.Errorf("store: set github issue state: %w", err)
	}
	return nil
}
