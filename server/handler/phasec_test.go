package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/emergent-company/emergent.feedback/server/store"
)

func TestComputeDedupeKeyDeterministic(t *testing.T) {
	ctx := `{"fingerprint":{"path":"body > button"}}`
	a := computeDedupeKey("org/repo", "button", ctx, "  It   IS broken ")
	b := computeDedupeKey("org/repo", "button", ctx, "it is broken")
	if a != b {
		t.Fatalf("normalized keys differ: %q vs %q", a, b)
	}
	c := computeDedupeKey("org/repo", "button", ctx, "it is fine")
	if a == c {
		t.Fatalf("different comments should produce different keys")
	}
}

func TestHeuristicSummary(t *testing.T) {
	ctx := map[string]any{
		"intent":        map[string]any{"action": "fix", "expected": "contrast ratio"},
		"dataComponent": "Card > UpgradeButton",
	}
	f := store.Feedback{Selector: "button", Comment: "unreadable"}
	if got, want := heuristicSummary(ctx, f), "Fix contrast ratio on UpgradeButton"; got != want {
		t.Fatalf("summary = %q, want %q", got, want)
	}
}

func TestHeuristicSummaryNoSignals(t *testing.T) {
	if got := heuristicSummary(nil, store.Feedback{Comment: "x"}); got != "" {
		t.Fatalf("expected empty, got %q", got)
	}
}

func TestLLMTitle(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"\"Fix contrast on button\""}}]}`))
	}))
	defer srv.Close()

	t.Setenv("FEEDBACK_LLM_BASE_URL", srv.URL)
	t.Setenv("FEEDBACK_LLM_API_KEY", "test-key")

	title, ok := llmTitle(nil, store.Feedback{Comment: "button contrast is bad"})
	if !ok {
		t.Fatal("expected LLM title")
	}
	if title != "Fix contrast on button" {
		t.Fatalf("title = %q", title)
	}
}

func TestNotifyReporterFires(t *testing.T) {
	var (
		mu   sync.Mutex
		got  map[string]any
		done = make(chan struct{})
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var p map[string]any
		_ = json.NewDecoder(r.Body).Decode(&p)
		mu.Lock()
		got = p
		mu.Unlock()
		close(done)
	}))
	defer srv.Close()
	t.Setenv("FEEDBACK_NOTIFY_WEBHOOK", srv.URL)

	h := &Handler{}
	f := store.Feedback{ID: 7, Selector: "button", URL: "https://app.example.com/", IssueURL: "https://github.com/org/repo/issues/1"}
	h.notifyReporter("resolved", "resolved", f)

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("webhook not called")
	}
	mu.Lock()
	defer mu.Unlock()
	if got["event"] != "resolved" || got["id"] != float64(7) || got["status"] != "resolved" {
		t.Fatalf("payload = %v", got)
	}
}

func TestFeedbackStatusOwnership(t *testing.T) {
	_, s, e := newLifecycleHandler(t)
	ctx := context.Background()

	f, err := s.Create(ctx, store.CreateParams{URL: "https://app.example.com/", Selector: "button", Comment: "x", GitHubUser: "alice", Repo: "owner/repo"})
	if err != nil {
		t.Fatalf("Create alice: %v", err)
	}
	if _, err := s.Create(ctx, store.CreateParams{URL: "https://app.example.com/", Selector: "button", Comment: "y", GitHubUser: "bob", Repo: "owner/repo"}); err != nil {
		t.Fatalf("Create bob: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/feedback/status?url="+url.QueryEscape("https://app.example.com/"), nil)
	req.Header.Set("X-Test-Login", "alice")
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var items []struct {
		ID       int64  `json:"id"`
		Selector string `json:"selector"`
		Status   string `json:"status"`
		IssueURL string `json:"issue_url"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &items); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(items) != 1 || items[0].ID != f.ID {
		t.Fatalf("items = %v, want only alice's item %d", items, f.ID)
	}
}

func TestUnmapStackWithInlineSourcemap(t *testing.T) {
	_, s, _ := newLifecycleHandler(t)
	ctx := context.Background()

	sm := `{"version":3,"file":"bundle.js","sources":["src/App.tsx"],"names":[],"mappings":"AAAA"}`
	if err := s.UpsertSourcemap(ctx, "org/repo", "1.0.0", "bundle.js.map", []byte(sm)); err != nil {
		t.Fatalf("UpsertSourcemap: %v", err)
	}

	h := &Handler{Store: s}
	contextJSON := `{"appVersion":"1.0.0","console":[{"level":"error","message":"boom","stack":[{"path":"https://cdn.example.com/bundle.js","line":1,"column":0}]}]}`
	out := h.unmapContextConsole(ctx, "org/repo", contextJSON)
	if !strings.Contains(out, "unmapped_stack") {
		t.Fatalf("no unmapped_stack in: %s", out)
	}
	if !strings.Contains(out, "src/App.tsx") {
		t.Fatalf("no original source in: %s", out)
	}
}
