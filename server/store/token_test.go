package store

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
)

func TestUpsertAndGetUserToken(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test.db")
	s, err := OpenSQLite(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = s.Close() }()

	ctx := context.Background()
	if err := s.UpsertUserToken(ctx, "alice", []byte("enc-token-1")); err != nil {
		t.Fatalf("UpsertUserToken: %v", err)
	}
	got, err := s.GetUserToken(ctx, "alice")
	if err != nil {
		t.Fatalf("GetUserToken: %v", err)
	}
	if string(got) != "enc-token-1" {
		t.Fatalf("token = %q, want %q", string(got), "enc-token-1")
	}

	// Upsert overwrites.
	if err := s.UpsertUserToken(ctx, "alice", []byte("enc-token-2")); err != nil {
		t.Fatalf("UpsertUserToken (overwrite): %v", err)
	}
	got, err = s.GetUserToken(ctx, "alice")
	if err != nil {
		t.Fatalf("GetUserToken (after overwrite): %v", err)
	}
	if string(got) != "enc-token-2" {
		t.Fatalf("token = %q, want %q", string(got), "enc-token-2")
	}

	// Missing user -> ErrTokenNotFound.
	if _, err := s.GetUserToken(ctx, "bob"); !errors.Is(err, ErrTokenNotFound) {
		t.Fatalf("expected ErrTokenNotFound, got %v", err)
	}
}
