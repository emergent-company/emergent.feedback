package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/emergent-company/emergent.feedback/server/app"
	"github.com/emergent-company/emergent.feedback/server/github"
	"github.com/emergent-company/emergent.feedback/server/handler"
	"github.com/emergent-company/emergent.feedback/server/store"
	"github.com/google/jsonschema-go/jsonschema"
)

func TestSchemaRoute(t *testing.T) {
	s, err := store.OpenSQLite(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	defer func() { _ = s.Close() }()

	e, err := app.BuildRouter(app.Options{Store: s, GitHub: &github.AppConfig{}, JWTSecret: "test-secret", AllowedOrigins: "*", MCPAPIKey: "", StaticFS: testStaticFS(t), EnvelopeSchema: envelopeSchemaJSON})
	if err != nil {
		t.Fatalf("BuildRouter: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/schema/envelope.v1.json", nil)
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("content-type = %q, want application/json", ct)
	}
	var doc map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &doc); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if doc["$id"] != "https://feedback.emergent-company.ai/schema/envelope.v1.json" {
		t.Fatalf("$id = %v", doc["$id"])
	}
	if doc["$schema"] != "https://json-schema.org/draft/2020-12/schema" {
		t.Fatalf("$schema = %v", doc["$schema"])
	}
}

func TestSchemaEmbedMatchesDocs(t *testing.T) {
	disk, err := os.ReadFile(filepath.Join("..", "docs", "schema", "envelope.v1.json"))
	if err != nil {
		t.Fatalf("read docs schema: %v", err)
	}
	if string(disk) != string(envelopeSchemaJSON) {
		t.Fatal("embedded schema differs from docs/schema/envelope.v1.json")
	}
}

func TestEnvelopeValidatesAgainstSchema(t *testing.T) {
	var schema jsonschema.Schema
	if err := json.Unmarshal(envelopeSchemaJSON, &schema); err != nil {
		t.Fatalf("parse schema: %v", err)
	}
	resolved, err := schema.Resolve(nil)
	if err != nil {
		t.Fatalf("resolve schema: %v", err)
	}

	ctx := map[string]any{
		"url":            "https://app.example.com/pricing",
		"tagName":        "button",
		"computedStyles": map[string]any{"color": "rgb(1, 2, 3)"},
		"source": map[string]any{
			"component": "Foo", "file": "src/Foo.tsx", "line": 42.0,
			"column": 7.0, "framework": "react", "resolution": "build-stamp",
			"confidence": "exact",
		},
		"intent": map[string]any{
			"kind": "bug", "action": "change", "expected": "be blue",
			"actual": "is red",
			"scope":  map[string]any{"breadth": "element", "targets": []any{"[data-x]"}},
		},
	}
	ctxJSON, _ := json.Marshal(ctx)
	f := store.Feedback{
		ID:          1847,
		URL:         "https://app.example.com/pricing",
		Selector:    "[data-x]",
		Comment:     "c",
		ContextJSON: string(ctxJSON),
		GitHubUser:  "alice",
		Status:      store.StatusOpen,
		CreatedAt:   time.Date(2026, 10, 1, 12, 4, 11, 0, time.UTC),
	}

	for name, env := range map[string]any{
		"full":    handler.BuildEnvelope(f),
		"concise": handler.BuildConciseEnvelope(f),
	} {
		if err := resolved.Validate(env); err != nil {
			t.Fatalf("%s envelope failed schema validation: %v\n%v", name, err, env)
		}
	}
}
