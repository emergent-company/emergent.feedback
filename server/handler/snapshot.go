package handler

import (
	"bytes"
	"compress/gzip"
	"io"
)

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
// the blob is not gzip (defensive for legacy/corrupt replay data).
func gunzipOrRaw(b []byte) ([]byte, error) {
	gr, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		return b, nil
	}
	defer func() { _ = gr.Close() }()
	out, err := io.ReadAll(gr)
	if err != nil {
		return b, nil
	}
	return out, nil
}
