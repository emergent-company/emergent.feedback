package handler

import (
	"bytes"
	"compress/gzip"
	"errors"
	"io"
)

// maxDecompressedBytes bounds the decompressed snapshot size (~20MB) to prevent
// a zip-bomb style decompression DoS.
const maxDecompressedBytes = 20 * 1024 * 1024

// errSnapshotTooLarge signals a decompressed snapshot exceeding the size cap.
var errSnapshotTooLarge = errors.New("snapshot too large")

// decodeSnapshot decompresses a gzipped snapshot blob, capping the decompressed
// size at maxDecompressedBytes to prevent zip-bomb style decompression.
func decodeSnapshot(b []byte) ([]byte, error) {
	gr, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	defer func() { _ = gr.Close() }()
	out, err := io.ReadAll(io.LimitReader(gr, maxDecompressedBytes+1))
	if err != nil {
		return nil, err
	}
	if len(out) > maxDecompressedBytes {
		return nil, errSnapshotTooLarge
	}
	return out, nil
}

