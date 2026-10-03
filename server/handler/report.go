package handler

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strconv"

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
	names, err := h.userRepos(c)
	if err != nil {
		return err
	}
	items, err := h.Store.ListExported(c.Request().Context(), names)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to list reports")
	}
	out := make([]reportSummary, 0, len(items))
	for _, f := range items {
		out = append(out, reportSummary{
			ID:        f.ID,
			Repo:      f.Repo,
			URL:       f.URL,
			Selector:  f.Selector,
			Comment:   redactSecrets(f.Comment),
			IssueURL:  f.IssueURL,
			CreatedAt: f.CreatedAt.Format("2006-01-02T15:04:05Z"),
		})
	}
	return c.JSON(http.StatusOK, out)
}

// HandleGetReport handles GET /api/reports/:id — full detail for a single
// exported report, gated by repo scope.
func (h *Handler) HandleGetReport(c echo.Context) error {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid report id")
	}
	f, err := h.Store.Get(c.Request().Context(), id)
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

	detail := reportDetail{
		reportSummary: reportSummary{
			ID:        f.ID,
			Repo:      f.Repo,
			URL:       f.URL,
			Selector:  f.Selector,
			Comment:   redactSecrets(f.Comment),
			IssueURL:  f.IssueURL,
			CreatedAt: f.CreatedAt.Format("2006-01-02T15:04:05Z"),
		},
		Context: redactContext(m),
	}

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
