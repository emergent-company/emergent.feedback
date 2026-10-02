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

func TestShortenPath(t *testing.T) {
	cases := []struct{ in, want string }{
		{"/root/emergent.memory/apps/web-ui/src/Foo.tsx", "web-ui/src/Foo.tsx"},
		{"/a/b.js", "/a/b.js"}, // <= 3 segments, unchanged
		{"/a/b/c/d.js", "b/c/d.js"},
		{"src/Foo.tsx", "src/Foo.tsx"}, // relative, unchanged
		{"https://cdn.example.com/bundle.js", "https://cdn.example.com/bundle.js"}, // URL, unchanged
		{"webpack:///src/Foo.tsx", "webpack:///src/Foo.tsx"},                       // virtual, unchanged
		{"file:///root/a/b/c/d.js", "b/c/d.js"},
		{`C:\Users\mcj\code\a\b\d.js`, `a/b/d.js`},
	}
	for _, c := range cases {
		if got := shortenPath(c.in); got != c.want {
			t.Fatalf("shortenPath(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestUnmapContextConsoleShortensUnmappedPaths(t *testing.T) {
	_, s, _ := newLifecycleHandler(t)
	ctx := context.Background()
	h := &Handler{Store: s}

	// No sourcemap stored → frames cannot be mapped; their absolute paths must
	// be shortened to the last 3 segments.
	contextJSON := `{"appVersion":"1.0.0","console":[{"level":"error","message":"boom","stack":[{"path":"/root/emergent.memory/apps/web-ui/src/Foo.tsx","line":10,"column":2}]}]}`
	out := h.unmapContextConsole(ctx, "org/repo", contextJSON)
	if strings.Contains(out, "/root/emergent.memory/apps/web-ui/src/Foo.tsx") {
		t.Fatalf("absolute path leaked: %s", out)
	}
	if !strings.Contains(out, "web-ui/src/Foo.tsx") {
		t.Fatalf("expected shortened path in: %s", out)
	}
}

func TestUnmapContextConsoleShortensStackText(t *testing.T) {
	_, s, _ := newLifecycleHandler(t)
	ctx := context.Background()
	h := &Handler{Store: s}

	contextJSON := `{"appVersion":"1.0.0","console":[{"level":"error","message":"boom","stack_text":"Error: boom\n    at foo (/root/emergent.memory/apps/web-ui/src/Foo.tsx:10:5)"}]}`
	out := h.unmapContextConsole(ctx, "org/repo", contextJSON)
	if strings.Contains(out, "/root/emergent.memory/apps/web-ui/src/Foo.tsx") {
		t.Fatalf("absolute path leaked via stack_text: %s", out)
	}
	if !strings.Contains(out, "web-ui/src/Foo.tsx") {
		t.Fatalf("expected shortened path in stack_text: %s", out)
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
