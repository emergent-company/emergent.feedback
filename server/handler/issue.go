package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/emergent-company/emergent.feedback/server/github"
	"github.com/emergent-company/emergent.feedback/server/middleware"
	"github.com/emergent-company/emergent.feedback/server/store"
	"github.com/labstack/echo/v4"
	"golang.org/x/net/html"
)

// exportIssueRequest is the JSON body for POST /issue/export.
type exportIssueRequest struct {
	IDs    []int64  `json:"ids"`
	Repo   string   `json:"repo"`
	Labels []string `json:"labels"`
	Title  string   `json:"title"` // optional override; server generates one if empty
}

// HandleExportIssue creates a GitHub issue from one or more feedback items.
func (h *Handler) HandleExportIssue(c echo.Context) error {
	var req exportIssueRequest
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request body")
	}
	if len(req.IDs) == 0 {
		return echo.NewHTTPError(http.StatusBadRequest, "at least one feedback id is required")
	}
	if req.Repo == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "repo is required")
	}

	ctx := c.Request().Context()

	// Fetch all requested feedback items.
	var items []store.Feedback
	for _, id := range req.IDs {
		f, err := h.Store.Get(ctx, id)
		if err != nil {
			return echo.NewHTTPError(http.StatusNotFound, fmt.Sprintf("feedback %d not found", id))
		}
		items = append(items, f)
	}

	labels := req.Labels
	if len(labels) == 0 && len(items) > 0 {
		labels = []string{items[0].Label}
	}

	login := middleware.GetLogin(c)
	for _, f := range items {
		if f.GitHubUser != login {
			return echo.NewHTTPError(http.StatusForbidden, "cannot export feedback you do not own")
		}
	}
	title, body := buildIssueContent(items, login)
	if req.Title != "" {
		title = req.Title
	}

	// Use a server-side GitHub App installation token — not subject to org OAuth restrictions.
	installToken, err := h.GHConfig.InstallationToken(ctx)
	if err != nil {
		c.Logger().Errorf("get installation token: %v", err)
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to get installation token")
	}

	result, err := github.CreateIssue(ctx, installToken, github.CreateIssueParams{
		Repo:   req.Repo,
		Title:  title,
		Body:   body,
		Labels: labels,
	})
	if err != nil {
		c.Logger().Errorf("create github issue: %v", err)
		return echo.NewHTTPError(http.StatusBadGateway, "failed to create GitHub issue")
	}

	// Mark items as exported.
	if err := h.Store.MarkExported(ctx, req.IDs, result.HTMLURL); err != nil {
		c.Logger().Errorf("mark exported: %v", err)
	}

	// Store the issue reference for badge display.
	feedbackIDs, _ := json.Marshal(req.IDs)
	if err := h.Store.CreateGitHubIssue(ctx, store.GitHubIssue{
		IssueNumber: int64(result.Number),
		IssueURL:    result.HTMLURL,
		Repo:        req.Repo,
		Title:       title,
		PageURL:     items[0].URL,
		Selector:    items[0].Selector,
		FeedbackIDs: string(feedbackIDs),
	}); err != nil {
		c.Logger().Errorf("store github issue: %v", err)
	}

	return c.JSON(http.StatusOK, map[string]any{
		"issue_url":    result.HTMLURL,
		"issue_number": result.Number,
	})
}

// buildIssueContent formats the GitHub issue title and Markdown body.
func buildIssueContent(items []store.Feedback, _ string) (title, body string) {
	if len(items) == 0 {
		return "Feedback report", ""
	}

	first := items[0]

	// Title: short description only — no URL.
	if len(items) == 1 {
		title = fmt.Sprintf("Feedback on %s", selectorShort(first.Selector))
	} else {
		title = fmt.Sprintf("Feedback: %d comments on %s", len(items), selectorShort(first.Selector))
	}

	// Parse context from the first item to extract page-level metadata.
	ctx := parseContext(first.ContextJSON)

	var sb strings.Builder
	sb.WriteString("## Feedback\n\n")

	// Page-level metadata (from first item's context).
	pageURL := first.URL
	if u, ok := ctx["url"].(string); ok && u != "" {
		pageURL = u
	}
	fmt.Fprintf(&sb, "**URL:** %s  \n", pageURL)

	if branch, ok := ctx["branch"].(string); ok && branch != "" {
		fmt.Fprintf(&sb, "**Branch:** `%s`  \n", branch)
	}
	if appVersion, ok := ctx["appVersion"].(string); ok && appVersion != "" {
		fmt.Fprintf(&sb, "**Version:** `%s`  \n", appVersion)
	}

	if vp, ok := ctx["viewport"].(map[string]any); ok {
		w, _ := vp["width"].(float64)
		h, _ := vp["height"].(float64)
		dpr, _ := ctx["devicePixelRatio"].(float64)
		if w > 0 && h > 0 {
			fmt.Fprintf(&sb, "**Viewport:** %.0f × %.0f px", w, h)
			if dpr > 0 && dpr != 1 {
				fmt.Fprintf(&sb, " (%.1f× DPR)", dpr)
			}
			sb.WriteString("  \n")
		}
	}

	sb.WriteString("\n---\n\n")

	// One comment block per feedback item.
	for i, f := range items {
		fmt.Fprintf(&sb, "### Comment %d\n\n", i+1)
		fmt.Fprintf(&sb, "**@%s**  \n%s\n\n", f.GitHubUser, f.Comment)
	}

	sb.WriteString("---\n\n")

	// Element info — written once, not per comment.
	fmt.Fprintf(&sb, "**Selector:** `%s`\n\n", first.Selector)

	// Element position & size (visible, not folded).
	if br, ok := ctx["boundingRect"].(map[string]any); ok {
		top, _ := br["top"].(float64)
		left, _ := br["left"].(float64)
		w, _ := br["width"].(float64)
		h, _ := br["height"].(float64)
		fmt.Fprintf(&sb, "**Position:** top %.0f, left %.0f — **Size:** %.0f × %.0f px  \n\n", top, left, w, h)
	}

	// CSS framework detection (visible, not folded).
	if frameworks, ok := ctx["cssFramework"].([]any); ok && len(frameworks) > 0 {
		names := make([]string, 0, len(frameworks))
		for _, f := range frameworks {
			if s, ok := f.(string); ok {
				names = append(names, s)
			}
		}
		if len(names) > 0 {
			fmt.Fprintf(&sb, "**CSS framework:** %s  \n\n", strings.Join(names, ", "))
		}
	}

	// Key computed styles (visible, not folded).
	if styles, ok := ctx["computedStyles"].(map[string]any); ok && len(styles) > 0 {
		sb.WriteString("<details><summary>Computed styles</summary>\n\n```\n")
		// Stable key order: layout first, then visual.
		order := []string{
			"display", "position", "flexDirection", "flexWrap", "alignItems", "justifyContent",
			"gridTemplateColumns", "gridTemplateRows",
			"width", "height", "minWidth", "minHeight", "maxWidth", "maxHeight",
			"margin", "padding",
			"color", "backgroundColor", "opacity",
			"fontSize", "fontFamily", "fontWeight", "lineHeight", "textAlign",
			"border", "borderRadius", "boxShadow",
			"overflow", "overflowX", "overflowY",
			"zIndex", "visibility", "cursor",
		}
		for _, k := range order {
			if v, ok := styles[k].(string); ok {
				fmt.Fprintf(&sb, "%-24s %s\n", k+":", v)
			}
		}
		sb.WriteString("```\n\n</details>\n\n")
	}

	// Foldable: element HTML + full context JSON (from first item, shown once).
	outerHTML, _ := ctx["outerHTML"].(string)
	prettyCtx := prettyJSON(first.ContextJSON)

	sb.WriteString("<details><summary>Element HTML &amp; full context</summary>\n\n")
	if outerHTML != "" {
		sb.WriteString("**HTML**\n\n```html\n")
		sb.WriteString(prettyHTML(outerHTML))
		sb.WriteString("\n```\n\n")
	}
	sb.WriteString("**Context**\n\n```json\n")
	sb.WriteString(prettyCtx)
	sb.WriteString("\n```\n\n")
	sb.WriteString("</details>\n")

	// Session history (from client-side ring buffer).
	if history, ok := ctx["sessionHistory"].([]any); ok && len(history) > 0 {
		sb.WriteString("<details><summary>Session history</summary>\n\n")
		sb.WriteString("| # | Time | Type | Detail |\n")
		sb.WriteString("|---|------|------|--------|\n")
		for i, raw := range history {
			ev, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			evType, _ := ev["type"].(string)
			evTime := formatEventTime(ev["timestamp"])
			evData, _ := ev["data"].(map[string]any)
			detail := formatEventDetail(evType, evData)
			fmt.Fprintf(&sb, "| %d | %s | %s | %s |\n", i+1, evTime, evType, detail)
		}
		sb.WriteString("\n</details>\n")
	}

	return title, sb.String()
}

// issueSyncInterval bounds how often a single issue's GitHub state is
// re-checked; issueSyncPerRequest caps GitHub calls per badge load.
const (
	issueSyncInterval   = 5 * time.Minute
	issueSyncPerRequest = 20
)

// HandleListIssues handles GET /issues?url=<url>.
// Returns open GitHub issues recorded for a page, for badge rendering.
func (h *Handler) HandleListIssues(c echo.Context) error {
	pageURL := c.QueryParam("url")
	if pageURL == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "url query parameter is required")
	}

	ctx := c.Request().Context()
	issues, err := h.Store.ListOpenGitHubIssuesByURL(ctx, pageURL)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to list issues")
	}

	issues = h.syncIssueStates(ctx, issues)

	type issueBadge struct {
		Selector    string `json:"selector"`
		IssueNumber int64  `json:"issue_number"`
		IssueURL    string `json:"issue_url"`
		Title       string `json:"title"`
	}
	out := make([]issueBadge, 0, len(issues))
	for _, gi := range issues {
		if gi.State != "open" {
			continue
		}
		out = append(out, issueBadge{
			Selector:    gi.Selector,
			IssueNumber: gi.IssueNumber,
			IssueURL:    gi.IssueURL,
			Title:       gi.Title,
		})
	}
	return c.JSON(http.StatusOK, out)
}

// syncIssueStates re-checks the GitHub state of issues whose local state is
// stale, updating the store and returning the possibly-updated list. It is
// best-effort: any sync error leaves the issue in its last known state.
func (h *Handler) syncIssueStates(ctx context.Context, issues []store.GitHubIssue) []store.GitHubIssue {
	var token string
	tokenReady := false
	synced := 0
	for i := range issues {
		if time.Since(issues[i].SyncedAt) <= issueSyncInterval {
			continue
		}
		if synced >= issueSyncPerRequest {
			break
		}
		if !tokenReady {
			t, err := h.GHConfig.InstallationToken(ctx)
			if err != nil {
				// Can't authenticate to GitHub right now; keep last known state.
				break
			}
			token = t
			tokenReady = true
		}
		state, err := github.GetIssue(ctx, token, issues[i].Repo, issues[i].IssueNumber)
		if err != nil {
			continue
		}
		if err := h.Store.SetGitHubIssueState(ctx, issues[i].IssueNumber, issues[i].Repo, state); err == nil {
			issues[i].State = state
			synced++
		}
	}
	return issues
}

// selectorShort returns the last segment of a CSS selector for use in titles.
func selectorShort(sel string) string {
	parts := strings.Split(sel, ">")
	last := strings.TrimSpace(parts[len(parts)-1])
	if len(last) > 60 {
		return last[:57] + "…"
	}
	return last
}

// formatEventTime formats an event timestamp (ISO string) to HH:MM:SS.
func formatEventTime(v any) string {
	s, ok := v.(string)
	if !ok || s == "" {
		return ""
	}
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		if len(s) < 19 {
			return s
		}
		// Try without timezone.
		t, err = time.Parse("2006-01-02T15:04:05", s[:19])
		if err != nil {
			return s
		}
	}
	return t.Format("15:04:05")
}

// formatEventDetail returns a Markdown-safe single-line detail string for an event.
func formatEventDetail(typ string, data map[string]any) string {
	if data == nil {
		return ""
	}
	switch typ {
	case "navigation":
		prev := shortenEventURL(data["previousUrl"])
		url := shortenEventURL(data["url"])
		return fmt.Sprintf("%s → %s", prev, url)
	case "input":
		tag, _ := data["tagName"].(string)
		comp, _ := data["component"].(string)
		val, _ := data["value"].(string)
		if len(val) > 60 {
			val = val[:57] + "..."
		}
		if comp != "" {
			return fmt.Sprintf("`%s` [%s] = \"%s\"", tag, comp, val)
		}
		return fmt.Sprintf("`%s` = \"%s\"", tag, val)
	case "click":
		tag, _ := data["tagName"].(string)
		comp, _ := data["component"].(string)
		text, _ := data["text"].(string)
		if comp != "" {
			return fmt.Sprintf("`%s` [%s] \"%s\"", tag, comp, text)
		}
		return fmt.Sprintf("`%s` \"%s\"", tag, text)
	default:
		return ""
	}
}

// shortenEventURL shortens a URL to path+query for display, or returns a placeholder.
func shortenEventURL(v any) string {
	s, ok := v.(string)
	if !ok || s == "" {
		return "(initial page)"
	}
	u, err := url.Parse(s)
	if err != nil {
		return s
	}
	out := u.Path
	if u.RawQuery != "" {
		out += "?" + u.RawQuery
	}
	if out == "" {
		out = "/"
	}
	return out
}

// parseContext unmarshals a context JSON string into a map.
func parseContext(raw string) map[string]any {
	if raw == "" || raw == "{}" {
		return nil
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		return nil
	}
	return m
}

// prettyJSON returns a pretty-printed version of a JSON string.
func prettyJSON(raw string) string {
	if raw == "" {
		return "{}"
	}
	var buf bytes.Buffer
	if err := json.Indent(&buf, []byte(raw), "", "  "); err != nil {
		return raw
	}
	return buf.String()
}

// voidElements are HTML elements that have no closing tag.
var voidElements = map[string]bool{
	"area": true, "base": true, "br": true, "col": true, "embed": true,
	"hr": true, "img": true, "input": true, "link": true, "meta": true,
	"param": true, "source": true, "track": true, "wbr": true,
}

// prettyHTML indents an HTML fragment using the x/net tokenizer.
// Falls back to the raw string on any parse error.
func prettyHTML(raw string) string {
	z := html.NewTokenizer(strings.NewReader(raw))
	var buf strings.Builder
	depth := 0
	const tab = "  "

	writeIndent := func() {
		for i := 0; i < depth; i++ {
			buf.WriteString(tab)
		}
	}

	for {
		tt := z.Next()
		switch tt {
		case html.ErrorToken:
			// EOF or parse error — return what we have (or raw on empty).
			result := strings.TrimRight(buf.String(), "\n")
			if result == "" {
				return raw
			}
			return result

		case html.StartTagToken:
			tok := z.Token()
			writeIndent()
			buf.WriteString(tok.String())
			buf.WriteByte('\n')
			if !voidElements[tok.Data] {
				depth++
			}

		case html.EndTagToken:
			tok := z.Token()
			if !voidElements[tok.Data] {
				depth--
				if depth < 0 {
					depth = 0
				}
			}
			writeIndent()
			buf.WriteString(tok.String())
			buf.WriteByte('\n')

		case html.SelfClosingTagToken:
			tok := z.Token()
			writeIndent()
			buf.WriteString(tok.String())
			buf.WriteByte('\n')

		case html.TextToken:
			text := strings.TrimSpace(string(z.Text()))
			if text == "" {
				continue
			}
			writeIndent()
			buf.WriteString(text)
			buf.WriteByte('\n')

		case html.CommentToken:
			writeIndent()
			buf.WriteString(z.Token().String())
			buf.WriteByte('\n')
		}
	}
}
