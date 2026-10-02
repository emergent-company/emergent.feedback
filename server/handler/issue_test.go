package handler

import (
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/emergent-company/emergent.feedback/server/store"
)

func TestSelectorShort(t *testing.T) {
	long := strings.Repeat("x", 80)
	cases := []struct{ in, want string }{
		{"main > section > button.foo", "button.foo"},
		{"button", "button"},
		{"", ""},
		{"main > " + long, strings.Repeat("x", 57) + "…"},
	}
	for _, c := range cases {
		if got := selectorShort(c.in); got != c.want {
			t.Fatalf("selectorShort(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestRuneTruncate(t *testing.T) {
	if got := runeTruncate("hello", 10); got != "hello" {
		t.Fatalf("short = %q", got)
	}
	if got := runeTruncate("abcdefgh", 3); got != "abc" {
		t.Fatalf("truncate = %q, want abc", got)
	}
	// Multi-byte runes must not be split mid-sequence.
	s := "héllo wörld"
	if got := runeTruncate(s, 5); got != "héllo" {
		t.Fatalf("rune truncate = %q, want %q", got, "héllo")
	}
	// Valid UTF-8 output even when a byte-boundary slice would break.
	if !utf8.ValidString(runeTruncate("日本語のテキスト", 3)) {
		t.Fatal("runeTruncate produced invalid UTF-8")
	}
}

func TestSelectorShortRuneSafe(t *testing.T) {
	// 60 multi-byte runes must not produce invalid UTF-8 or a split rune.
	sel := "main > " + strings.Repeat("é", 80)
	got := selectorShort(sel)
	if !utf8.ValidString(got) {
		t.Fatal("selectorShort produced invalid UTF-8")
	}
	if len([]rune(got)) != 58 { // 57 runes + "…"
		t.Fatalf("selectorShort rune len = %d, want 58", len([]rune(got)))
	}
}

func TestFormatEventDetailRuneSafe(t *testing.T) {
	long := strings.Repeat("é", 80)
	got := formatEventDetail("input", map[string]any{"tagName": "input", "value": long})
	if !utf8.ValidString(got) {
		t.Fatal("formatEventDetail produced invalid UTF-8")
	}
}

func TestBuildIssueContentSingle(t *testing.T) {
	ctx := map[string]any{
		"url":              "https://app.example.com/dashboard",
		"branch":           "feature/x",
		"appVersion":       "1.2.3",
		"viewport":         map[string]any{"width": 1440.0, "height": 900.0},
		"devicePixelRatio": 2.0,
		"cssFramework":     []any{"Tailwind CSS", "DaisyUI"},
		"boundingRect":     map[string]any{"top": 340.0, "left": 120.0, "width": 120.0, "height": 36.0},
		"outerHTML":        "<button class=\"x\">Go</button>",
		"computedStyles":   map[string]any{"display": "flex", "position": "relative"},
	}
	ctxJSON, _ := json.Marshal(ctx)
	items := []store.Feedback{{
		ID:          1,
		URL:         "https://app.example.com/dashboard",
		Selector:    "main > section > button.foo",
		Comment:     "the button contrast is bad",
		ContextJSON: string(ctxJSON),
		GitHubUser:  "alice",
	}}
	title, body := buildIssueContent(items, "")

	if title != "Feedback on button.foo" {
		t.Fatalf("title = %q", title)
	}
	for _, want := range []string{
		"**@alice**",
		"the button contrast is bad",
		"Tailwind CSS, DaisyUI",
		"**Selector:** `main > section > button.foo`",
		"1440 × 900 px (2.0× DPR)",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("body missing %q\n%s", want, body)
		}
	}
	if strings.Contains(body, "Comment 2") {
		t.Fatal("single item should not have Comment 2")
	}
}

func TestBuildIssueContentMulti(t *testing.T) {
	ctx := map[string]any{"url": "https://app.example.com/"}
	ctxJSON, _ := json.Marshal(ctx)
	items := []store.Feedback{
		{ID: 1, URL: "https://app.example.com/", Selector: "div.a", Comment: "one", ContextJSON: string(ctxJSON), GitHubUser: "alice"},
		{ID: 2, URL: "https://app.example.com/", Selector: "div.a", Comment: "two", ContextJSON: string(ctxJSON), GitHubUser: "bob"},
	}
	title, body := buildIssueContent(items, "")
	if title != "Feedback: 2 comments on div.a" {
		t.Fatalf("title = %q", title)
	}
	for _, want := range []string{"### Comment 1", "### Comment 2", "**@bob**"} {
		if !strings.Contains(body, want) {
			t.Fatalf("body missing %q\n%s", want, body)
		}
	}
}

func TestFormatEventTime(t *testing.T) {
	cases := []struct{ in, want string }{
		{"2024-01-02T03:04:05Z", "03:04:05"},
		{"2024-01-02T03:04:05", "03:04:05"},
		{"short", "short"},
		{"", ""},
	}
	for _, c := range cases {
		if got := formatEventTime(c.in); got != c.want {
			t.Fatalf("formatEventTime(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestFormatEventDetail(t *testing.T) {
	if got := formatEventDetail("navigation", map[string]any{"previousUrl": "https://a.com/x", "url": "https://a.com/y"}); got != "/x → /y" {
		t.Fatalf("navigation detail = %q", got)
	}
	if got := formatEventDetail("input", map[string]any{"tagName": "input", "value": "hi", "component": "Foo"}); got != "`input` [Foo] = \"hi\"" {
		t.Fatalf("input detail = %q", got)
	}
	if got := formatEventDetail("click", map[string]any{"tagName": "button", "text": "Go"}); got != "`button` \"Go\"" {
		t.Fatalf("click detail = %q", got)
	}
	if got := formatEventDetail("unknown", map[string]any{}); got != "" {
		t.Fatalf("unknown detail = %q", got)
	}
}

func TestShortenEventURL(t *testing.T) {
	cases := []struct{ in, want string }{
		{"", "(initial page)"},
		{"https://a.com/path?q=1", "/path?q=1"},
		{"https://a.com/", "/"},
	}
	for _, c := range cases {
		if got := shortenEventURL(c.in); got != c.want {
			t.Fatalf("shortenEventURL(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestParseContext(t *testing.T) {
	if parseContext("") != nil {
		t.Fatal("empty should be nil")
	}
	if parseContext("{}") != nil {
		t.Fatal("{} should be nil")
	}
	m := parseContext(`{"url":"https://a.com"}`)
	if m == nil || m["url"] != "https://a.com" {
		t.Fatalf("parse = %v", m)
	}
	if parseContext("{bad json") != nil {
		t.Fatal("bad json should be nil")
	}
}

func TestPrettyJSON(t *testing.T) {
	if prettyJSON("") != "{}" {
		t.Fatalf("empty = %q", prettyJSON(""))
	}
	out := prettyJSON(`{"a":1}`)
	if !strings.Contains(out, "\n") || !strings.Contains(out, `"a"`) {
		t.Fatalf("pretty = %q", out)
	}
	if prettyJSON("{bad") == "" {
		t.Fatal("bad json should return raw")
	}
}

func TestPrettyHTML(t *testing.T) {
	out := prettyHTML(`<div><span>hi</span></div>`)
	for _, want := range []string{"<div>", "<span>", "hi", "</span>", "</div>"} {
		if !strings.Contains(out, want) {
			t.Fatalf("prettyHTML missing %q:\n%s", want, out)
		}
	}
}
