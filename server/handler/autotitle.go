package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"time"

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

// generateSummary produces a summary: LLM (if configured, 2s cap) falling back
// to the deterministic heuristic. Never blocks on the LLM beyond the timeout.
func generateSummary(ctx map[string]any, f store.Feedback) string {
	if title, ok := llmTitle(ctx, f); ok && title != "" {
		return title
	}
	return heuristicSummary(ctx, f)
}

// llmEnabled reports whether LLM autotitle is configured.
func llmEnabled() bool {
	return os.Getenv("FEEDBACK_LLM_BASE_URL") != "" && os.Getenv("FEEDBACK_LLM_API_KEY") != ""
}

// llmTitle asks an OpenAI-compatible endpoint for a concise title. Returns
// (title, false) on any error/timeout/absence of config.
func llmTitle(ctx map[string]any, f store.Feedback) (string, bool) {
	base := os.Getenv("FEEDBACK_LLM_BASE_URL")
	key := os.Getenv("FEEDBACK_LLM_API_KEY")
	if base == "" || key == "" {
		return "", false
	}
	model := os.Getenv("FEEDBACK_LLM_MODEL")
	if model == "" {
		model = "gpt-4o-mini"
	}

	prompt := titlePrompt(ctx, f)

	reqCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	payload := map[string]any{
		"model": model,
		"messages": []map[string]string{
			{"role": "system", "content": "You write concise bug-report titles. Return only the title, no quotes, max 80 characters."},
			{"role": "user", "content": prompt},
		},
	}
	body, _ := json.Marshal(payload)

	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, strings.TrimRight(base, "/")+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return "", false
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", false
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return "", false
	}

	var out struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil || len(out.Choices) == 0 {
		return "", false
	}

	title := strings.TrimSpace(out.Choices[0].Message.Content)
	title = strings.Trim(title, "\"`")
	if title == "" {
		return "", false
	}
	return truncate(title, 120), true
}

// titlePrompt builds a minimal prompt from comment + intent signals.
func titlePrompt(ctx map[string]any, f store.Feedback) string {
	var b strings.Builder
	if f.Comment != "" {
		b.WriteString("Comment: " + redactSecrets(f.Comment) + "\n")
	}
	intent := getMap(ctx, "intent")
	if action := strVal(intent["action"]); action != "" {
		b.WriteString("Action: " + action + "\n")
	}
	if expected := strVal(intent["expected"]); expected != "" {
		b.WriteString("Expected: " + expected + "\n")
	}
	if b.Len() == 0 {
		return "Write a title for this feedback."
	}
	return b.String() + "Write a short title for this feedback."
}
