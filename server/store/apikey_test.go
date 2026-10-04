package store

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
)

func TestCreateAndLookupAPIKey(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test.db")
	s, err := OpenSQLite(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = s.Close() }()

	ctx := context.Background()
	id, err := s.CreateAPIKey(ctx, "alice", "hash123", []string{"org/repo-a", "org/repo-b"})
	if err != nil {
		t.Fatalf("CreateAPIKey: %v", err)
	}
	if id == 0 {
		t.Fatal("expected non-zero key id")
	}

	repos, err := s.LookupAPIKeyScopes(ctx, "hash123")
	if err != nil {
		t.Fatalf("LookupAPIKeyScopes: %v", err)
	}
	if len(repos) != 2 || repos[0] != "org/repo-a" || repos[1] != "org/repo-b" {
		t.Fatalf("repos = %v, want [org/repo-a org/repo-b]", repos)
	}

	// Unknown hash -> ErrKeyNotFound.
	if _, err := s.LookupAPIKeyScopes(ctx, "nope"); !errors.Is(err, ErrKeyNotFound) {
		t.Fatalf("expected ErrKeyNotFound, got %v", err)
	}

	// Revoke -> lookup fails.
	if err := s.RevokeAPIKey(ctx, id, "alice"); err != nil {
		t.Fatalf("RevokeAPIKey: %v", err)
	}
	if _, err := s.LookupAPIKeyScopes(ctx, "hash123"); !errors.Is(err, ErrKeyNotFound) {
		t.Fatalf("expected ErrKeyNotFound after revoke, got %v", err)
	}
}

func TestRevokeAPIKeyNotOwned(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test.db")
	s, err := OpenSQLite(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = s.Close() }()

	ctx := context.Background()
	id, err := s.CreateAPIKey(ctx, "alice", "hash456", []string{"org/repo-a"})
	if err != nil {
		t.Fatalf("CreateAPIKey: %v", err)
	}
	if err := s.RevokeAPIKey(ctx, id, "bob"); !errors.Is(err, ErrKeyNotFound) {
		t.Fatalf("expected ErrKeyNotFound for non-owner, got %v", err)
	}
}
