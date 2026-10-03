package handler

import (
	"bytes"
	"compress/gzip"
	"errors"
	"testing"
)

func TestDecodeSnapshotRoundTrip(t *testing.T) {
	original := "<html><body>redacted snapshot</body></html>"

	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	if _, err := gw.Write([]byte(original)); err != nil {
		t.Fatalf("gzip write: %v", err)
	}
	if err := gw.Close(); err != nil {
		t.Fatalf("gzip close: %v", err)
	}

	got, err := decodeSnapshot(buf.Bytes())
	if err != nil {
		t.Fatalf("decodeSnapshot: %v", err)
	}
	if string(got) != original {
		t.Fatalf("decoded = %q, want %q", string(got), original)
	}
}

func TestDecodeSnapshotInvalid(t *testing.T) {
	if _, err := decodeSnapshot([]byte("not gzip")); err == nil {
		t.Fatal("expected error for non-gzip input, got nil")
	}
}

func TestDecodeSnapshotRejectsOversize(t *testing.T) {
	// ~20MB + 1 of data compresses tiny, exercising the decompression cap.
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	big := make([]byte, maxDecompressedBytes+1)
	if _, err := gw.Write(big); err != nil {
		t.Fatalf("gzip write: %v", err)
	}
	if err := gw.Close(); err != nil {
		t.Fatalf("gzip close: %v", err)
	}

	_, err := decodeSnapshot(buf.Bytes())
	if !errors.Is(err, errSnapshotTooLarge) {
		t.Fatalf("expected errSnapshotTooLarge, got %v", err)
	}
}
