package store

import (
	"context"
	"path/filepath"
	"reflect"
	"testing"
)

func TestSplitCSV(t *testing.T) {
	if got := splitCSV(""); got != nil {
		t.Fatalf("empty = %v, want nil", got)
	}
	if got := splitCSV("1,2,3"); !reflect.DeepEqual(got, []string{"1", "2", "3"}) {
		t.Fatalf("splitCSV(1,2,3) = %v", got)
	}
	if got := splitCSV("42"); !reflect.DeepEqual(got, []string{"42"}) {
		t.Fatalf("splitCSV(42) = %v", got)
	}
}

func openTestStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func createTestFeedback(t *testing.T, s *Store, ctx context.Context) Feedback {
	t.Helper()
	f, err := s.Create(ctx, CreateParams{
		URL:         "https://app.example.com/",
		Selector:    "button",
		Comment:     "broken",
		ContextJSON: `{"source":{"confidence":"exact"}}`,
		GitHubUser:  "alice",
		Repo:        "org/repo",
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	return f
}

func TestCreateEmitsCreatedEvent(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	f := createTestFeedback(t, s, ctx)

	events, err := s.ListEventsSince(ctx, 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 {
		t.Fatalf("events = %d, want 1", len(events))
	}
	if events[0].Type != "created" {
		t.Fatalf("event type = %q, want created", events[0].Type)
	}
	if events[0].FeedbackID != f.ID {
		t.Fatalf("event feedback = %d, want %d", events[0].FeedbackID, f.ID)
	}
	if events[0].Actor != "alice" {
		t.Fatalf("event actor = %q, want alice", events[0].Actor)
	}
}

func TestSetStatusAndEvents(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	f := createTestFeedback(t, s, ctx)

	if err := s.SetStatus(ctx, f.ID, StatusApplied, "alice", "fixed it"); err != nil {
		t.Fatalf("SetStatus applied: %v", err)
	}
	if err := s.SetStatus(ctx, f.ID, StatusVerified, "alice", ""); err != nil {
		t.Fatalf("SetStatus verified: %v", err)
	}
	if err := s.SetStatus(ctx, f.ID, StatusResolved, "alice", "done"); err != nil {
		t.Fatalf("SetStatus resolved: %v", err)
	}

	got, err := s.Get(ctx, f.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != StatusResolved {
		t.Fatalf("status = %s, want resolved", got.Status)
	}
	if got.AppliedAt == nil || got.VerifiedAt == nil || got.ResolvedAt == nil {
		t.Fatalf("timestamps not set: applied=%v verified=%v resolved=%v", got.AppliedAt, got.VerifiedAt, got.ResolvedAt)
	}

	events, err := s.ListEventsSince(ctx, 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 4 {
		t.Fatalf("events = %d, want 4", len(events))
	}
	wantTypes := []string{"created", "applied", "verified", "resolved"}
	for i, e := range events {
		if e.Type != wantTypes[i] {
			t.Fatalf("event %d type = %s, want %s", i, e.Type, wantTypes[i])
		}
		if e.FeedbackID != f.ID {
			t.Fatalf("event %d feedback = %d, want %d", i, e.FeedbackID, f.ID)
		}
		if i > 0 && events[i-1].Seq >= e.Seq {
			t.Fatalf("events not ascending: %v", events)
		}
	}

	after, err := s.ListEventsSince(ctx, events[0].Seq, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != 3 {
		t.Fatalf("resume events = %d, want 3", len(after))
	}
}

func TestGreenSingleVerifiedEvent(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	f := createTestFeedback(t, s, ctx)

	// SetVerificationResult records the outcome but emits no event.
	if err := s.SetVerificationResult(ctx, f.ID, "green", "passed"); err != nil {
		t.Fatalf("SetVerificationResult: %v", err)
	}

	got, err := s.Get(ctx, f.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.VerificationResult != "green" {
		t.Fatalf("verification_result = %q", got.VerificationResult)
	}
	if got.VerificationDetail != "passed" {
		t.Fatalf("verification_detail = %q", got.VerificationDetail)
	}
	if got.VerifiedAt == nil {
		t.Fatal("verified_at not set")
	}

	events, err := s.ListEventsSince(ctx, 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].Type != "created" {
		t.Fatalf("SetVerificationResult should not emit an event; events = %v", events)
	}

	// Green transition via SetStatus emits exactly one "verified" event.
	if err := s.SetStatus(ctx, f.ID, StatusVerified, "alice", ""); err != nil {
		t.Fatalf("SetStatus verified: %v", err)
	}
	events, err = s.ListEventsSince(ctx, 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	verifiedCount := 0
	for _, e := range events {
		if e.Type == "verified" {
			verifiedCount++
		}
	}
	if verifiedCount != 1 {
		t.Fatalf("verified events = %d, want exactly 1: %v", verifiedCount, events)
	}
}

func TestGreenPathIdempotent(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	f := createTestFeedback(t, s, ctx)

	// The green path = SetVerificationResult(green) + SetStatus(verified).
	green := func() {
		t.Helper()
		if err := s.SetVerificationResult(ctx, f.ID, "green", "passed"); err != nil {
			t.Fatalf("SetVerificationResult: %v", err)
		}
		if err := s.SetStatus(ctx, f.ID, StatusVerified, "alice", ""); err != nil {
			t.Fatalf("SetStatus verified: %v", err)
		}
	}

	green()
	first, err := s.Get(ctx, f.ID)
	if err != nil {
		t.Fatal(err)
	}
	if first.VerifiedAt == nil {
		t.Fatal("verified_at not set after first green")
	}

	// A second green (concurrent verify tab) must not churn verified_at or add
	// another "verified" event.
	green()
	second, err := s.Get(ctx, f.ID)
	if err != nil {
		t.Fatal(err)
	}
	if second.VerifiedAt == nil {
		t.Fatal("verified_at nil after second green")
	}
	if !first.VerifiedAt.Equal(*second.VerifiedAt) {
		t.Fatalf("verified_at churned: %v -> %v", first.VerifiedAt, second.VerifiedAt)
	}

	events, err := s.ListEventsSince(ctx, 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	verifiedCount := 0
	for _, e := range events {
		if e.Type == "verified" {
			verifiedCount++
		}
	}
	if verifiedCount != 1 {
		t.Fatalf("verified events = %d, want exactly 1: %v", verifiedCount, events)
	}
}

func TestSetStatusRejectsBackwardTransition(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	f := createTestFeedback(t, s, ctx)

	for _, st := range []FeedbackStatus{StatusApplied, StatusVerified, StatusResolved} {
		if err := s.SetStatus(ctx, f.ID, st, "alice", ""); err != nil {
			t.Fatalf("SetStatus %s: %v", st, err)
		}
	}

	// Backward moves must be rejected and leave the status unchanged.
	for _, st := range []FeedbackStatus{StatusApplied, StatusVerified} {
		if err := s.SetStatus(ctx, f.ID, st, "alice", ""); err == nil {
			t.Fatalf("expected backward transition resolved->%s to be rejected", st)
		}
	}
	got, err := s.Get(ctx, f.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != StatusResolved {
		t.Fatalf("status = %s, want resolved (backward move must not apply)", got.Status)
	}
}

func TestExportedExcludedFromBadges(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()

	// Three items on the same URL: open (badge), exported (excluded), resolved (excluded).
	openF := createTestFeedback(t, s, ctx)
	expF := createTestFeedback(t, s, ctx)
	if err := s.MarkExported(ctx, []int64{expF.ID}, "https://github.com/org/repo/issues/2"); err != nil {
		t.Fatalf("MarkExported: %v", err)
	}
	resF := createTestFeedback(t, s, ctx)
	if err := s.SetStatus(ctx, resF.ID, StatusResolved, "alice", ""); err != nil {
		t.Fatalf("SetStatus resolved: %v", err)
	}

	summaries, err := s.ListByURLSummary(ctx, "https://app.example.com/")
	if err != nil {
		t.Fatal(err)
	}
	var ids []int64
	for _, sm := range summaries {
		ids = append(ids, sm.IDs...)
	}
	contains := func(list []int64, id int64) bool {
		for _, x := range list {
			if x == id {
				return true
			}
		}
		return false
	}
	if !contains(ids, openF.ID) {
		t.Fatalf("open item %d missing from badges", openF.ID)
	}
	if contains(ids, expF.ID) {
		t.Fatalf("exported item %d should not appear in badges", expF.ID)
	}
	if contains(ids, resF.ID) {
		t.Fatalf("resolved item %d should not appear in badges", resF.ID)
	}

	// Genuinely resolved item is resolved, not exported.
	got, err := s.Get(ctx, resF.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != StatusResolved {
		t.Fatalf("resolved status = %s, want resolved", got.Status)
	}
	gotE, err := s.Get(ctx, expF.ID)
	if err != nil {
		t.Fatal(err)
	}
	if gotE.Status != StatusExported {
		t.Fatalf("exported status = %s, want exported", gotE.Status)
	}
}

func TestDedupeDuplicateLink(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()

	key := "deadbeef-key"
	f1, err := s.Create(ctx, CreateParams{URL: "https://app.example.com/", Selector: "button", Comment: "broken", GitHubUser: "alice", Repo: "org/repo", DedupeKey: key})
	if err != nil {
		t.Fatalf("Create first: %v", err)
	}
	if f1.DuplicateOf != 0 {
		t.Fatalf("first item should not be a duplicate, got %d", f1.DuplicateOf)
	}

	f2, err := s.Create(ctx, CreateParams{URL: "https://app.example.com/", Selector: "button", Comment: "broken", GitHubUser: "bob", Repo: "org/repo", DedupeKey: key})
	if err != nil {
		t.Fatalf("Create duplicate: %v", err)
	}
	if f2.DuplicateOf != f1.ID {
		t.Fatalf("duplicate_of = %d, want %d", f2.DuplicateOf, f1.ID)
	}

	events, err := s.ListEventsSince(ctx, 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	dupCount := 0
	for _, e := range events {
		if e.Type == "duplicate" {
			dupCount++
		}
	}
	if dupCount != 1 {
		t.Fatalf("duplicate events = %d, want 1", dupCount)
	}

	got, err := s.Get(ctx, f2.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.PossibleDuplicates) != 1 || got.PossibleDuplicates[0] != f1.ID {
		t.Fatalf("possible_duplicates = %v, want [%d]", got.PossibleDuplicates, f1.ID)
	}
}

func TestListLiteAllStatusesAndFilter(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()

	openF := createTestFeedback(t, s, ctx)
	appliedF := createTestFeedback(t, s, ctx)
	if err := s.SetStatus(ctx, appliedF.ID, StatusApplied, "alice", ""); err != nil {
		t.Fatalf("SetStatus applied: %v", err)
	}

	// nil status = all.
	all, err := s.ListLite(ctx, []string{"org/repo"}, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 2 {
		t.Fatalf("all = %d, want 2", len(all))
	}

	// status filter narrows.
	applied, err := s.ListLite(ctx, []string{"org/repo"}, string(StatusApplied))
	if err != nil {
		t.Fatal(err)
	}
	if len(applied) != 1 || applied[0].ID != appliedF.ID {
		t.Fatalf("applied = %v, want only id %d", applied, appliedF.ID)
	}

	// open-only filter excludes the applied item and includes the open one.
	open, err := s.ListLite(ctx, []string{"org/repo"}, string(StatusOpen))
	if err != nil {
		t.Fatal(err)
	}
	if len(open) != 1 || open[0].ID != openF.ID {
		t.Fatalf("open = %v, want only id %d", open, openF.ID)
	}
}

func TestSetContextSummaryNoClobberOnMalformed(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()

	raw := `{"source":{"confidence":"exact"},"intent":{"action":"fix"}`
	f, err := s.Create(ctx, CreateParams{
		URL:         "https://app.example.com/",
		Selector:    "button",
		Comment:     "broken",
		ContextJSON: raw,
		GitHubUser:  "alice",
		Repo:        "org/repo",
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	if err := s.SetContextSummary(ctx, f.ID, "my summary"); err == nil {
		t.Fatal("expected error on malformed context, got nil")
	}

	got, err := s.Get(ctx, f.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.ContextJSON != raw {
		t.Fatalf("context was clobbered:\n got %q\nwant %q", got.ContextJSON, raw)
	}
}

func TestSetContextSummaryPreservesExisting(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()

	raw := `{"source":{"confidence":"exact"},"intent":{"action":"fix"}}`
	f, err := s.Create(ctx, CreateParams{
		URL:         "https://app.example.com/",
		Selector:    "button",
		Comment:     "broken",
		ContextJSON: raw,
		GitHubUser:  "alice",
		Repo:        "org/repo",
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	if err := s.SetContextSummary(ctx, f.ID, "my summary"); err != nil {
		t.Fatalf("SetContextSummary: %v", err)
	}
	got, err := s.Get(ctx, f.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.ContextJSON != `{"intent":{"action":"fix"},"source":{"confidence":"exact"},"summary":"my summary"}` {
		t.Fatalf("unexpected context:\n%s", got.ContextJSON)
	}
}

func TestSetVerificationResultAmberRedNoVerifiedAt(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	f := createTestFeedback(t, s, ctx)

	for _, result := range []string{"amber", "red"} {
		if err := s.SetVerificationResult(ctx, f.ID, result, "still broken"); err != nil {
			t.Fatalf("SetVerificationResult(%s): %v", result, err)
		}
		got, err := s.Get(ctx, f.ID)
		if err != nil {
			t.Fatal(err)
		}
		if got.VerificationResult != result {
			t.Fatalf("verification_result = %q, want %q", got.VerificationResult, result)
		}
		if got.VerifiedAt != nil {
			t.Fatalf("verified_at should be nil for %s, got %v", result, got.VerifiedAt)
		}
	}

	// green still records verified_at.
	if err := s.SetVerificationResult(ctx, f.ID, "green", "passed"); err != nil {
		t.Fatalf("SetVerificationResult(green): %v", err)
	}
	got, err := s.Get(ctx, f.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.VerifiedAt == nil {
		t.Fatal("verified_at not set for green")
	}
}

func TestDeleteCascadesEvents(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	f := createTestFeedback(t, s, ctx)

	// One created event exists before delete.
	events, err := s.ListEventsSince(ctx, 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 {
		t.Fatalf("events before delete = %d, want 1", len(events))
	}

	if err := s.Delete(ctx, f.ID, "alice"); err != nil {
		t.Fatalf("Delete: %v", err)
	}

	events, err = s.ListEventsSince(ctx, 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 0 {
		t.Fatalf("events after delete = %d, want 0 (orphaned events)", len(events))
	}
}

func TestDeleteWrongOwnerPreservesEvents(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	f := createTestFeedback(t, s, ctx)

	if err := s.Delete(ctx, f.ID, "bob"); err == nil {
		t.Fatal("expected error deleting item not owned by bob")
	}

	// The item and its event must remain.
	got, err := s.Get(ctx, f.ID)
	if err != nil {
		t.Fatalf("item should still exist: %v", err)
	}
	if got.ID != f.ID {
		t.Fatalf("id = %d, want %d", got.ID, f.ID)
	}
	events, err := s.ListEventsSince(ctx, 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 {
		t.Fatalf("events = %d, want 1 (event must not be orphaned)", len(events))
	}
}
