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

func TestDeriveStatusNoAppliedInference(t *testing.T) {
	// An exported item with no explicit lifecycle status must not read "applied".
	f := store.Feedback{Status: store.StatusExported, IssueURL: "https://github.com/org/repo/issues/1"}
	if got := deriveStatus(f); got != "exported" {
		t.Fatalf("deriveStatus(exported) = %q, want exported", got)
	}
	// Empty status + issue_url must NOT infer applied.
	f2 := store.Feedback{IssueURL: "https://github.com/org/repo/issues/1"}
	if got := deriveStatus(f2); got != "open" {
		t.Fatalf("deriveStatus(empty) = %q, want open", got)
	}
}

func TestBuildIssueContentMultiItemStructured(t *testing.T) {
	ctxA := map[string]any{
		"intent": map[string]any{"kind": "bug", "action": "fix", "expected": "be blue", "actual": "is red"},
		"source": map[string]any{"component": "A", "file": "src/A.tsx", "line": 1.0, "confidence": "exact"},
	}
	ctxB := map[string]any{
		"intent": map[string]any{"kind": "bug", "action": "change", "expected": "be green", "actual": "is yellow"},
		"source": map[string]any{"component": "B", "file": "src/B.tsx", "line": 2.0, "confidence": "approximate"},
	}
	aJSON, _ := json.Marshal(ctxA)
	bJSON, _ := json.Marshal(ctxB)
	items := []store.Feedback{
		{ID: 1, URL: "https://a.com/", Selector: "div.a", Comment: "one", ContextJSON: string(aJSON), GitHubUser: "alice"},
		{ID: 2, URL: "https://a.com/", Selector: "div.b", Comment: "two", ContextJSON: string(bJSON), GitHubUser: "bob"},
	}
	_, body := buildIssueContent(items, "")

	for _, want := range []string{
		"src/A.tsx", "src/B.tsx", // source per item
		"be blue", "be green", // intent expected per item
		"## Item 1", "## Item 2", // per-item headings
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("missing %q:\n%s", want, body)
		}
	}
	if strings.Count(body, "## Environment") != 1 {
		t.Fatalf("Environment should appear exactly once:\n%s", body)
	}
}
