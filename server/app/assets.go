package app

import (
	"embed"
	"io/fs"
)

//go:embed static/emergent-feedback.js static/emergent-feedback-replay.js
var staticFiles embed.FS

//go:embed schema/envelope.v1.json
var envelopeSchemaJSON []byte

// DefaultStaticFS returns the embedded client bundles.
func DefaultStaticFS() fs.FS {
	sub, err := fs.Sub(staticFiles, "static")
	if err != nil {
		panic(err) // go:embed guarantees this path exists
	}
	return sub
}

// DefaultEnvelopeSchema returns a copy of the embedded envelope JSON Schema.
func DefaultEnvelopeSchema() []byte {
	out := make([]byte, len(envelopeSchemaJSON))
	copy(out, envelopeSchemaJSON)
	return out
}
