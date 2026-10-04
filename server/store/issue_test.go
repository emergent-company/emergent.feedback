package store

import (
	"context"
	"path/filepath"
	"testing"
)

func TestGetGitHubIssueByNumber(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test.db")
	s, err := OpenSQLite(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = s.Close() }()

	ctx := context.Background()
	if err := s.CreateGitHubIssue(ctx, GitHubIssue{
		IssueNumber: 7,
		IssueURL:    "https://github.com/org/repo/issues/7",
		Repo:        "org/repo",
		Title:       "Feedback on button",
		PageURL:     "https://app.example.com/",
		Selector:    "div",
		FeedbackIDs: "[1,2]",
	}); err != nil {
		t.Fatalf("CreateGitHubIssue: %v", err)
	}

	gi, err := s.GetGitHubIssueByNumber(ctx, 7)
	if err != nil {
		t.Fatalf("GetGitHubIssueByNumber: %v", err)
	}
	if gi.IssueNumber != 7 {
		t.Fatalf("issue number = %d, want 7", gi.IssueNumber)
	}
	if gi.FeedbackIDs != "[1,2]" {
		t.Fatalf("feedback_ids = %q, want %q", gi.FeedbackIDs, "[1,2]")
	}

	// Missing issue must return an error.
	if _, err := s.GetGitHubIssueByNumber(ctx, 999); err == nil {
		t.Fatal("expected error for missing issue, got nil")
	}
}
