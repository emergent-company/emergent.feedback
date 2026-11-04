package handler

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/emergent-company/emergent.feedback/server/store"
	"github.com/labstack/echo/v4"
)

type reportSummary struct {
	ID        int64  `json:"id"`
	Repo      string `json:"repo"`
	URL       string `json:"url"`
	Selector  string `json:"selector"`
	Comment   string `json:"comment"`
	IssueURL  string `json:"issue_url"`
	CreatedAt string `json:"created_at"`
	// IssueNumber/IssueState come from the linked github_issues record and let
	// the panel render issue status without calling GitHub on every page load.
	IssueNumber int64  `json:"issue_number,omitempty"`
	IssueState  string `json:"issue_state,omitempty"`
	// IssueStateSyncedAt is when the issue state was last refreshed from GitHub.
	IssueStateSyncedAt string `json:"issue_state_synced_at,omitempty"`
}

type reportDetail struct {
	reportSummary
	Context       map[string]any `json:"context"`
	Screenshot    *string        `json:"screenshot"`
	Snapshot      *string        `json:"snapshot"`
	HasScreenshot bool           `json:"has_screenshot"`
	HasSnapshot   bool           `json:"has_snapshot"`
}

// HandleListReports handles GET /api/reports — exported feedback items scoped
// to the authenticated user's repos.
func (h *Handler) HandleListReports(c echo.Context) error {
	ctx := c.Request().Context()
	names, err := h.userRepos(c)
	if err != nil {
		return err
	}
	items, err := h.Store.ListExported(ctx, names)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to list reports")
	}

	// Refresh stale issue states best-effort (capped per request). The stored
	// state is still rendered when GitHub cannot be reached.
	states := h.reportIssueStates(ctx, items)

	out := make([]reportSummary, 0, len(items))
	for _, f := range items {
		state := f.IssueState
		if s, ok := states[f.IssueURL]; ok && s != "" {
			state = s
		}
		out = append(out, reportSummary{
			ID:                 f.ID,
			Repo:               f.Repo,
			URL:                f.URL,
			Selector:           f.Selector,
			Comment:            redactSecrets(f.Comment),
			IssueURL:           f.IssueURL,
			CreatedAt:          f.CreatedAt.Format(time.RFC3339),
			IssueNumber:        f.IssueNumber,
			IssueState:         state,
			IssueStateSyncedAt: formatSyncedAt(f.IssueSyncedAt),
		})
	}
	return c.JSON(http.StatusOK, out)
}

// HandleGetReport handles GET /api/reports/:id — full detail for a single
// exported report, gated by repo scope.
func (h *Handler) HandleGetReport(c echo.Context) error {
	ctx := c.Request().Context()
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid report id")
	}
	f, err := h.Store.Get(ctx, id)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "report not found")
	}
	if f.IssueURL == "" {
		return echo.NewHTTPError(http.StatusNotFound, "report not found")
	}
	names, err := h.userRepos(c)
	if err != nil {
		return err
	}
	if !repoInScope(f.Repo, names) {
		return echo.NewHTTPError(http.StatusForbidden, "report not found")
	}

	var m map[string]any
	if f.ContextJSON != "" && f.ContextJSON != "{}" {
		if err := json.Unmarshal([]byte(f.ContextJSON), &m); err != nil {
			m = nil
		}
	}
	if m == nil {
		m = map[string]any{}
	}

	summary := reportSummary{
		ID:        f.ID,
		Repo:      f.Repo,
		URL:       f.URL,
		Selector:  f.Selector,
		Comment:   redactSecrets(f.Comment),
		IssueURL:  f.IssueURL,
		CreatedAt: f.CreatedAt.Format(time.RFC3339),
	}
	if gi, err := h.Store.GetGitHubIssueByURL(ctx, f.IssueURL); err == nil {
		summary.IssueNumber = gi.IssueNumber
		summary.IssueState = gi.State
		summary.IssueStateSyncedAt = formatSyncedAt(gi.SyncedAt)
	}

	detail := reportDetail{reportSummary: summary, Context: redactContext(m)}

	if len(f.Screenshot) > 0 {
		s := base64.StdEncoding.EncodeToString(f.Screenshot)
		detail.Screenshot = &s
		detail.HasScreenshot = true
	}
	if len(f.Snapshot) > 0 {
		html, err := decodeSnapshot(f.Snapshot)
		if err == nil {
			s := string(html)
			detail.Snapshot = &s
			detail.HasSnapshot = true
		}
	}

	return c.JSON(http.StatusOK, detail)
}

// reportIssueStates re-checks stale issue states for the given reports and
// returns the refreshed state keyed by issue URL. It reuses the badge
// endpoint's sync budget rules and never fails: unreachable GitHub leaves the
// stored state in place.
func (h *Handler) reportIssueStates(ctx context.Context, items []store.ExportedReport) map[string]string {
	issues := make([]store.GitHubIssue, 0, len(items))
	for _, f := range items {
		if f.IssueURL == "" || f.IssueNumber <= 0 {
			continue
		}
		issues = append(issues, store.GitHubIssue{
			IssueNumber: f.IssueNumber,
			IssueURL:    f.IssueURL,
			Repo:        f.Repo,
			State:       f.IssueState,
			SyncedAt:    f.IssueSyncedAt,
		})
	}
	out := make(map[string]string, len(issues))
	for _, gi := range h.syncIssueStates(ctx, issues) {
		out[gi.IssueURL] = gi.State
	}
	return out
}

func formatSyncedAt(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.Format(time.RFC3339)
}
