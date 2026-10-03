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

func TestGunzipOrRawRejectsOversize(t *testing.T) {
	// ~20MB + 1 of data compresses tiny, so this exercises the decompression cap
	// rather than the (already capped) compressed-size path.
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	big := make([]byte, maxDecompressedBytes+1)
	if _, err := gw.Write(big); err != nil {
		t.Fatalf("gzip write: %v", err)
	}
	if err := gw.Close(); err != nil {
		t.Fatalf("gzip close: %v", err)
	}

	_, err := gunzipOrRaw(buf.Bytes())
	if !errors.Is(err, errReplayTooLarge) {
		t.Fatalf("expected errReplayTooLarge, got %v", err)
	}
}

func TestGunzipOrRawPassthroughNonGzip(t *testing.T) {
	raw := []byte("not gzip data")
	got, err := gunzipOrRaw(raw)
	if err != nil {
		t.Fatalf("non-gzip should not error: %v", err)
	}
	if !bytes.Equal(got, raw) {
		t.Fatalf("non-gzip passthrough = %q, want %q", got, raw)
	}
}

func TestGunzipOrRawPropagatesCorruptGzip(t *testing.T) {
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	if _, err := gw.Write([]byte(`[{"type":2}]`)); err != nil {
		t.Fatalf("gzip write: %v", err)
	}
	if err := gw.Close(); err != nil {
		t.Fatalf("gzip close: %v", err)
	}
	full := buf.Bytes()

	// Truncate the trailer (and a little stream) so the gzip header is accepted
	// but the body read fails — this must return an error, not the raw bytes.
	for _, cut := range []int{8, 10} {
		corrupt := full[:len(full)-cut]
		if _, err := gunzipOrRaw(corrupt); err == nil {
			t.Fatalf("corrupt gzip (cut %d) should return an error, got nil", cut)
		}
	}
}
