package store

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestMemoryDestinationLifecycle(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()

	d := MemoryDestination{
		Repo:            "org/repo",
		BaseURL:         "https://memory.example.com",
		ProjectID:       "project-1",
		ProjectName:     "Project One",
		TokenEncrypted:  []byte("ciphertext"),
		Scopes:          "graph:read graph:write",
		Mode:            "ask",
		FeedbackBaseURL: "https://feedback.example.com",
		CreatedBy:       "alice",
	}
	if err := s.UpsertMemoryDestination(ctx, d); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	got, err := s.GetMemoryDestination(ctx, "org/repo")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.ProjectID != "project-1" || got.Mode != "ask" || got.CreatedBy != "alice" {
		t.Fatalf("unexpected destination: %+v", got)
	}
	if string(got.TokenEncrypted) != "ciphertext" {
		t.Fatalf("token round-trip failed")
	}

	// Upsert is a replace, not a duplicate.
	d.Mode = "auto"
	d.ProjectName = "Renamed"
	if err := s.UpsertMemoryDestination(ctx, d); err != nil {
		t.Fatalf("upsert 2: %v", err)
	}
	list, err := s.ListMemoryDestinations(ctx)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 1 || list[0].ProjectName != "Renamed" || list[0].Mode != "auto" {
		t.Fatalf("unexpected list: %+v", list)
	}

	if err := s.SetMemoryDestinationMode(ctx, "org/repo", "off"); err != nil {
		t.Fatalf("set mode: %v", err)
	}
	got, _ = s.GetMemoryDestination(ctx, "org/repo")
	if got.Mode != "off" {
		t.Fatalf("mode = %q, want off", got.Mode)
	}

	if err := s.MarkMemoryDestinationSynced(ctx, got.ID); err != nil {
		t.Fatalf("mark synced: %v", err)
	}
	got, _ = s.GetMemoryDestination(ctx, "org/repo")
	if got.LastSyncAt == nil {
		t.Fatal("last_sync_at not set")
	}
	if err := s.SetMemoryDestinationError(ctx, got.ID, "boom"); err != nil {
		t.Fatalf("set error: %v", err)
	}
	got, _ = s.GetMemoryDestination(ctx, "org/repo")
	if got.LastError != "boom" {
		t.Fatalf("last_error = %q", got.LastError)
	}

	byUser, err := s.ListMemoryDestinationsByUser(ctx, "alice")
	if err != nil || len(byUser) != 1 {
		t.Fatalf("by user: %v %+v", err, byUser)
	}
	byUser, err = s.ListMemoryDestinationsByUser(ctx, "bob")
	if err != nil || len(byUser) != 0 {
		t.Fatalf("other user: %v %+v", err, byUser)
	}
}

func TestMemoryDestinationDeleteCascades(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	d := MemoryDestination{Repo: "org/repo", BaseURL: "https://m", ProjectID: "p", TokenEncrypted: []byte("x"), CreatedBy: "alice"}
	if err := s.UpsertMemoryDestination(ctx, d); err != nil {
		t.Fatal(err)
	}
	got, _ := s.GetMemoryDestination(ctx, "org/repo")
	if err := s.UpsertMemoryLink(ctx, MemoryLink{FeedbackID: 1, DestinationID: got.ID, ObjectKey: "ef-1", CanonicalID: "c1"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.EnqueueMemoryOutbox(ctx, MemoryOutboxItem{FeedbackID: 1, DestinationID: got.ID, Op: "upsert", Payload: "{}"}); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteMemoryDestination(ctx, "org/repo"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := s.GetMemoryDestination(ctx, "org/repo"); !errors.Is(err, ErrMemoryDestinationNotFound) {
		t.Fatalf("expected not found, got %v", err)
	}
	items, err := s.ListDueMemoryOutbox(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 0 {
		t.Fatalf("outbox rows left: %+v", items)
	}
}

func TestMemoryOutboxDueAndReschedule(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	d := MemoryDestination{Repo: "org/repo", BaseURL: "https://m", ProjectID: "p", TokenEncrypted: []byte("x"), CreatedBy: "alice"}
	if err := s.UpsertMemoryDestination(ctx, d); err != nil {
		t.Fatal(err)
	}
	got, _ := s.GetMemoryDestination(ctx, "org/repo")

	id, err := s.EnqueueMemoryOutbox(ctx, MemoryOutboxItem{
		FeedbackID: 7, DestinationID: got.ID, Op: "upsert", Payload: `{"type":"Issue"}`,
	})
	if err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	items, err := s.ListDueMemoryOutbox(ctx, 10)
	if err != nil || len(items) != 1 || items[0].ID != id {
		t.Fatalf("due: %v %+v", err, items)
	}

	future := time.Now().UTC().Add(time.Hour)
	if err := s.RescheduleMemoryOutbox(ctx, id, 3, future, "nope"); err != nil {
		t.Fatalf("reschedule: %v", err)
	}
	items, _ = s.ListDueMemoryOutbox(ctx, 10)
	if len(items) != 0 {
		t.Fatalf("future row is due: %+v", items)
	}

	if err := s.DeleteMemoryOutbox(ctx, id); err != nil {
		t.Fatalf("delete: %v", err)
	}
	items, _ = s.ListDueMemoryOutbox(ctx, 10)
	if len(items) != 0 {
		t.Fatalf("row not deleted: %+v", items)
	}
}

func TestMemoryOAuthStateSingleUse(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	st := MemoryOAuthState{
		State:       "state-1",
		Repo:        "org/repo",
		GitHubUser:  "alice",
		BaseURL:     "https://m",
		Verifier:    "verifier",
		RedirectURI: "https://f/oauth/memory/callback",
		ExpiresAt:   time.Now().UTC().Add(time.Minute),
	}
	if err := s.CreateMemoryOAuthState(ctx, st); err != nil {
		t.Fatalf("create: %v", err)
	}
	got, err := s.ConsumeMemoryOAuthState(ctx, "state-1")
	if err != nil {
		t.Fatalf("consume: %v", err)
	}
	if got.Repo != "org/repo" || got.GitHubUser != "alice" {
		t.Fatalf("unexpected state: %+v", got)
	}
	if _, err := s.ConsumeMemoryOAuthState(ctx, "state-1"); !errors.Is(err, ErrMemoryOAuthStateNotFound) {
		t.Fatalf("replay err = %v", err)
	}

	expired := st
	expired.State = "state-2"
	expired.ExpiresAt = time.Now().UTC().Add(-time.Minute)
	if err := s.CreateMemoryOAuthState(ctx, expired); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ConsumeMemoryOAuthState(ctx, "state-2"); !errors.Is(err, ErrMemoryOAuthStateNotFound) {
		t.Fatalf("expired err = %v", err)
	}
}

func TestMemoryOAuthClientUpsert(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	c := MemoryOAuthClient{BaseURL: "https://m", ClientID: "c1", RedirectURI: "https://f/cb"}
	if err := s.UpsertMemoryOAuthClient(ctx, c); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetMemoryOAuthClient(ctx, "https://m", "https://f/cb")
	if err != nil || got.ClientID != "c1" {
		t.Fatalf("get: %v %+v", err, got)
	}
	if _, err := s.GetMemoryOAuthClient(ctx, "https://m", "https://other/cb"); !errors.Is(err, ErrMemoryOAuthClientNotFound) {
		t.Fatalf("other redirect err = %v", err)
	}

	// A second deployment with a different redirect URI keeps its own row.
	c2 := MemoryOAuthClient{BaseURL: "https://m", ClientID: "c2", RedirectURI: "https://other/cb"}
	if err := s.UpsertMemoryOAuthClient(ctx, c2); err != nil {
		t.Fatal(err)
	}
	got, err = s.GetMemoryOAuthClient(ctx, "https://m", "https://f/cb")
	if err != nil || got.ClientID != "c1" {
		t.Fatalf("first client after second upsert: %v %+v", err, got)
	}
	got, err = s.GetMemoryOAuthClient(ctx, "https://m", "https://other/cb")
	if err != nil || got.ClientID != "c2" {
		t.Fatalf("second client: %v %+v", err, got)
	}

	c.ClientID = "c1b"
	if err := s.UpsertMemoryOAuthClient(ctx, c); err != nil {
		t.Fatal(err)
	}
	got, _ = s.GetMemoryOAuthClient(ctx, "https://m", "https://f/cb")
	if got.ClientID != "c1b" {
		t.Fatalf("client id = %q", got.ClientID)
	}
}

func TestCleanupMemoryLinks(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	f, err := s.Create(ctx, CreateParams{
		URL: "https://app/", Selector: "div", Comment: "broken",
		ContextJSON: `{}`, GitHubUser: "alice", Repo: "org/repo",
	})
	if err != nil {
		t.Fatal(err)
	}
	d := MemoryDestination{
		Repo: "org/repo", BaseURL: "https://m", ProjectID: "p1",
		TokenEncrypted: []byte("ciphertext"), CreatedBy: "alice",
	}
	if err := s.UpsertMemoryDestination(ctx, d); err != nil {
		t.Fatal(err)
	}
	d, _ = s.GetMemoryDestination(ctx, "org/repo")
	link := MemoryLink{FeedbackID: f.ID, DestinationID: d.ID, ObjectKey: "ef-x", CanonicalID: "canon1"}
	if err := s.UpsertMemoryLink(ctx, link); err != nil {
		t.Fatal(err)
	}
	outboxID, err := s.EnqueueMemoryOutbox(ctx, MemoryOutboxItem{
		FeedbackID: f.ID, DestinationID: d.ID, Op: "patch", Payload: `{}`,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Delete(ctx, f.ID, "alice"); err != nil {
		t.Fatal(err)
	}

	// A pending writeback keeps the link alive.
	if err := s.CleanupMemoryLinks(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetMemoryLink(ctx, f.ID, d.ID); err != nil {
		t.Fatalf("link removed with pending outbox: %v", err)
	}

	// Once the write drains, the orphaned link is removed.
	if err := s.DeleteMemoryOutbox(ctx, outboxID); err != nil {
		t.Fatal(err)
	}
	if err := s.CleanupMemoryLinks(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetMemoryLink(ctx, f.ID, d.ID); err == nil {
		t.Fatal("orphaned link still present")
	}
}
