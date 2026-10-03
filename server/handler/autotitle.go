package handler

import (
	"strings"

	"github.com/emergent-company/emergent.feedback/server/store"
)

// heuristicSummary builds a concise, deterministic title from intent action +
// element label + expected, e.g. "Change contrast ratio on UpgradeButton".
// Returns "" when no structured signals are available (caller falls back).
func heuristicSummary(ctx map[string]any, f store.Feedback) string {
	intent := getMap(ctx, "intent")
	action := strVal(intent["action"])
	expected := redactSecrets(strVal(intent["expected"]))
	label := elementLabel(ctx)

	if action == "" && expected == "" && label == "" {
		return ""
	}

	var parts []string
	if v := actionVerb(action); v != "" {
		parts = append(parts, v)
	}
	if expected != "" {
		parts = append(parts, lowerFirst(truncate(expected, 60)))
	}
	if label != "" {
		parts = append(parts, "on "+label)
	}
	if len(parts) == 0 {
		return ""
	}
	return truncate(strings.Join(parts, " "), 120)
}

// actionVerb maps an intent action to a capitalized title verb.
func actionVerb(action string) string {
	switch action {
	case "change":
		return "Change"
	case "add":
		return "Add"
	case "remove":
		return "Remove"
	case "move":
		return "Move"
	case "fix":
		return "Fix"
	case "refactor":
		return "Refactor"
	case "investigate":
		return "Investigate"
	}
	return ""
}

// elementLabel returns the best short label for the element: explicit label,
// else the last data-component segment.
func elementLabel(ctx map[string]any) string {
	if v := asString(ctx["label"]); v != "" {
		return v
	}
	if v := asString(ctx["dataComponent"]); v != "" {
		parts := strings.Split(v, ">")
		if seg := strings.TrimSpace(parts[len(parts)-1]); seg != "" {
			return seg
		}
	}
	return ""
}

// lowerFirst lowercases the first rune of s (for a phrase following a verb).
func lowerFirst(s string) string {
	r := []rune(s)
	if len(r) == 0 {
		return s
	}
	r[0] = []rune(strings.ToLower(string(r[0])))[0]
	return string(r)
}
