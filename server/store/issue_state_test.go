package store

import (
	"context"
	"strconv"
	"testing"
)

func TestListExportedJoinsIssueState(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()

	closed, err := s.Create(ctx, CreateParams{
		URL: "https://app.example.com/a", Selector: "button.a", Comment: "one",
		GitHubUser: "alice", Repo: "org/repo",
	})
	if err != nil {
		t.Fatalf("Create closed: %v", err)
	}
	open, err := s.Create(ctx, CreateParams{
		URL: "https://app.example.com/b", Selector: "button.b", Comment: "two",
		GitHubUser: "alice", Repo: "org/repo",
	})
	if err != nil {
		t.Fatalf("Create open: %v", err)
	}
	// A feedback item in another repo must not appear in the scoped list.
	if _, err := s.Create(ctx, CreateParams{
		URL: "https://app.example.com/c", Selector: "button.c", Comment: "three",
		GitHubUser: "alice", Repo: "other/repo",
	}); err != nil {
		t.Fatalf("Create other: %v", err)
	}

	closedURL := "https://github.com/org/repo/issues/11"
	openURL := "https://github.com/org/repo/issues/12"
	if err := s.MarkExported(ctx, []int64{closed.ID}, closedURL); err != nil {
		t.Fatalf("MarkExported closed: %v", err)
	}
	if err := s.MarkExported(ctx, []int64{open.ID}, openURL); err != nil {
		t.Fatalf("MarkExported open: %v", err)
	}
	if err := s.CreateGitHubIssue(ctx, GitHubIssue{
		IssueNumber: 11, IssueURL: closedURL, Repo: "org/repo", Title: "one",
		PageURL: "https://app.example.com/a", Selector: "button.a",
	}); err != nil {
		t.Fatalf("CreateGitHubIssue closed: %v", err)
	}
	if err := s.CreateGitHubIssue(ctx, GitHubIssue{
		IssueNumber: 12, IssueURL: openURL, Repo: "org/repo", Title: "two",
		PageURL: "https://app.example.com/b", Selector: "button.b",
	}); err != nil {
		t.Fatalf("CreateGitHubIssue open: %v", err)
	}
	if err := s.SetGitHubIssueState(ctx, 11, "org/repo", "closed"); err != nil {
		t.Fatalf("SetGitHubIssueState: %v", err)
	}

	items, err := s.ListExported(ctx, []string{"org/repo"})
	if err != nil {
		t.Fatalf("ListExported: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("ListExported: got %d items, want 2", len(items))
	}
	// Newest first.
	if items[0].ID != open.ID || items[1].ID != closed.ID {
		t.Fatalf("ListExported order: got %d, %d; want %d, %d", items[0].ID, items[1].ID, open.ID, closed.ID)
	}
	if items[0].IssueNumber != 12 || items[0].IssueState != "open" {
		t.Fatalf("open item issue = (%d, %q), want (12, open)", items[0].IssueNumber, items[0].IssueState)
	}
	if items[1].IssueNumber != 11 || items[1].IssueState != "closed" {
		t.Fatalf("closed item issue = (%d, %q), want (11, closed)", items[1].IssueNumber, items[1].IssueState)
	}
}

func TestListExportedSkipsUnlinkedIssueState(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()

	f, err := s.Create(ctx, CreateParams{
		URL: "https://app.example.com/x", Selector: "button.x", Comment: "x",
		GitHubUser: "alice", Repo: "org/repo",
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := s.MarkExported(ctx, []int64{f.ID}, "https://github.com/org/repo/issues/99"); err != nil {
		t.Fatalf("MarkExported: %v", err)
	}

	items, err := s.ListExported(ctx, []string{"org/repo"})
	if err != nil {
		t.Fatalf("ListExported: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("ListExported: got %d items, want 1", len(items))
	}
	if items[0].IssueNumber != 0 || items[0].IssueState != "" {
		t.Fatalf("unlinked issue = (%d, %q), want (0, \"\")", items[0].IssueNumber, items[0].IssueState)
	}
	if items[0].IssueSyncedAt.IsZero() != true {
		t.Fatalf("unlinked synced_at = %v, want zero", items[0].IssueSyncedAt)
	}
}

func TestLatestGitHubIssuesByURL(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()

	for _, n := range []int64{7, 8} {
		if err := s.CreateGitHubIssue(ctx, GitHubIssue{
			IssueNumber: n,
			IssueURL:    "https://github.com/org/repo/issues/" + strconv.FormatInt(n, 10),
			Repo:        "org/repo",
			Title:       "t",
			PageURL:     "https://app.example.com/",
			Selector:    "button",
		}); err != nil {
			t.Fatalf("CreateGitHubIssue %d: %v", n, err)
		}
	}
	if err := s.SetGitHubIssueState(ctx, 7, "org/repo", "closed"); err != nil {
		t.Fatalf("SetGitHubIssueState: %v", err)
	}

	got, err := s.LatestGitHubIssuesByURL(ctx, []string{
		"https://github.com/org/repo/issues/7",
		"https://github.com/org/repo/issues/8",
		"https://github.com/org/repo/issues/404",
	})
	if err != nil {
		t.Fatalf("LatestGitHubIssuesByURL: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d records, want 2", len(got))
	}
	if gi := got["https://github.com/org/repo/issues/7"]; gi.State != "closed" {
		t.Fatalf("issue 7 state = %q, want closed", gi.State)
	}
	if gi := got["https://github.com/org/repo/issues/8"]; gi.State != "open" {
		t.Fatalf("issue 8 state = %q, want open", gi.State)
	}

	empty, err := s.LatestGitHubIssuesByURL(ctx, nil)
	if err != nil {
		t.Fatalf("LatestGitHubIssuesByURL(nil): %v", err)
	}
	if len(empty) != 0 {
		t.Fatalf("nil input returned %d records", len(empty))
	}
}
