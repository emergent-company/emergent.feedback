package handler

import (
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/emergent-company/emergent.feedback/server/middleware"
	"github.com/emergent-company/emergent.feedback/server/store"
	"github.com/labstack/echo/v4"
)

// createFeedbackRequest is the JSON body for POST /feedback.
type createFeedbackRequest struct {
	URL         string `json:"url"`
	Selector    string `json:"selector"`
	Comment     string `json:"comment"`
	ContextJSON any    `json:"context"`
	Screenshot  string `json:"screenshot"` // base64-encoded PNG, may be empty
	Snapshot    string `json:"snapshot"`
	Repo        string `json:"repo"`
	Label       string `json:"label"`
}

// HandleCreateFeedback handles POST /feedback.
func (h *Handler) HandleCreateFeedback(c echo.Context) error {
	var req createFeedbackRequest
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request body")
	}
	if req.URL == "" || req.Selector == "" || req.Comment == "" || req.Repo == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "url, selector, comment, and repo are required")
	}

	ctxJSON := "{}"
	if req.ContextJSON != nil {
		b, _ := json.Marshal(req.ContextJSON)
		ctxJSON = string(b)
	}

	var screenshot []byte
	if req.Screenshot != "" {
		// Strip data URL prefix if present.
		raw := req.Screenshot
		if idx := strings.Index(raw, ","); idx != -1 {
			raw = raw[idx+1:]
		}
		var err error
		screenshot, err = base64.StdEncoding.DecodeString(raw)
		if err != nil {
			return echo.NewHTTPError(http.StatusBadRequest, "invalid screenshot encoding")
		}
	}

	var snapshot []byte
	if req.Snapshot != "" {
		var buf bytes.Buffer
		gw := gzip.NewWriter(&buf)
		if _, err := gw.Write([]byte(req.Snapshot)); err != nil {
			return echo.NewHTTPError(http.StatusBadRequest, "invalid snapshot")
		}
		if err := gw.Close(); err != nil {
			return echo.NewHTTPError(http.StatusBadRequest, "invalid snapshot")
		}
		snapshot = buf.Bytes()
	}

	f, err := h.Store.Create(c.Request().Context(), store.CreateParams{
		URL:         req.URL,
		Selector:    req.Selector,
		Comment:     req.Comment,
		ContextJSON: ctxJSON,
		Screenshot:  screenshot,
		Snapshot:    snapshot,
		GitHubUser:  middleware.GetLogin(c),
		Repo:        req.Repo,
		Label:       req.Label,
	})
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to save feedback")
	}

	return c.JSON(http.StatusCreated, map[string]any{
		"id":         f.ID,
		"created_at": f.CreatedAt,
	})
}

// badgeSummary is the response shape for GET /feedback?url=...
type badgeSummary struct {
	Selector string  `json:"selector"`
	Count    int64   `json:"count"`
	IDs      []int64 `json:"ids"`
}

// HandleListFeedback handles GET /feedback?url=<url>.
// Returns per-selector counts suitable for badge rendering.
func (h *Handler) HandleListFeedback(c echo.Context) error {
	pageURL := c.QueryParam("url")
	if pageURL == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "url query parameter is required")
	}

	summaries, err := h.Store.ListByURLSummary(c.Request().Context(), pageURL)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to list feedback")
	}

	out := make([]badgeSummary, 0, len(summaries))
	for _, s := range summaries {
		out = append(out, badgeSummary{
			Selector: s.Selector,
			Count:    s.Count,
			IDs:      s.IDs,
		})
	}
	return c.JSON(http.StatusOK, out)
}

// HandleListFeedbackByURL handles GET /feedback/list?url=<url>.
// Returns full comment details for all open items on a page (public).
func (h *Handler) HandleListFeedbackByURL(c echo.Context) error {
	pageURL := c.QueryParam("url")
	if pageURL == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "url query parameter is required")
	}

	items, err := h.Store.ListByURL(c.Request().Context(), pageURL)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to list feedback")
	}

	type item struct {
		ID         int64  `json:"id"`
		Selector   string `json:"selector"`
		Comment    string `json:"comment"`
		GitHubUser string `json:"github_user"`
		CreatedAt  string `json:"created_at"`
	}
	out := make([]item, 0, len(items))
	for _, f := range items {
		out = append(out, item{
			ID:         f.ID,
			Selector:   f.Selector,
			Comment:    f.Comment,
			GitHubUser: f.GitHubUser,
			CreatedAt:  f.CreatedAt.Format("2006-01-02 15:04"),
		})
	}
	return c.JSON(http.StatusOK, out)
}

// HandleGetFeedback handles GET /feedback/:id.
func (h *Handler) HandleGetFeedback(c echo.Context) error {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid feedback id")
	}

	f, err := h.Store.Get(c.Request().Context(), id)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "feedback not found")
	}
	if f.GitHubUser != middleware.GetLogin(c) {
		return echo.NewHTTPError(http.StatusForbidden, "feedback not found")
	}

	resp := map[string]any{
		"id":             f.ID,
		"url":            f.URL,
		"selector":       f.Selector,
		"comment":        f.Comment,
		"context":        json.RawMessage(f.ContextJSON),
		"github_user":    f.GitHubUser,
		"repo":           f.Repo,
		"label":          f.Label,
		"status":         f.Status,
		"issue_url":      f.IssueURL,
		"created_at":     f.CreatedAt,
		"has_screenshot": len(f.Screenshot) > 0,
	}
	return c.JSON(http.StatusOK, resp)
}

// HandleDeleteFeedback handles DELETE /feedback/:id.
// Only the original submitter can delete their own items.
func (h *Handler) HandleDeleteFeedback(c echo.Context) error {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid feedback id")
	}

	if err := h.Store.Delete(c.Request().Context(), id, middleware.GetLogin(c)); err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "feedback not found or not owned by you")
	}
	return c.NoContent(http.StatusNoContent)
}
