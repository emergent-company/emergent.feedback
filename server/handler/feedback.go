package handler

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/emergent-company/emergent.feedback/server/github"
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

	dedupeKey := computeDedupeKey(req.Repo, req.Selector, ctxJSON, req.Comment)

	f, err := h.Store.Create(c.Request().Context(), store.CreateParams{
		URL:         req.URL,
		Selector:    req.Selector,
		Comment:     req.Comment,
		ContextJSON: ctxJSON,
		Screenshot:  screenshot,
		Snapshot:    snapshot,
		DedupeKey:   dedupeKey,
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

// computeDedupeKey returns a stable sha256 key from repo + selector +
// fingerprint.path + normalized comment.
func computeDedupeKey(repo, selector, contextJSON, comment string) string {
	fpPath := ""
	if m := parseContext(contextJSON); m != nil {
		if fp, ok := m["fingerprint"].(map[string]any); ok {
			fpPath = asString(fp["path"])
		}
	}
	normalized := normalizeComment(comment)
	sum := sha256.Sum256([]byte(repo + "\x00" + selector + "\x00" + fpPath + "\x00" + normalized))
	return hex.EncodeToString(sum[:])
}

// normalizeComment lowercases and collapses whitespace for stable comparison.
func normalizeComment(s string) string {
	return strings.Join(strings.Fields(strings.ToLower(s)), " ")
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
			Comment:    redactSecrets(f.Comment),
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

	ctx := parseContext(f.ContextJSON)
	if ctx == nil {
		ctx = map[string]any{}
	}

	resp := map[string]any{
		"id":             f.ID,
		"url":            f.URL,
		"selector":       f.Selector,
		"comment":        redactSecrets(f.Comment),
		"context":        redactContext(ctx),
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

// parseFeedbackID extracts and validates the :id path param.
func parseFeedbackID(c echo.Context) (int64, error) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		return 0, echo.NewHTTPError(http.StatusBadRequest, "invalid feedback id")
	}
	return id, nil
}

// ownedFeedback loads a feedback item and enforces ownership.
func (h *Handler) ownedFeedback(c echo.Context, id int64) (store.Feedback, error) {
	f, err := h.Store.Get(c.Request().Context(), id)
	if err != nil {
		return store.Feedback{}, echo.NewHTTPError(http.StatusNotFound, "feedback not found")
	}
	if f.GitHubUser != middleware.GetLogin(c) {
		return store.Feedback{}, echo.NewHTTPError(http.StatusForbidden, "feedback not found")
	}
	return f, nil
}

// issueNumberFromURL extracts the issue number from a GitHub issue URL.
func issueNumberFromURL(issueURL string) (int64, bool) {
	u, err := url.Parse(issueURL)
	if err != nil {
		return 0, false
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(parts) == 0 {
		return 0, false
	}
	n, err := strconv.ParseInt(parts[len(parts)-1], 10, 64)
	if err != nil {
		return 0, false
	}
	return n, true
}

// commentOnIssue posts a best-effort comment to the item's GitHub issue.
func (h *Handler) commentOnIssue(ctx context.Context, f store.Feedback, body string) error {
	if f.IssueURL == "" {
		return nil
	}
	num, ok := issueNumberFromURL(f.IssueURL)
	if !ok {
		return fmt.Errorf("cannot parse issue number from %q", f.IssueURL)
	}
	token, err := h.GHConfig.InstallationToken(ctx)
	if err != nil {
		return err
	}
	return github.CommentIssue(ctx, token, f.Repo, num, body)
}

// closeIssue closes the item's GitHub issue and updates local state.
func (h *Handler) closeIssue(ctx context.Context, f store.Feedback) error {
	if f.IssueURL == "" {
		return nil
	}
	num, ok := issueNumberFromURL(f.IssueURL)
	if !ok {
		return fmt.Errorf("cannot parse issue number from %q", f.IssueURL)
	}
	token, err := h.GHConfig.InstallationToken(ctx)
	if err != nil {
		return err
	}
	if err := github.UpdateIssueState(ctx, token, f.Repo, num, "closed"); err != nil {
		return err
	}
	_ = h.Store.SetGitHubIssueState(ctx, num, f.Repo, "closed")
	return nil
}

func statusComment(action, summary string) string {
	if summary == "" {
		return fmt.Sprintf("Feedback %s.", action)
	}
	return fmt.Sprintf("Feedback %s: %s", action, summary)
}

// HandleMarkApplied handles POST /feedback/:id/applied.
func (h *Handler) HandleMarkApplied(c echo.Context) error {
	id, err := parseFeedbackID(c)
	if err != nil {
		return err
	}
	f, err := h.ownedFeedback(c, id)
	if err != nil {
		return err
	}
	var req struct {
		Summary string `json:"summary"`
	}
	_ = c.Bind(&req)

	ctx := c.Request().Context()
	if err := h.Store.SetStatus(ctx, id, store.StatusApplied, middleware.GetLogin(c), req.Summary); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to mark applied")
	}
	if err := h.commentOnIssue(ctx, f, statusComment("applied", req.Summary)); err != nil {
		c.Logger().Warnf("mark applied: github comment: %v", err)
	}
	return c.JSON(http.StatusOK, map[string]any{"id": id, "status": "applied"})
}

// HandleResolve handles POST /feedback/:id/resolve.
func (h *Handler) HandleResolve(c echo.Context) error {
	id, err := parseFeedbackID(c)
	if err != nil {
		return err
	}
	f, err := h.ownedFeedback(c, id)
	if err != nil {
		return err
	}
	var req struct {
		Summary string `json:"summary"`
	}
	_ = c.Bind(&req)

	ctx := c.Request().Context()
	if err := h.Store.SetStatus(ctx, id, store.StatusResolved, middleware.GetLogin(c), req.Summary); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to resolve")
	}
	if err := h.commentOnIssue(ctx, f, statusComment("resolved", req.Summary)); err != nil {
		c.Logger().Warnf("resolve: github comment: %v", err)
	}
	if err := h.closeIssue(ctx, f); err != nil {
		c.Logger().Warnf("resolve: github close: %v", err)
	}
	h.fireNotify("resolved", "resolved", f)
	return c.JSON(http.StatusOK, map[string]any{"id": id, "status": "resolved"})
}

// HandleVerifyResult handles POST /feedback/:id/verify-result.
func (h *Handler) HandleVerifyResult(c echo.Context) error {
	id, err := parseFeedbackID(c)
	if err != nil {
		return err
	}
	f, err := h.ownedFeedback(c, id)
	if err != nil {
		return err
	}
	var req struct {
		Result string `json:"result"`
		Detail string `json:"detail"`
	}
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request body")
	}
	if req.Result != "green" && req.Result != "amber" && req.Result != "red" {
		return echo.NewHTTPError(http.StatusBadRequest, "result must be green, amber, or red")
	}

	ctx := c.Request().Context()
	if err := h.Store.SetVerificationResult(ctx, id, req.Result, req.Detail); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to record verification")
	}
	if req.Result == "green" {
		if err := h.Store.SetStatus(ctx, id, store.StatusVerified, middleware.GetLogin(c), ""); err != nil {
			return echo.NewHTTPError(http.StatusInternalServerError, "failed to mark verified")
		}
		h.fireNotify("verified", "verified", f)
	}
	return c.JSON(http.StatusOK, map[string]any{"id": id, "result": req.Result})
}

// HandleGetVerify handles GET /feedback/:id/verify.
func (h *Handler) HandleGetVerify(c echo.Context) error {
	id, err := parseFeedbackID(c)
	if err != nil {
		return err
	}
	f, err := h.ownedFeedback(c, id)
	if err != nil {
		return err
	}

	ctx := parseContext(f.ContextJSON)
	var contract any
	criteria := ""
	if v, ok := ctx["verification"].(map[string]any); ok {
		contract = v["contract"]
		criteria = asString(v["criteria"])
	}
	return c.JSON(http.StatusOK, map[string]any{
		"id":          f.ID,
		"status":      string(f.Status),
		"contract":    contract,
		"criteria":    criteria,
		"last_result": f.VerificationResult,
		"last_detail": f.VerificationDetail,
	})
}

// HandleVerifyPending handles GET /feedback/verify-pending?url=<url>.
func (h *Handler) HandleVerifyPending(c echo.Context) error {
	pageURL := c.QueryParam("url")
	if pageURL == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "url query parameter is required")
	}

	items, err := h.Store.ListVerifyPending(c.Request().Context(), pageURL)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to list pending")
	}

	type pendingItem struct {
		ID       int64  `json:"id"`
		Selector string `json:"selector"`
		Contract any    `json:"contract"`
	}
	out := make([]pendingItem, 0, len(items))
	for _, it := range items {
		ctx := parseContext(it.ContextJSON)
		v, ok := ctx["verification"].(map[string]any)
		if !ok {
			continue
		}
		contract, has := v["contract"]
		if !has || contract == nil {
			continue
		}
		out = append(out, pendingItem{ID: it.ID, Selector: it.Selector, Contract: contract})
	}
	return c.JSON(http.StatusOK, out)
}

// HandleFeedbackStatus handles GET /feedback/status?url=<url> — returns the
// caller's own items' status on a page (for reporter notification).
func (h *Handler) HandleFeedbackStatus(c echo.Context) error {
	pageURL := c.QueryParam("url")
	if pageURL == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "url query parameter is required")
	}

	items, err := h.Store.ListStatusByURLAndUser(c.Request().Context(), pageURL, middleware.GetLogin(c))
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to list status")
	}

	type statusItem struct {
		ID       int64  `json:"id"`
		Selector string `json:"selector"`
		Status   string `json:"status"`
		IssueURL string `json:"issue_url"`
	}
	out := make([]statusItem, 0, len(items))
	for _, it := range items {
		out = append(out, statusItem{
			ID:       it.ID,
			Selector: it.Selector,
			Status:   string(it.Status),
			IssueURL: it.IssueURL,
		})
	}
	return c.JSON(http.StatusOK, out)
}
