package handler

import (
	"bytes"
	"compress/gzip"
	"errors"
	"io"
)

// maxDecompressedBytes bounds the decompressed replay size (~20MB) to prevent
// a zip-bomb style decompression DoS.
const maxDecompressedBytes = 20 * 1024 * 1024

// errReplayTooLarge signals a decompressed replay exceeding the size cap.
var errReplayTooLarge = errors.New("replay too large")

// decodeSnapshot decompresses a gzipped snapshot blob.
func decodeSnapshot(b []byte) ([]byte, error) {
	gr, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	defer func() { _ = gr.Close() }()
	return io.ReadAll(gr)
}

// gunzipOrRaw decompresses a gzipped blob, returning the raw bytes unchanged if
// the blob is not gzip (defensive for legacy/corrupt replay data). Decompression
// is capped at maxDecompressedBytes; beyond it an error is returned.
func gunzipOrRaw(b []byte) ([]byte, error) {
	gr, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		return b, nil
	}
	defer func() { _ = gr.Close() }()
	out, err := io.ReadAll(io.LimitReader(gr, maxDecompressedBytes+1))
	if err != nil {
		return b, nil
	}
	if len(out) > maxDecompressedBytes {
		return nil, errReplayTooLarge
	}
	return out, nil
}
