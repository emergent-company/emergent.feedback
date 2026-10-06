package handler

import (
	"fmt"
	"strings"
	"time"

	"github.com/emergent-company/emergent.feedback/server/store"
)

const (
	envelopeSchema  = "https://feedback.emergent-company.ai/schema/envelope.v1.json"
	envelopeVersion = "1.0.0"
)

// trustOrder is the fixed evidence-trust ranking from spec §2.2. It resolves
// field conflicts once — source beats selector; human intent beats both on WHAT
// to build but loses on WHERE it is.
var trustOrder = []string{
	"target.source",
	"target.element.fingerprint",
	"intent.expected",
	"intent.actual",
	"intent.changes",
	"target.element.selector",
	"visual.screenshot_ref",
	"target.element.computed_styles",
	"environment.css_framework",
	"summary",
}

// BuildEnvelope renders a Feedback row as the canonical feedback envelope
// (spec §2.2). It degrades gracefully for legacy rows: any section whose source
// data is absent is omitted rather than emitted as null.
func BuildEnvelope(f store.Feedback) map[string]any {
	ctx := parseContext(f.ContextJSON)

	env := map[string]any{
		"schema":     envelopeSchema,
		"version":    envelopeVersion,
		"id":         f.ID,
		"created_at": f.CreatedAt.UTC().Format(time.RFC3339),
		"status":     deriveStatus(f),
		"type":       deriveType(ctx, f),
		"summary":    deriveSummary(ctx, f),
		"actor":      map[string]any{"github_user": f.GitHubUser},
	}

	env["target"] = buildTarget(ctx, f)

	if intent := buildIntent(ctx); intent != nil {
		env["intent"] = intent
	}
	if ex := buildExplanation(ctx, f); ex != nil {
		env["explanation"] = ex
	}
	if repro := buildRepro(ctx, f); repro != nil {
		env["repro"] = repro
	}
	if e := buildEnvironment(ctx, f); e != nil {
		env["environment"] = e
	}
	if v := buildVisual(f); v != nil {
		env["visual"] = v
	}

	// Verification: contract/criteria come from context JSON; the store-recorded
	// verification result and detail are layered in as verification.result/detail.
	verification := buildVerification(ctx)
	if f.VerificationResult != "" || f.VerificationDetail != "" {
		if verification == nil {
			verification = map[string]any{}
		}
		if f.VerificationResult != "" {
			verification["result"] = f.VerificationResult
		}
		if f.VerificationDetail != "" {
			verification["detail"] = f.VerificationDetail
		}
	}
	if verification != nil {
		env["verification"] = verification
	}

	// Lifecycle timestamps (only when recorded).
	if f.AppliedAt != nil {
		env["applied_at"] = f.AppliedAt.UTC().Format(time.RFC3339)
	}
	if f.VerifiedAt != nil {
		env["verified_at"] = f.VerifiedAt.UTC().Format(time.RFC3339)
	}
	if f.ResolvedAt != nil {
		env["resolved_at"] = f.ResolvedAt.UTC().Format(time.RFC3339)
	}

	env["provenance"] = buildProvenance(ctx)
	env["trust_order"] = trustOrder

	// Dedupe (only when a key exists).
	if f.DedupeKey != "" {
		dedupe := map[string]any{"key": f.DedupeKey}
		if f.DuplicateOf != 0 {
			dedupe["duplicate_of"] = f.DuplicateOf
		}
		if len(f.PossibleDuplicates) > 0 {
			dedupe["possible_duplicates"] = f.PossibleDuplicates
		}
		env["dedupe"] = dedupe
	}

	return env
}

// BuildConciseEnvelope returns the compact envelope used for feedback_get's
// default "concise" response_format. It carries only the high-signal fields
// (identity, source, intent, verification, trust order, provenance) and omits
// DOM dumps, styles, replay/snapshot refs, session history and console/network.
func BuildConciseEnvelope(f store.Feedback) map[string]any {
	ctx := parseContext(f.ContextJSON)

	env := map[string]any{
		"schema":     envelopeSchema,
		"version":    envelopeVersion,
		"id":         f.ID,
		"created_at": f.CreatedAt.UTC().Format(time.RFC3339),
		"status":     deriveStatus(f),
		"type":       deriveType(ctx, f),
		"summary":    deriveSummary(ctx, f),
		"actor":      map[string]any{"github_user": f.GitHubUser},
	}

	el := map[string]any{}
	if v := asString(ctx["tagName"]); v != "" {
		el["tag"] = v
	}
	if v := asString(ctx["label"]); v != "" {
		el["label"] = v
	}
	if f.Selector != "" {
		el["selector"] = f.Selector
	}
	if v := asString(ctx["dataComponent"]); v != "" {
		el["data_component"] = v
	}
	target := map[string]any{}
	if len(el) > 0 {
		target["element"] = el
	}
	if s := buildSource(ctx); s != nil {
		target["source"] = s
	}
	if len(target) > 0 {
		env["target"] = target
	}

	if intent := buildIntent(ctx); intent != nil {
		env["intent"] = intent
	}

	verification := buildVerification(ctx)
	if f.VerificationResult != "" || f.VerificationDetail != "" {
		if verification == nil {
			verification = map[string]any{}
		}
		if f.VerificationResult != "" {
			verification["result"] = f.VerificationResult
		}
		if f.VerificationDetail != "" {
			verification["detail"] = f.VerificationDetail
		}
	}
	if verification != nil {
		env["verification"] = verification
	}

	env["trust_order"] = trustOrder
	env["provenance"] = buildProvenance(ctx)

	return env
}

// deriveStatus maps the persisted lifecycle status onto the envelope status
// enum. It reads the real store Status (open/applied/verified/resolved/exported)
// and never infers applied/verified/resolved from issue_url.
func deriveStatus(f store.Feedback) string {
	if f.Status == "" {
		return "open"
	}
	return string(f.Status)
}

// deriveType returns the envelope type, preferring explicit client fields
// (context `type` or `intent.kind`), then the label, then a bug default.
func deriveType(ctx map[string]any, f store.Feedback) string {
	if v := asString(ctx["type"]); validFeedbackType(v) {
		return v
	}
	if m, ok := ctx["intent"].(map[string]any); ok {
		if v := asString(m["kind"]); validFeedbackType(v) {
			return v
		}
	}
	if v := strings.ToLower(strings.TrimSpace(f.Label)); validFeedbackType(v) {
		return v
	}
	return "bug"
}

func validFeedbackType(v string) bool {
	switch v {
	case "bug", "enhancement", "question", "task":
		return true
	}
	return false
}

// deriveSummary returns a one-line summary, preferring an explicit context
// summary, then a deterministic heuristic (intent + element), then a truncated
// comment.
func deriveSummary(ctx map[string]any, f store.Feedback) string {
	if v := asString(ctx["summary"]); v != "" {
		return v
	}
	if s := heuristicSummary(ctx, f); s != "" {
		return s
	}
	return truncate(redactSecrets(f.Comment), 140)
}

func truncate(s string, n int) string {
	r := []rune(strings.TrimSpace(s))
	if len(r) <= n {
		return string(r)
	}
	return string(r[:n-1]) + "…"
}

// runeTruncate returns the first n runes of s, never splitting a UTF-8
// sequence. Used for byte-slice truncation of user text (selectors, values).
func runeTruncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

func buildTarget(ctx map[string]any, f store.Feedback) map[string]any {
	t := map[string]any{}

	el := map[string]any{}
	if v := asString(ctx["tagName"]); v != "" {
		el["tag"] = v
	}
	if v := asString(ctx["role"]); v != "" {
		el["role"] = v
	}
	if v := asString(ctx["label"]); v != "" {
		el["label"] = v
	}
	if f.Selector != "" {
		el["selector"] = f.Selector
	}
	if v := asString(ctx["dataComponent"]); v != "" {
		el["data_component"] = v
	}
	if fp := buildFingerprint(ctx); fp != nil {
		el["fingerprint"] = fp
	}
	if styles, ok := ctx["computedStyles"].(map[string]any); ok && len(styles) > 0 {
		el["computed_styles"] = styles
	}
	if len(el) > 0 {
		t["element"] = el
	}

	if v := ctx["region"]; v != nil {
		t["region"] = v
	}
	if v := ctx["selection"]; v != nil {
		t["selection"] = v
	}
	if v := ctx["targets"]; v != nil {
		t["targets"] = redactContextValue(v)
	}
	if s := buildSource(ctx); s != nil {
		t["source"] = s
	}
	return t
}

// buildFingerprint returns the client fingerprint when present, otherwise a
// legacy fallback derived from captured attributes + text (no path available).
func buildFingerprint(ctx map[string]any) map[string]any {
	if fp, ok := ctx["fingerprint"].(map[string]any); ok && len(fp) > 0 {
		return fp
	}
	fp := map[string]any{}
	if attrs, ok := ctx["attributes"].(map[string]any); ok && len(attrs) > 0 {
		fp["attrs"] = attrs
	}
	if v := asString(ctx["innerText"]); v != "" {
		fp["text"] = v
	}
	if len(fp) == 0 {
		return nil
	}
	return fp
}

func buildSource(ctx map[string]any) map[string]any {
	if s, ok := ctx["source"].(map[string]any); ok && len(s) > 0 {
		return s
	}
	return nil
}

func sourceConfidence(ctx map[string]any) string {
	if s, ok := ctx["source"].(map[string]any); ok {
		if v := asString(s["confidence"]); v != "" {
			return v
		}
	}
	return "none"
}

func buildIntent(ctx map[string]any) map[string]any {
	raw, ok := ctx["intent"].(map[string]any)
	if !ok || len(raw) == 0 {
		return nil
	}
	out := map[string]any{}
	if v := asString(raw["kind"]); v != "" {
		out["kind"] = v
	}
	if v := asString(raw["action"]); v != "" {
		out["action"] = v
	}
	if v := asString(raw["expected"]); v != "" {
		out["expected"] = redactSecrets(v)
	}
	if v := asString(raw["actual"]); v != "" {
		out["actual"] = redactSecrets(v)
	}
	if sc, ok := raw["scope"].(map[string]any); ok && len(sc) > 0 {
		out["scope"] = redactContextValue(sc)
	}
	if v, ok := raw["changes"]; ok && v != nil {
		out["changes"] = redactContextValue(v)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func buildExplanation(ctx map[string]any, f store.Feedback) map[string]any {
	out := map[string]any{}
	var text, quality string
	var score float64
	hasScore := false
	if e, ok := ctx["explanation"].(map[string]any); ok {
		text = asString(e["text"])
		quality = asString(e["quality"])
		if s, ok := e["quality_score"].(float64); ok {
			score = s
			hasScore = true
		}
	}
	if text == "" {
		text = f.Comment
	}
	if quality == "" {
		quality = asString(ctx["quality"])
	}
	if !hasScore {
		if s, ok := ctx["quality_score"].(float64); ok {
			score = s
			hasScore = true
		}
	}
	if text != "" {
		out["text"] = redactSecrets(text)
	}
	if quality != "" {
		out["quality"] = quality
	}
	if hasScore {
		out["quality_score"] = score
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func buildRepro(ctx map[string]any, f store.Feedback) map[string]any {
	out := map[string]any{}
	if v := reproValue(ctx, "steps"); v != nil {
		out["steps"] = v
	}
	if v := reproValue(ctx, "console"); v != nil {
		out["console"] = v
	}
	if v := reproValue(ctx, "network"); v != nil {
		out["network"] = v
	}
	if v := ctx["sessionHistory"]; v != nil {
		out["session_history"] = v
	}
	// replay: prefer client-provided, else reference the stored replay blob.
	if v := reproValue(ctx, "replay"); v != nil {
		out["replay"] = v
	} else if len(f.Replay) > 0 {
		out["replay"] = fmt.Sprintf("feedback://%d/replay", f.ID)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// reproValue returns a repro field, reading the nested `repro` object first and
// falling back to top-level keys for legacy payloads (client now nests repro).
func reproValue(ctx map[string]any, key string) any {
	if r, ok := ctx["repro"].(map[string]any); ok {
		if v, ok := r[key]; ok && v != nil {
			return v
		}
	}
	return ctx[key]
}

func buildEnvironment(ctx map[string]any, f store.Feedback) map[string]any {
	out := map[string]any{}

	url := f.URL
	if v := asString(ctx["url"]); v != "" {
		url = v
	}
	if url != "" {
		out["url"] = redactSecrets(url)
	}
	if v := ctx["viewport"]; v != nil {
		out["viewport"] = v
	}
	if v, ok := ctx["devicePixelRatio"].(float64); ok {
		out["device_pixel_ratio"] = v
	}
	if v := asString(ctx["userAgent"]); v != "" {
		out["user_agent"] = v
	}
	if s, ok := ctx["source"].(map[string]any); ok {
		if v := asString(s["framework"]); v != "" {
			out["framework"] = v
		}
	}
	if _, has := out["framework"]; !has {
		if v := asString(ctx["framework"]); v != "" {
			out["framework"] = v
		}
	}
	if v := ctx["cssFramework"]; v != nil {
		out["css_framework"] = v
	}
	if v := asString(ctx["branch"]); v != "" {
		out["branch"] = v
	}
	if v := asString(ctx["appVersion"]); v != "" {
		out["version"] = v
	}
	if v := asString(ctx["sessionId"]); v != "" {
		out["session_id"] = v
	}
	if v := asString(ctx["traceId"]); v != "" {
		out["trace_id"] = v
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func buildVisual(f store.Feedback) map[string]any {
	out := map[string]any{}
	if len(f.Screenshot) > 0 {
		out["screenshot_ref"] = fmt.Sprintf("feedback://%d/screenshot", f.ID)
	}
	if len(f.Snapshot) > 0 {
		out["snapshot_ref"] = fmt.Sprintf("feedback://%d/snapshot", f.ID)
	}
	if len(f.Replay) > 0 {
		out["replay_ref"] = fmt.Sprintf("feedback://%d/replay", f.ID)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func buildVerification(ctx map[string]any) map[string]any {
	out := map[string]any{}
	if v, ok := ctx["verification"].(map[string]any); ok && len(v) > 0 {
		if c := v["contract"]; c != nil {
			out["contract"] = c
		}
		if s := asString(v["criteria"]); s != "" {
			out["criteria"] = s
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func buildProvenance(ctx map[string]any) map[string]any {
	out := map[string]any{}
	if p, ok := ctx["provenance"].(map[string]any); ok {
		for k, v := range p {
			out[k] = v
		}
	}
	if _, has := out["summary"]; !has {
		if asString(ctx["summary"]) != "" {
			out["summary"] = "stated"
		} else {
			out["summary"] = "inferred"
		}
	}
	return out
}

// provenanceBadge returns the provenance marker for a trust_order key, using
// the client-stamped value when present and otherwise deriving a sensible
// default from what was actually captured.
func provenanceBadge(ctx map[string]any, key string, hasScreenshot bool) string {
	if p, ok := ctx["provenance"].(map[string]any); ok {
		if v := asString(p[key]); v != "" {
			return v
		}
	}
	switch key {
	case "target.source":
		if _, ok := ctx["source"].(map[string]any); ok {
			return "captured"
		}
	case "target.element.fingerprint":
		if fp, ok := ctx["fingerprint"].(map[string]any); ok && len(fp) > 0 {
			return "captured"
		}
		if attrs, ok := ctx["attributes"].(map[string]any); ok && len(attrs) > 0 {
			return "captured"
		}
	case "intent.expected":
		if i, ok := ctx["intent"].(map[string]any); ok && asString(i["expected"]) != "" {
			return "stated"
		}
	case "intent.actual":
		if i, ok := ctx["intent"].(map[string]any); ok && asString(i["actual"]) != "" {
			return "stated"
		}
	case "intent.changes":
		if i, ok := ctx["intent"].(map[string]any); ok {
			if arr, ok := i["changes"].([]any); ok && len(arr) > 0 {
				return "stated"
			}
		}
	case "target.element.selector":
		return "captured"
	case "visual.screenshot_ref":
		if hasScreenshot {
			return "captured"
		}
	case "target.element.computed_styles":
		if m, ok := ctx["computedStyles"].(map[string]any); ok && len(m) > 0 {
			return "captured"
		}
	case "environment.css_framework":
		if v, ok := ctx["cssFramework"].([]any); ok && len(v) > 0 {
			return "inferred"
		}
	case "summary":
		if asString(ctx["summary"]) != "" {
			return "stated"
		}
		return "inferred"
	}
	return "absent"
}

func asString(v any) string {
	s, _ := v.(string)
	return s
}

// strVal is an alias of asString kept for readability in issue rendering.
func strVal(v any) string {
	return asString(v)
}

// getMap walks m along keys and returns the final nested map (nil if any step
// is not a map).
func getMap(m map[string]any, keys ...string) map[string]any {
	var cur any = m
	for _, k := range keys {
		mm, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		cur = mm[k]
	}
	mm, _ := cur.(map[string]any)
	return mm
}

func stringSlice(v any) []string {
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, x := range arr {
		if s, ok := x.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func intOrZero(v any) int {
	switch n := v.(type) {
	case int:
		return n
	case int64:
		return int(n)
	case float64:
		return int(n)
	case float32:
		return int(n)
	}
	return 0
}

func confidenceRank(c string) int {
	switch c {
	case "exact":
		return 3
	case "approximate":
		return 2
	case "none":
		return 1
	}
	return 0
}
