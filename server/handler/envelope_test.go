package handler

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/emergent-company/emergent.feedback/server/store"
)

func TestBuildEnvelopeFull(t *testing.T) {
	ctx := map[string]any{
		"url":              "https://app.example.com/pricing",
		"tagName":          "button",
		"role":             "button",
		"dataComponent":    "PricingCard > UpgradeButton",
		"viewport":         map[string]any{"width": 1440.0, "height": 900.0},
		"devicePixelRatio": 2.0,
		"userAgent":        "Chrome/126",
		"cssFramework":     []any{"Tailwind CSS", "DaisyUI"},
		"branch":           "main",
		"appVersion":       "0.3.1",
		"sessionId":        "sess-1",
		"traceId":          "trace-1",
		"sessionHistory":   []any{map[string]any{"type": "click", "timestamp": "2026-10-01T12:00:00Z"}},
		"source": map[string]any{
			"component":  "UpgradeButton",
			"file":       "src/components/Pricing/UpgradeButton.tsx",
			"line":       42.0,
			"column":     7.0,
			"framework":  "react",
			"resolution": "build-stamp",
			"confidence": "exact",
		},
		"fingerprint": map[string]any{
			"attrs": map[string]any{"data-testid": "pricing-upgrade"},
			"path":  "main > section > div > button",
			"text":  "Upgrade now",
		},
		"intent": map[string]any{
			"kind":     "bug",
			"action":   "change",
			"expected": "text/icon passes WCAG AA (contrast >= 4.5:1)",
			"actual":   "contrast ratio 2.1:1",
			"scope":    map[string]any{"breadth": "element", "targets": []any{"[data-testid='pricing-upgrade']"}},
		},
		"verification": map[string]any{
			"contract": map[string]any{"kind": "style_assertion"},
			"criteria": "CTA text readable",
		},
		"provenance": map[string]any{
			"target.element.fingerprint": "captured",
			"target.source":              "captured",
			"intent.expected":            "stated",
			"intent.actual":              "stated",
		},
	}
	ctxJSON, _ := json.Marshal(ctx)
	f := store.Feedback{
		ID:          1847,
		URL:         "https://app.example.com/pricing",
		Selector:    "[data-testid='pricing-upgrade']",
		Comment:     "Button is unreadable in light mode.",
		ContextJSON: string(ctxJSON),
		GitHubUser:  "alice",
		Repo:        "org/repo",
		Status:      store.StatusOpen,
		Screenshot:  []byte{0x89, 0x50},
		CreatedAt:   time.Date(2026, 10, 1, 12, 4, 11, 0, time.UTC),
	}

	env := BuildEnvelope(f)

	if env["schema"] != "https://feedback.emergent-company.ai/schema/envelope.v1.json" {
		t.Fatalf("schema = %v", env["schema"])
	}
	if env["version"] != "1.0.0" {
		t.Fatalf("version = %v", env["version"])
	}
	if env["id"] != int64(1847) {
		t.Fatalf("id = %v", env["id"])
	}
	if env["created_at"] != "2026-10-01T12:04:11Z" {
		t.Fatalf("created_at = %v", env["created_at"])
	}
	if env["status"] != "open" {
		t.Fatalf("status = %v", env["status"])
	}
	if env["type"] != "bug" {
		t.Fatalf("type = %v", env["type"])
	}
	if env["summary"] != "Change text/icon passes WCAG AA (contrast >= 4.5:1) on UpgradeButton" {
		t.Fatalf("summary = %v", env["summary"])
	}
	actor, _ := env["actor"].(map[string]any)
	if actor["github_user"] != "alice" {
		t.Fatalf("actor = %v", env["actor"])
	}

	target, _ := env["target"].(map[string]any)
	element, _ := target["element"].(map[string]any)
	if element["selector"] != "[data-testid='pricing-upgrade']" {
		t.Fatalf("selector = %v", element["selector"])
	}
	if element["tag"] != "button" {
		t.Fatalf("tag = %v", element["tag"])
	}
	source, _ := target["source"].(map[string]any)
	if source["confidence"] != "exact" {
		t.Fatalf("source.confidence = %v", source["confidence"])
	}
	if source["file"] != "src/components/Pricing/UpgradeButton.tsx" {
		t.Fatalf("source.file = %v", source["file"])
	}

	intent, _ := env["intent"].(map[string]any)
	if intent["expected"] == "" {
		t.Fatalf("intent.expected missing: %v", env["intent"])
	}

	verification, _ := env["verification"].(map[string]any)
	contract, _ := verification["contract"].(map[string]any)
	if contract["kind"] != "style_assertion" {
		t.Fatalf("contract.kind = %v", contract)
	}

	to, _ := env["trust_order"].([]string)
	if len(to) == 0 || to[0] != "target.source" {
		t.Fatalf("trust_order = %v", env["trust_order"])
	}

	prov, _ := env["provenance"].(map[string]any)
	if prov["summary"] != "inferred" {
		t.Fatalf("provenance.summary = %v", prov["summary"])
	}

	// visual populated from screenshot.
	visual, _ := env["visual"].(map[string]any)
	if visual["screenshot_ref"] != "feedback://1847/screenshot" {
		t.Fatalf("visual = %v", env["visual"])
	}
}

func TestBuildEnvelopeLegacy(t *testing.T) {
	f := store.Feedback{
		ID:          1,
		URL:         "https://app.example.com/",
		Selector:    "main > button",
		Comment:     "it broke",
		ContextJSON: "",
		GitHubUser:  "bob",
		Status:      store.StatusOpen,
		CreatedAt:   time.Now(),
	}

	env := BuildEnvelope(f)

	if env["schema"] == nil || env["id"] != int64(1) {
		t.Fatalf("basic fields missing: %v", env)
	}

	target, _ := env["target"].(map[string]any)
	element, _ := target["element"].(map[string]any)
	if element["selector"] != "main > button" {
		t.Fatalf("selector = %v", element["selector"])
	}

	envn, _ := env["environment"].(map[string]any)
	if envn["url"] != "https://app.example.com/" {
		t.Fatalf("url = %v", envn["url"])
	}

	// comment still surfaces via explanation.
	ex, _ := env["explanation"].(map[string]any)
	if ex["text"] != "it broke" {
		t.Fatalf("explanation = %v", env["explanation"])
	}

	// source/intent are omitted for legacy rows.
	if _, ok := target["source"]; ok {
		t.Fatalf("source should be omitted for legacy row: %v", target)
	}
	if _, ok := env["intent"]; ok {
		t.Fatalf("intent should be omitted for legacy row")
	}

	// Empty-object and corrupt context must not panic.
	_ = BuildEnvelope(store.Feedback{ContextJSON: "{}"})
	_ = BuildEnvelope(store.Feedback{ContextJSON: "{bad json"})
}

func TestBuildEnvelopeNestedRepro(t *testing.T) {
	ctx := map[string]any{
		"repro": map[string]any{
			"steps":   []any{"Open page", "Click button"},
			"console": []any{map[string]any{"level": "error", "message": "boom"}},
			"network": []any{map[string]any{"method": "GET", "url": "/x"}},
		},
	}
	ctxJSON, _ := json.Marshal(ctx)
	f := store.Feedback{ID: 7, ContextJSON: string(ctxJSON), Selector: "button", Comment: "x"}

	env := BuildEnvelope(f)
	repro, ok := env["repro"].(map[string]any)
	if !ok {
		t.Fatalf("repro missing: %v", env)
	}
	if steps := stringSlice(repro["steps"]); len(steps) != 2 {
		t.Fatalf("repro.steps = %v, want 2", repro["steps"])
	}
	if repro["console"] == nil || repro["network"] == nil {
		t.Fatalf("repro.console/network missing: %v", repro)
	}
}

func TestBuildEnvelopeSurfacesChangesAndTargets(t *testing.T) {
	ctx := map[string]any{
		"intent": map[string]any{
			"changes": []any{
				map[string]any{"target": "main > section > button.cta", "group": "padding", "before": "p-2", "after": "p-4"},
				map[string]any{"target": "main > section > button.cta", "group": "backgroundColor", "before": "", "after": "bg-primary"},
			},
		},
		"targets": []any{
			map[string]any{"selector": "main > section > button.cta", "tagName": "button", "dataComponent": "CTA"},
		},
	}
	ctxJSON, _ := json.Marshal(ctx)
	f := store.Feedback{ID: 42, ContextJSON: string(ctxJSON), Selector: "button.cta", Comment: "x"}

	env := BuildEnvelope(f)

	intent := getMap(env, "intent")
	changes, ok := intent["changes"].([]any)
	if !ok || len(changes) != 2 {
		t.Fatalf("intent.changes = %v, want 2 changes", intent["changes"])
	}
	c0, ok := changes[0].(map[string]any)
	if !ok {
		t.Fatalf("changes[0] not an object: %v", changes[0])
	}
	if c0["target"] != "main > section > button.cta" || c0["after"] != "p-4" {
		t.Fatalf("changes[0] = %v", c0)
	}
	c1, ok := changes[1].(map[string]any)
	if !ok || c1["before"] != "" || c1["after"] != "bg-primary" {
		t.Fatalf("changes[1] = %v", changes[1])
	}

	targets, ok := getMap(env, "target")["targets"].([]any)
	if !ok || len(targets) != 1 {
		t.Fatalf("target.targets = %v, want 1 target", getMap(env, "target")["targets"])
	}
	t0, ok := targets[0].(map[string]any)
	if !ok || t0["selector"] != "main > section > button.cta" {
		t.Fatalf("targets[0] = %v", targets[0])
	}
}

func TestBuildEnvelopeReproTopLevelFallback(t *testing.T) {
	ctx := map[string]any{
		"steps":   []any{"Legacy step"},
		"console": []any{map[string]any{"level": "warning"}},
	}
	ctxJSON, _ := json.Marshal(ctx)
	f := store.Feedback{ID: 8, ContextJSON: string(ctxJSON), Selector: "button", Comment: "x"}

	env := BuildEnvelope(f)
	repro, ok := env["repro"].(map[string]any)
	if !ok {
		t.Fatalf("repro missing (top-level fallback): %v", env)
	}
	if repro["steps"] == nil || repro["console"] == nil {
		t.Fatalf("top-level repro fields missing: %v", repro)
	}
}

func TestBuildEnvelopeReplayRef(t *testing.T) {
	f := store.Feedback{
		ID:          9,
		ContextJSON: `{"repro":{"steps":["a"]}}`,
		Selector:    "button",
		Comment:     "x",
		Replay:      []byte{0x1f, 0x8b},
	}
	env := BuildEnvelope(f)
	repro, _ := env["repro"].(map[string]any)
	if repro["replay"] != "feedback://9/replay" {
		t.Fatalf("repro.replay = %v, want feedback://9/replay", repro["replay"])
	}
}

func TestBuildEnvelopeLifecycle(t *testing.T) {
	at := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	vt := at.Add(time.Minute)
	rt := at.Add(2 * time.Minute)
	f := store.Feedback{
		ID:                 1,
		URL:                "https://app.example.com/",
		Selector:           "button",
		Comment:            "c",
		Status:             store.StatusVerified,
		VerificationResult: "green",
		VerificationDetail: "passed",
		AppliedAt:          &at,
		VerifiedAt:         &vt,
		ResolvedAt:         &rt,
		CreatedAt:          at,
	}

	env := BuildEnvelope(f)

	if env["status"] != "verified" {
		t.Fatalf("status = %v, want verified", env["status"])
	}
	if env["applied_at"] != "2026-10-01T12:00:00Z" {
		t.Fatalf("applied_at = %v", env["applied_at"])
	}
	if env["verified_at"] != "2026-10-01T12:01:00Z" {
		t.Fatalf("verified_at = %v", env["verified_at"])
	}
	if env["resolved_at"] != "2026-10-01T12:02:00Z" {
		t.Fatalf("resolved_at = %v", env["resolved_at"])
	}
	ver, _ := env["verification"].(map[string]any)
	if ver["result"] != "green" {
		t.Fatalf("verification.result = %v", ver["result"])
	}
	if ver["detail"] != "passed" {
		t.Fatalf("verification.detail = %v", ver["detail"])
	}
}

func TestBuildTargetEmitsComputedStyles(t *testing.T) {
	ctx := map[string]any{
		"computedStyles": map[string]any{"color": "rgb(1, 2, 3)", "fontSize": "16px"},
	}
	ctxJSON, _ := json.Marshal(ctx)
	f := store.Feedback{ID: 1, ContextJSON: string(ctxJSON), Selector: "button", Comment: "x"}

	env := BuildEnvelope(f)
	el := getMap(env, "target", "element")
	if el["computed_styles"] == nil {
		t.Fatalf("computed_styles missing from target.element: %v", el)
	}
	styles, ok := el["computed_styles"].(map[string]any)
	if !ok || styles["color"] != "rgb(1, 2, 3)" {
		t.Fatalf("computed_styles = %v", el["computed_styles"])
	}
}

func TestBuildIssueContentSections(t *testing.T) {
	ctx := map[string]any{
		"url":    "https://app.example.com/",
		"source": map[string]any{"component": "Foo", "file": "src/Foo.tsx", "line": 10.0, "confidence": "exact"},
		"intent": map[string]any{"kind": "bug", "action": "change", "expected": "be blue", "actual": "is red"},
		"fingerprint": map[string]any{
			"path": "body > div > button",
			"text": "Click",
		},
		"steps": []any{"Open page", "Click button"},
	}
	ctxJSON, _ := json.Marshal(ctx)
	items := []store.Feedback{{
		ID:          1,
		URL:         "https://app.example.com/",
		Selector:    "div > button",
		Comment:     "wrong color",
		ContextJSON: string(ctxJSON),
		GitHubUser:  "alice",
	}}
	_, body := buildIssueContent(items, "")

	if !strings.Contains(body, "You are fixing feedback captured from a live page") {
		t.Fatalf("preamble missing:\n%s", body)
	}

	idx := func(s string) int { return strings.Index(body, s) }
	idxPreamble := idx("You are fixing feedback")
	idxTask := idx("## Task")
	idxWhat := idx("## What to do")
	idxTrust := idx("## Trust order")
	idxElement := idx("## Element")
	idxIntent := idx("## Intent")
	idxRepro := idx("## Repro")
	idxEnv := idx("## Environment")
	idxVerif := idx("## Verification")
	idxDetails := idx("<details>")

	if idxPreamble < 0 || idxPreamble > idxTask {
		t.Fatalf("preamble not first")
	}
	order := []int{idxTask, idxWhat, idxTrust, idxElement, idxIntent, idxRepro, idxEnv, idxVerif, idxDetails}
	for i := 1; i < len(order); i++ {
		if order[i-1] < 0 || order[i] < 0 || order[i-1] > order[i] {
			t.Fatalf("section order wrong:\n%s", body)
		}
	}

	if !strings.Contains(body, "**Done when:**") {
		t.Fatalf("Done when missing:\n%s", body)
	}
	if !strings.Contains(body, "so that be blue.") {
		t.Fatalf("what-to-do expected missing:\n%s", body)
	}
	if !strings.Contains(body, "Currently is red.") {
		t.Fatalf("what-to-do actual missing:\n%s", body)
	}
	// Every element/intent line carries a provenance badge.
	if !strings.Contains(body, "[captured]") {
		t.Fatalf("captured badge missing:\n%s", body)
	}
}
