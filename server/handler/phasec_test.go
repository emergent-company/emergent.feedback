package handler

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/emergent-company/emergent.feedback/server/store"
)

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

func TestLLMTitleRedactsExpectedSecret(t *testing.T) {
	var gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"Fix contrast"}}]}`))
	}))
	defer srv.Close()

	t.Setenv("FEEDBACK_LLM_BASE_URL", srv.URL)
	t.Setenv("FEEDBACK_LLM_API_KEY", "test-key")

	ctx := map[string]any{
		"intent": map[string]any{
			"action":   "change",
			"expected": "contrast should pass sk-abcdefghijklmnop and token eyJhbGciOiJIUzI1NiJ9.abc.def",
		},
	}
	if _, ok := llmTitle(ctx, store.Feedback{Comment: "button contrast is bad"}); !ok {
		t.Fatal("expected LLM title")
	}
	if strings.Contains(gotBody, "sk-abcdefghijklmnop") {
		t.Fatalf("expected secret leaked into LLM request: %s", gotBody)
	}
	if strings.Contains(gotBody, "eyJhbGci") {
		t.Fatalf("jwt leaked into LLM request: %s", gotBody)
	}
	if !strings.Contains(gotBody, "[redacted]") {
		t.Fatalf("expected redacted marker in LLM request: %s", gotBody)
	}
}

func TestLLMTitleTruncatesTo80Runes(t *testing.T) {
	long := strings.Repeat("x", 300)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"` + long + `"}}]}`))
	}))
	defer srv.Close()

	t.Setenv("FEEDBACK_LLM_BASE_URL", srv.URL)
	t.Setenv("FEEDBACK_LLM_API_KEY", "test-key")

	title, ok := llmTitle(nil, store.Feedback{Comment: "button contrast is bad"})
	if !ok {
		t.Fatal("expected LLM title")
	}
	if n := len([]rune(title)); n > 80 {
		t.Fatalf("title length = %d runes, want <= 80 (title=%q)", n, title)
	}
}

func TestFrameBase(t *testing.T) {
	cases := []struct{ in, want string }{
		{"bundle.js", "bundle.js"},
		{"bundle.js?v=abc", "bundle.js"},
		{"bundle.js#hash", "bundle.js"},
		{"https://cdn.example.com/bundle.js?v=abc", "bundle.js"},
		{`C:\build\bundle.js`, "bundle.js"},
		{`C:\build\bundle.js?v=1`, "bundle.js"},
		{"/dist/assets/bundle.js", "bundle.js"},
	}
	for _, c := range cases {
		if got := frameBase(c.in); got != c.want {
			t.Fatalf("frameBase(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestUnmapStackQueryStringBasename(t *testing.T) {
	_, s, _ := newLifecycleHandler(t)
	ctx := context.Background()

	sm := `{"version":3,"file":"bundle.js","sources":["src/App.tsx"],"names":[],"mappings":"AAAA"}`
	if err := s.UpsertSourcemap(ctx, "org/repo", "1.0.0", "bundle.js.map", []byte(sm)); err != nil {
		t.Fatalf("UpsertSourcemap: %v", err)
	}

	h := &Handler{Store: s}
	contextJSON := `{"appVersion":"1.0.0","console":[{"level":"error","message":"boom","stack":[{"path":"https://cdn.example.com/bundle.js?v=abc","line":1,"column":0}]}]}`
	out := h.unmapContextConsole(ctx, "org/repo", contextJSON)
	if !strings.Contains(out, "src/App.tsx") {
		t.Fatalf("expected mapped source via query-stripped basename in: %s", out)
	}
}

func TestUnmapStackWindowsPathBasename(t *testing.T) {
	_, s, _ := newLifecycleHandler(t)
	ctx := context.Background()

	sm := `{"version":3,"file":"bundle.js","sources":["src/App.tsx"],"names":[],"mappings":"AAAA"}`
	if err := s.UpsertSourcemap(ctx, "org/repo", "1.0.0", "bundle.js.map", []byte(sm)); err != nil {
		t.Fatalf("UpsertSourcemap: %v", err)
	}

	h := &Handler{Store: s}
	contextJSON := `{"appVersion":"1.0.0","console":[{"level":"error","message":"boom","stack":[{"path":"C:\\build\\bundle.js","line":1,"column":0}]}]}`
	out := h.unmapContextConsole(ctx, "org/repo", contextJSON)
	if !strings.Contains(out, "src/App.tsx") {
		t.Fatalf("expected mapped source via windows-path basename in: %s", out)
	}
}

func TestUnmapStackShortensMappedSourcePath(t *testing.T) {
	_, s, _ := newLifecycleHandler(t)
	ctx := context.Background()

	sm := `{"version":3,"file":"bundle.js","sources":["/home/runner/work/app/src/Foo.tsx"],"names":[],"mappings":"AAAA"}`
	if err := s.UpsertSourcemap(ctx, "org/repo", "1.0.0", "bundle.js.map", []byte(sm)); err != nil {
		t.Fatalf("UpsertSourcemap: %v", err)
	}

	h := &Handler{Store: s}
	contextJSON := `{"appVersion":"1.0.0","console":[{"level":"error","message":"boom","stack":[{"path":"https://cdn.example.com/bundle.js","line":1,"column":0}]}]}`
	out := h.unmapContextConsole(ctx, "org/repo", contextJSON)
	if strings.Contains(out, "/home/runner/work") {
		t.Fatalf("absolute mapped source leaked: %s", out)
	}
	if !strings.Contains(out, "app/src/Foo.tsx") {
		t.Fatalf("expected shortened mapped source in: %s", out)
	}
}

func TestUnmapStackColumnOffByOne(t *testing.T) {
	_, s, _ := newLifecycleHandler(t)
	ctx := context.Background()

	// Two segments on generated line 1: genCol 0 -> srcCol 0, genCol 1 -> srcCol 5.
	sm := `{"version":3,"file":"bundle.js","sources":["src/App.tsx"],"names":[],"mappings":"AAAA,CAAK"}`
	if err := s.UpsertSourcemap(ctx, "org/repo", "1.0.0", "bundle.js.map", []byte(sm)); err != nil {
		t.Fatalf("UpsertSourcemap: %v", err)
	}

	h := &Handler{Store: s}
	stack := []any{map[string]any{"path": "https://cdn.example.com/bundle.js", "line": 1.0, "column": 1.0}}
	out, mapped, _ := h.unmapStack(ctx, "org/repo", "1.0.0", stack)
	if !mapped || len(out) != 1 {
		t.Fatalf("expected one mapped frame, got mapped=%v out=%v", mapped, out)
	}
	f, ok := out[0].(map[string]any)
	if !ok {
		t.Fatalf("frame not a map: %v", out[0])
	}
	if col, _ := f["column"].(int); col != 0 {
		t.Fatalf("mapped column = %v, want 0 (1-based col 1 -> 0-based col 0)", f["column"])
	}
}

func TestShortenStackTextWindowsPath(t *testing.T) {
	in := `Error: boom
    at foo (C:\Users\name\work\src\Foo.tsx:10:5)`
	out := shortenStackText(in)
	if strings.Contains(out, `C:\Users\name`) {
		t.Fatalf("windows path leaked: %s", out)
	}
	if !strings.Contains(out, "work/src/Foo.tsx") {
		t.Fatalf("expected shortened windows path in: %s", out)
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

func TestUnmapContextConsoleNestedReproConsole(t *testing.T) {
	_, s, _ := newLifecycleHandler(t)
	ctx := context.Background()

	sm := `{"version":3,"file":"bundle.js","sources":["src/App.tsx"],"names":[],"mappings":"AAAA"}`
	if err := s.UpsertSourcemap(ctx, "org/repo", "1.0.0", "bundle.js.map", []byte(sm)); err != nil {
		t.Fatalf("UpsertSourcemap: %v", err)
	}

	h := &Handler{Store: s}
	// The client nests console under repro.console; unmapping must read the
	// nested array (this test FAILS if the nested read is reverted to top-level).
	contextJSON := `{"appVersion":"1.0.0","repro":{"console":[{"level":"error","message":"boom","stack":[{"path":"https://cdn.example.com/bundle.js","line":1,"column":0}]}]}}`
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
