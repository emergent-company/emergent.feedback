package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/emergent-company/emergent.feedback/server/github"
	"github.com/emergent-company/emergent.feedback/server/store"
)

func TestSchemaRoute(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	defer func() { _ = s.Close() }()

	e := buildRouter(s, &github.AppConfig{}, "test-secret", "*", "")

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
