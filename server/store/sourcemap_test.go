package store

import (
	"context"
	"testing"
)

func TestGetSourcemapSuffixFallback(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()

	content := []byte(`{"version":3,"file":"bundle.js","sources":["src/App.tsx"],"names":[],"mappings":"AAAA"}`)
	// CI upload keyed by full asset path.
	if err := s.UpsertSourcemap(ctx, "org/repo", "1.0.0", "dist/assets/bundle.js.map", content); err != nil {
		t.Fatalf("UpsertSourcemap: %v", err)
	}

	// Exact path resolves.
	got, err := s.GetSourcemap(ctx, "org/repo", "1.0.0", "dist/assets/bundle.js.map")
	if err != nil {
		t.Fatalf("exact lookup: %v", err)
	}
	if string(got) != string(content) {
		t.Fatalf("exact content = %q, want %q", got, content)
	}

	// Basename probe resolves via suffix fallback.
	got, err = s.GetSourcemap(ctx, "org/repo", "1.0.0", "bundle.js.map")
	if err != nil {
		t.Fatalf("suffix lookup: %v", err)
	}
	if string(got) != string(content) {
		t.Fatalf("suffix content = %q, want %q", got, content)
	}

	// Unrelated basename misses.
	if _, err := s.GetSourcemap(ctx, "org/repo", "1.0.0", "other.js.map"); err == nil {
		t.Fatal("expected not-found for unrelated basename")
	}
}
