package handler

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/emergent-company/emergent.feedback/server/store"
)

func richContextJSON(t *testing.T) string {
	t.Helper()
	ctx := map[string]any{
		"url":           "https://app.example.com/",
		"tagName":       "button",
		"dataComponent": "Card > Button",
		"source":        map[string]any{"component": "Button", "file": "src/Button.tsx", "line": 10.0, "confidence": "exact"},
		"intent":        map[string]any{"kind": "bug", "action": "change", "expected": "be blue", "actual": "is red"},
		"fingerprint":   map[string]any{"path": "body > button", "text": "Click"},
		"steps":         []any{"Open page", "Click button"},
		"console":       []any{map[string]any{"level": "warning", "message": "x"}},
		"network":       []any{map[string]any{"method": "GET", "url": "/x"}},
		"computedStyles": map[string]any{
			"display": "flex",
		},
		"outerHTML":      "<button>Click</button>",
		"sessionHistory": []any{map[string]any{"type": "click", "timestamp": "2026-10-01T12:00:00Z", "data": map[string]any{"tagName": "button"}}},
	}
	b, _ := json.Marshal(ctx)
	return string(b)
}

func render(items []store.Feedback, level string) string {
	_, body := buildIssueContentLevel(items, level)
	return body
}

func TestBuildIssueContentLevels(t *testing.T) {
	items := []store.Feedback{{
		ID:          1,
		URL:         "https://app.example.com/",
		Selector:    "div > button",
		Comment:     "wrong color",
		ContextJSON: richContextJSON(t),
		GitHubUser:  "alice",
	}}

	compact := render(items, levelCompact)
	standard := render(items, levelStandard)
	forensic := render(items, levelForensic)

	// compact: core sections present.
	for _, want := range []string{"## Task", "## What to do", "## Trust order", "## Element", "## Verification"} {
		if !strings.Contains(compact, want) {
			t.Fatalf("compact missing %q:\n%s", want, compact)
		}
	}
	// compact: verbose sections omitted.
	for _, omit := range []string{"## Intent", "## Repro", "## Environment", "<details>", "Fingerprint", "Session history", "Computed styles", "### Comment"} {
		if strings.Contains(compact, omit) {
			t.Fatalf("compact should not contain %q:\n%s", omit, compact)
		}
	}

	// standard: folded details present, expanded headings absent.
	for _, want := range []string{"<details>", "## Intent", "## Repro", "## Environment", "Fingerprint"} {
		if !strings.Contains(standard, want) {
			t.Fatalf("standard missing %q:\n%s", want, standard)
		}
	}
	for _, omit := range []string{"## Computed styles", "## Element HTML", "## Full context", "## Session history"} {
		if strings.Contains(standard, omit) {
			t.Fatalf("standard should not contain %q:\n%s", omit, standard)
		}
	}

	// forensic: expanded blocks, no folding.
	for _, want := range []string{"## Computed styles", "## Element HTML", "## Full context", "## Session history", "**Console**", "**Network**"} {
		if !strings.Contains(forensic, want) {
			t.Fatalf("forensic missing %q:\n%s", want, forensic)
		}
	}
	if strings.Contains(forensic, "<details>") {
		t.Fatalf("forensic should not fold blocks:\n%s", forensic)
	}
}
