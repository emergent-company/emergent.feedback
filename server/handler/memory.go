package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/emergent-company/emergent.feedback/server/memory"
	"github.com/emergent-company/emergent.feedback/server/middleware"
	"github.com/emergent-company/emergent.feedback/server/store"
	"github.com/labstack/echo/v4"
)

const (
	memoryModeAsk  = "ask"
	memoryModeAuto = "auto"
	memoryModeOff  = "off"

	memoryIssueType   = "Issue"
	memoryScopeString = "graph:read graph:write schema:read projects:read"
)

type memoryConnectRequest struct {
	Repo      string `json:"repo"`
	BaseURL   string `json:"base_url"`
	ProjectID string `json:"project_id"`
	Token     string `json:"token"`
	Mode      string `json:"mode"`
}

type memoryModeRequest struct {
	Repo string `json:"repo"`
	Mode string `json:"mode"`
}

type memoryRepoRequest struct {
	Repo string `json:"repo"`
}

type memorySyncRequest struct {
	Repo       string `json:"repo"`
	FeedbackID int64  `json:"feedback_id"`
}

type memoryDestinationView struct {
	Repo        string `json:"repo"`
	BaseURL     string `json:"base_url"`
	ProjectID   string `json:"project_id"`
	ProjectName string `json:"project_name"`
	Mode        string `json:"mode"`
	Connected   bool   `json:"connected"`
	LastSyncAt  string `json:"last_sync_at,omitempty"`
	LastError   string `json:"last_error,omitempty"`
	CreatedAt   string `json:"created_at,omitempty"`
}

func memoryView(d store.MemoryDestination) memoryDestinationView {
	v := memoryDestinationView{
		Repo:        d.Repo,
		BaseURL:     d.BaseURL,
		ProjectID:   d.ProjectID,
		ProjectName: d.ProjectName,
		Mode:        d.Mode,
		Connected:   len(d.TokenEncrypted) > 0,
		LastError:   d.LastError,
	}
	if d.LastSyncAt != nil {
		v.LastSyncAt = d.LastSyncAt.UTC().Format(time.RFC3339)
	}
	if !d.CreatedAt.IsZero() {
		v.CreatedAt = d.CreatedAt.UTC().Format(time.RFC3339)
	}
	if v.Mode == "" {
		v.Mode = memoryModeAsk
	}
	return v
}

func normalizeMemoryBaseURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", fmt.Errorf("memory URL is required")
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return "", fmt.Errorf("memory URL must be an absolute http(s) URL")
	}
	if u.User != nil {
		return "", fmt.Errorf("memory URL must not contain credentials")
	}
	u.RawQuery = ""
	u.Fragment = ""
	u.Path = strings.TrimRight(u.Path, "/")
	return u.String(), nil
}

func validMemoryMode(mode string) bool {
	return mode == memoryModeAsk || mode == memoryModeAuto || mode == memoryModeOff
}

func (h *Handler) publicBaseURL(c echo.Context) string {
	if h.PublicBaseURL != "" {
		return strings.TrimRight(h.PublicBaseURL, "/")
	}
	scheme := "https"
	if c.Request().TLS == nil && c.Request().Header.Get("X-Forwarded-Proto") == "" {
		scheme = "http"
	}
	if p := c.Request().Header.Get("X-Forwarded-Proto"); p != "" {
		scheme = p
	}
	return scheme + "://" + c.Request().Host
}

func (h *Handler) memoryClient(d store.MemoryDestination) (*memory.Client, error) {
	token, err := decryptToken(d.TokenEncrypted, h.JWTSecret)
	if err != nil {
		return nil, fmt.Errorf("could not decrypt the stored Memory token: %w", err)
	}
	return memory.NewWithHTTP(d.BaseURL, token, h.MemoryHTTP), nil
}

// HandleCreateMemoryDestination connects a repo to a Memory project using a
// project-scoped emt_ token (the paste flow / permanent fallback).
//
// POST /api/memory/destinations
func (h *Handler) HandleCreateMemoryDestination(c echo.Context) error {
	var req memoryConnectRequest
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request body")
	}
	req.Repo = strings.TrimSpace(req.Repo)
	req.ProjectID = strings.TrimSpace(req.ProjectID)
	req.Token = strings.TrimSpace(req.Token)
	if req.Repo == "" || req.ProjectID == "" || req.Token == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "repo, project_id, and token are required")
	}
	if !strings.HasPrefix(req.Token, "emt_") {
		return echo.NewHTTPError(http.StatusBadRequest, "token must be a Memory project token (emt_…)")
	}
	base, err := normalizeMemoryBaseURL(req.BaseURL)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, err.Error())
	}
	mode := req.Mode
	if mode == "" {
		mode = memoryModeAsk
	}
	if !validMemoryMode(mode) {
		return echo.NewHTTPError(http.StatusBadRequest, "mode must be ask, auto, or off")
	}
	ok, err := h.callerCanAccessRepo(c, req.Repo)
	if err != nil {
		return h.repoAccessError(err)
	}
	if !ok {
		return echo.NewHTTPError(http.StatusForbidden, "you do not have access to this repository")
	}

	client := memory.NewWithHTTP(base, req.Token, h.MemoryHTTP)
	projects, err := client.ListProjects(c.Request().Context())
	if err != nil {
		return memoryConnectError(err)
	}
	projectName := ""
	for _, p := range projects {
		if p.ID == req.ProjectID {
			projectName = p.Name
			break
		}
	}
	if projectName == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "the token cannot access that project (check the project id and the projects:read scope)")
	}

	enc, err := encryptToken(req.Token, h.JWTSecret)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to store the Memory token")
	}
	d := store.MemoryDestination{
		Repo:            req.Repo,
		BaseURL:         base,
		ProjectID:       req.ProjectID,
		ProjectName:     projectName,
		TokenEncrypted:  enc,
		Scopes:          memoryScopeString,
		Mode:            mode,
		FeedbackBaseURL: h.publicBaseURL(c),
		CreatedBy:       middleware.GetLogin(c),
	}
	if err := h.Store.UpsertMemoryDestination(c.Request().Context(), d); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to save the Memory destination")
	}
	saved, err := h.Store.GetMemoryDestination(c.Request().Context(), req.Repo)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to load the Memory destination")
	}
	return c.JSON(http.StatusCreated, memoryView(saved))
}

// HandleListMemoryDestinations returns the signed-in user's destinations.
//
// GET /api/memory/destinations
func (h *Handler) HandleListMemoryDestinations(c echo.Context) error {
	items, err := h.Store.ListMemoryDestinations(c.Request().Context())
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to list Memory destinations")
	}
	// Destinations are repo-scoped, not user-scoped: every collaborator with
	// repo access sees (and can manage) the same connection. One repo listing
	// is enough to filter the small set of connected repos.
	repos, err := h.userRepos(c)
	if err != nil {
		return err
	}
	allowed := make(map[string]bool, len(repos))
	for _, r := range repos {
		allowed[r] = true
	}
	out := make([]memoryDestinationView, 0, len(items))
	for _, d := range items {
		if allowed[d.Repo] {
			out = append(out, memoryView(d))
		}
	}
	return c.JSON(http.StatusOK, out)
}

// HandleUpdateMemoryDestination changes the per-repo submit mode.
//
// PATCH /api/memory/destinations
func (h *Handler) HandleUpdateMemoryDestination(c echo.Context) error {
	var req memoryModeRequest
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request body")
	}
	if req.Repo == "" || !validMemoryMode(req.Mode) {
		return echo.NewHTTPError(http.StatusBadRequest, "repo and mode (ask|auto|off) are required")
	}
	d, err := h.ownedMemoryDestination(c, req.Repo)
	if err != nil {
		return err
	}
	if err := h.Store.SetMemoryDestinationMode(c.Request().Context(), d.Repo, req.Mode); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to update the Memory destination")
	}
	d.Mode = req.Mode
	return c.JSON(http.StatusOK, memoryView(d))
}

// HandleDeleteMemoryDestination disconnects a repo.
//
// DELETE /api/memory/destinations?repo=owner/name
func (h *Handler) HandleDeleteMemoryDestination(c echo.Context) error {
	repo := strings.TrimSpace(c.QueryParam("repo"))
	if repo == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "repo query parameter is required")
	}
	d, err := h.ownedMemoryDestination(c, repo)
	if err != nil {
		return err
	}
	revokeCtx, cancel := context.WithTimeout(c.Request().Context(), 8*time.Second)
	h.revokeMemoryToken(revokeCtx, d)
	cancel()
	if err := h.Store.DeleteMemoryDestination(c.Request().Context(), repo); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to disconnect the Memory destination")
	}
	return c.NoContent(http.StatusNoContent)
}

// HandleTestMemoryDestination verifies the stored token can still reach the
// project. It also clears/records last_error.
//
// POST /api/memory/destinations/test
func (h *Handler) HandleTestMemoryDestination(c echo.Context) error {
	var req memoryRepoRequest
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request body")
	}
	d, err := h.ownedMemoryDestination(c, req.Repo)
	if err != nil {
		return err
	}
	client, err := h.memoryClient(d)
	if err != nil {
		_ = h.Store.SetMemoryDestinationError(c.Request().Context(), d.ID, err.Error())
		return echo.NewHTTPError(http.StatusBadRequest, err.Error())
	}
	projects, err := client.ListProjects(c.Request().Context())
	if err != nil {
		msg := memoryErrorMessage(err)
		_ = h.Store.SetMemoryDestinationError(c.Request().Context(), d.ID, msg)
		return echo.NewHTTPError(http.StatusBadGateway, msg)
	}
	found := false
	for _, p := range projects {
		if p.ID == d.ProjectID {
			found = true
			break
		}
	}
	if !found {
		msg := "the token no longer has access to the connected project"
		_ = h.Store.SetMemoryDestinationError(c.Request().Context(), d.ID, msg)
		return echo.NewHTTPError(http.StatusBadGateway, msg)
	}
	_ = h.Store.SetMemoryDestinationError(c.Request().Context(), d.ID, "")
	return c.JSON(http.StatusOK, map[string]any{"ok": true, "project": d.ProjectName})
}

// HandleMemoryStatus is the public overlay probe: is this repo connected, and
// what is the submit mode? It deliberately exposes no connection details.
//
// GET /api/memory/status?repo=owner/name
func (h *Handler) HandleMemoryStatus(c echo.Context) error {
	repo := strings.TrimSpace(c.QueryParam("repo"))
	if repo == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "repo query parameter is required")
	}
	d, err := h.Store.GetMemoryDestination(c.Request().Context(), repo)
	if errors.Is(err, store.ErrMemoryDestinationNotFound) {
		return c.JSON(http.StatusOK, map[string]any{"connected": false, "mode": memoryModeOff})
	}
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to read the Memory destination")
	}
	return c.JSON(http.StatusOK, map[string]any{
		"connected": len(d.TokenEncrypted) > 0,
		"mode":      d.Mode,
	})
}

// HandleSyncFeedbackToMemory manually pushes (or retries) one feedback row.
//
// POST /api/memory/sync
func (h *Handler) HandleSyncFeedbackToMemory(c echo.Context) error {
	var req memorySyncRequest
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request body")
	}
	if req.FeedbackID == 0 || req.Repo == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "repo and feedback_id are required")
	}
	f, err := h.Store.Get(c.Request().Context(), req.FeedbackID)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "feedback not found")
	}
	d, err := h.ownedMemoryDestination(c, req.Repo)
	if err != nil {
		return err
	}
	if f.Repo != d.Repo {
		return echo.NewHTTPError(http.StatusBadRequest, "feedback does not belong to this repository")
	}
	if f.GitHubUser != middleware.GetLogin(c) && d.CreatedBy != middleware.GetLogin(c) {
		return echo.NewHTTPError(http.StatusForbidden, "feedback not found")
	}
	status, err := h.enqueueMemoryForFeedback(c.Request().Context(), f, d, true)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to queue the Memory sync")
	}
	if status == "skipped" {
		return c.JSON(http.StatusOK, map[string]any{"status": "skipped"})
	}
	h.ProcessMemoryOutbox(c.Request().Context())
	return c.JSON(http.StatusOK, map[string]any{"status": "queued"})
}

func (h *Handler) ownedMemoryDestination(c echo.Context, repo string) (store.MemoryDestination, error) {
	d, err := h.Store.GetMemoryDestination(c.Request().Context(), strings.TrimSpace(repo))
	if errors.Is(err, store.ErrMemoryDestinationNotFound) {
		return store.MemoryDestination{}, echo.NewHTTPError(http.StatusNotFound, "Memory destination not found")
	}
	if err != nil {
		return store.MemoryDestination{}, echo.NewHTTPError(http.StatusInternalServerError, "failed to load the Memory destination")
	}
	ok, err := h.callerCanAccessRepo(c, d.Repo)
	if err != nil {
		return store.MemoryDestination{}, h.repoAccessError(err)
	}
	if !ok {
		return store.MemoryDestination{}, echo.NewHTTPError(http.StatusNotFound, "Memory destination not found")
	}
	return d, nil
}

func memoryConnectError(err error) error {
	var apiErr *memory.APIError
	if errors.As(err, &apiErr) {
		switch apiErr.Status {
		case http.StatusUnauthorized:
			return echo.NewHTTPError(http.StatusBadRequest, "Memory rejected the token (401). Create a new project token and try again.")
		case http.StatusForbidden:
			return echo.NewHTTPError(http.StatusBadRequest, "Memory token is missing the projects:read scope.")
		}
	}
	return echo.NewHTTPError(http.StatusBadGateway, memoryErrorMessage(err))
}

func memoryErrorMessage(err error) string {
	var apiErr *memory.APIError
	if errors.As(err, &apiErr) {
		switch apiErr.Status {
		case http.StatusUnauthorized:
			return "Memory rejected the token (401). Reconnect with a valid token."
		case http.StatusForbidden:
			return "Memory token lacks the required scopes (graph:read, graph:write, projects:read)."
		case http.StatusNotFound:
			return "The connected project or object no longer exists in Memory."
		}
	}
	return err.Error()
}

// enqueueMemoryForFeedback applies the per-repo mode and, when allowed, adds an
// upsert to the outbox. It returns "queued", "skipped", or "off".
func (h *Handler) enqueueMemoryForFeedback(ctx context.Context, f store.Feedback, d store.MemoryDestination, requested bool) (string, error) {
	if d.Mode == memoryModeOff {
		return "off", nil
	}
	if d.Mode == memoryModeAsk && !requested {
		return "skipped", nil
	}
	key, props := h.buildMemoryIssue(f, d)
	payload, err := json.Marshal(memory.UpsertRequest{
		Type:       memoryIssueType,
		Key:        key,
		Status:     "new",
		Properties: props,
		Labels:     []string{"feedback"},
	})
	if err != nil {
		return "", err
	}
	if _, err := h.Store.EnqueueMemoryOutbox(ctx, store.MemoryOutboxItem{
		FeedbackID:    f.ID,
		DestinationID: d.ID,
		Op:            "upsert",
		Payload:       string(payload),
	}); err != nil {
		return "", err
	}
	h.kickMemory()
	return "queued", nil
}

func memoryIssueKey(f store.Feedback) string {
	raw := strings.ToLower(f.Repo + "-" + strconv.FormatInt(f.ID, 10))
	var b strings.Builder
	for _, r := range raw {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '/' || r == '_' || r == '.' || r == '-':
			b.WriteRune('-')
		default:
			b.WriteRune('-')
		}
	}
	key := "ef-" + strings.Trim(b.String(), "-")
	if len(key) > 120 {
		key = key[:120]
	}
	return key
}

func captureStatus(s store.FeedbackStatus) string {
	switch s {
	case store.StatusResolved:
		return "resolved"
	default:
		return "open"
	}
}

func truncateRunes(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max])
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	return strings.TrimSpace(s)
}

// buildMemoryIssue maps a feedback row + envelope onto the Memory Issue
// schema. Keep this deliberately small: no replay/screenshot blobs, no
// user-agent string, and no fields the triage agent owns.
func (h *Handler) buildMemoryIssue(f store.Feedback, d store.MemoryDestination) (string, map[string]any) {
	env := BuildEnvelope(f)
	title := asString(env["summary"])
	if title == "" {
		title = firstLine(f.Comment)
	}
	title = truncateRunes(title, 120)
	if title == "" {
		title = "Feedback on " + f.URL
	}

	props := map[string]any{
		"title":          title,
		"description":    redactSecrets(f.Comment),
		"page_url":       f.URL,
		"repo":           f.Repo,
		"source":         "emergent.feedback",
		"source_id":      strconv.FormatInt(f.ID, 10),
		"capture_status": captureStatus(f.Status),
		"severity":       "unknown",
		"category":       memoryCategory(asString(env["type"])),
		"created_at":     f.CreatedAt.UTC().Format(time.RFC3339),
	}
	if f.GitHubUser != "" {
		props["reporter"] = f.GitHubUser
	}
	base := strings.TrimRight(d.FeedbackBaseURL, "/")
	if base == "" {
		base = strings.TrimRight(h.PublicBaseURL, "/")
	}
	if base != "" {
		props["source_url"] = fmt.Sprintf("%s/panel/reports?report=%d", base, f.ID)
	}
	if e, ok := env["environment"].(map[string]any); ok {
		if v := asString(e["version"]); v != "" {
			props["app_version"] = v
		}
		if v := asString(e["name"]); v != "" {
			props["environment"] = v
		}
		if v := asString(e["branch"]); v != "" {
			props["branch"] = v
		}
		if v := viewportLabel(e["viewport"]); v != "" {
			props["viewport"] = v
		}
	}
	return memoryIssueKey(f), props
}

func memoryCategory(t string) string {
	switch t {
	case "bug":
		return "bug"
	case "enhancement":
		return "feature"
	default:
		return "other"
	}
}

func viewportLabel(v any) string {
	m, ok := v.(map[string]any)
	if !ok {
		return ""
	}
	w, _ := m["width"].(float64)
	h, _ := m["height"].(float64)
	if w <= 0 || h <= 0 {
		return ""
	}
	return fmt.Sprintf("%.0fx%.0f", w, h)
}

// memoryOutboxPatch enqueues a property patch (used for status writeback).
func (h *Handler) enqueueMemoryPatch(ctx context.Context, f store.Feedback, props map[string]any) {
	d, err := h.Store.GetMemoryDestination(ctx, f.Repo)
	if err != nil {
		return
	}
	link, err := h.Store.GetMemoryLink(ctx, f.ID, d.ID)
	if err != nil || link.CanonicalID == "" {
		return
	}
	payload, err := json.Marshal(props)
	if err != nil {
		return
	}
	if _, err := h.Store.EnqueueMemoryOutbox(ctx, store.MemoryOutboxItem{
		FeedbackID:    f.ID,
		DestinationID: d.ID,
		Op:            "patch",
		Payload:       string(payload),
	}); err == nil {
		h.kickMemory()
	}
}

// ProcessMemoryOutbox drains due outbox rows. It is safe to call concurrently;
// the store only returns rows that are due, and a duplicate send is idempotent
// for upserts.
func (h *Handler) ProcessMemoryOutbox(ctx context.Context) {
	items, err := h.Store.ListDueMemoryOutbox(ctx, 20)
	if err != nil {
		return
	}
	for _, it := range items {
		h.processMemoryOutboxItem(ctx, it)
	}
}

// memoryTriageOwnedFields are the Issue properties the triage agent owns. A
// retried create must never send these back to Memory.
var memoryTriageOwnedFields = map[string]bool{
	"severity":     true,
	"category":     true,
	"confidence":   true,
	"triage_notes": true,
	"group_key":    true,
}

func memoryCaptureProperties(props map[string]any) map[string]any {
	out := make(map[string]any, len(props))
	for k, v := range props {
		if !memoryTriageOwnedFields[k] {
			out[k] = v
		}
	}
	return out
}

func (h *Handler) processMemoryOutboxItem(ctx context.Context, it store.MemoryOutboxItem) {
	d, err := h.Store.GetMemoryDestinationByID(ctx, it.DestinationID)
	if err != nil {
		// Disconnect removes the destination's outbox rows transactionally; if
		// one is still in flight, drop it instead of retrying a target that no
		// longer exists for the next 24 hours.
		if errors.Is(err, store.ErrMemoryDestinationNotFound) {
			_ = h.Store.DeleteMemoryOutbox(ctx, it.ID)
			return
		}
		h.failMemoryOutbox(ctx, it, 0, err)
		return
	}
	client, err := h.memoryClient(d)
	if err != nil {
		h.failMemoryOutbox(ctx, it, d.ID, err)
		return
	}
	itemCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()

	switch it.Op {
	case "upsert":
		var req memory.UpsertRequest
		if err := json.Unmarshal([]byte(it.Payload), &req); err != nil {
			h.failMemoryOutbox(ctx, it, d.ID, fmt.Errorf("invalid outbox payload: %w", err))
			return
		}
		// A previous attempt may have already created the object. Upsert
		// replaces properties, so a retry must patch the capture-owned fields
		// instead of wiping the triage agent's classification. If the object
		// disappeared, fall back to the create payload.
		if link, linkErr := h.Store.GetMemoryLink(ctx, it.FeedbackID, d.ID); linkErr == nil && link.CanonicalID != "" {
			props := memoryCaptureProperties(req.Properties)
			_, perr := client.PatchObject(itemCtx, d.ProjectID, link.CanonicalID, props)
			if perr == nil {
				_ = h.Store.UpsertMemoryLink(ctx, store.MemoryLink{
					FeedbackID:    it.FeedbackID,
					DestinationID: d.ID,
					ObjectKey:     link.ObjectKey,
					CanonicalID:   link.CanonicalID,
				})
				break
			}
			var apiErr *memory.APIError
			if !errors.As(perr, &apiErr) || apiErr.Status != http.StatusNotFound {
				h.failMemoryOutbox(ctx, it, d.ID, perr)
				return
			}
		}
		obj, err := client.UpsertIssue(itemCtx, d.ProjectID, req)
		if err != nil {
			h.failMemoryOutbox(ctx, it, d.ID, err)
			return
		}
		canonical := obj.CanonicalID
		if canonical == "" {
			canonical = obj.ID
		}
		if err := h.Store.UpsertMemoryLink(ctx, store.MemoryLink{
			FeedbackID:    it.FeedbackID,
			DestinationID: d.ID,
			ObjectKey:     req.Key,
			CanonicalID:   canonical,
		}); err != nil {
			h.failMemoryOutbox(ctx, it, d.ID, err)
			return
		}
	case "patch":
		link, err := h.Store.GetMemoryLink(ctx, it.FeedbackID, d.ID)
		if err != nil || link.CanonicalID == "" {
			h.failMemoryOutbox(ctx, it, d.ID, fmt.Errorf("no Memory object linked to feedback %d", it.FeedbackID))
			return
		}
		var props map[string]any
		if err := json.Unmarshal([]byte(it.Payload), &props); err != nil {
			h.failMemoryOutbox(ctx, it, d.ID, fmt.Errorf("invalid outbox payload: %w", err))
			return
		}
		if _, err := client.PatchObject(itemCtx, d.ProjectID, link.CanonicalID, props); err != nil {
			h.failMemoryOutbox(ctx, it, d.ID, err)
			return
		}
		if err := h.Store.UpsertMemoryLink(ctx, store.MemoryLink{
			FeedbackID:    it.FeedbackID,
			DestinationID: d.ID,
			ObjectKey:     link.ObjectKey,
			CanonicalID:   link.CanonicalID,
		}); err != nil {
			h.failMemoryOutbox(ctx, it, d.ID, err)
			return
		}
	default:
		h.failMemoryOutbox(ctx, it, d.ID, fmt.Errorf("unknown outbox op %q", it.Op))
		return
	}

	_ = h.Store.DeleteMemoryOutbox(ctx, it.ID)
	_ = h.Store.MarkMemoryDestinationSynced(ctx, d.ID)
}

func (h *Handler) failMemoryOutbox(ctx context.Context, it store.MemoryOutboxItem, destinationID int64, err error) {
	attempts := it.Attempts + 1
	backoff := 30 * time.Second
	for i := 1; i < attempts && backoff < time.Hour; i++ {
		backoff *= 2
	}
	if backoff > time.Hour {
		backoff = time.Hour
	}
	if attempts >= 10 {
		backoff = 24 * time.Hour
	}
	msg := memoryErrorMessage(err)
	_ = h.Store.RescheduleMemoryOutbox(ctx, it.ID, attempts, time.Now().UTC().Add(backoff), msg)
	if destinationID != 0 {
		_ = h.Store.SetMemoryDestinationError(ctx, destinationID, msg)
	}
}

func (h *Handler) kickMemory() {
	if h.memoryWake == nil {
		return
	}
	select {
	case h.memoryWake <- struct{}{}:
	default:
	}
}

// StartMemoryWorker runs the outbox retry loop until ctx is cancelled.
func (h *Handler) StartMemoryWorker(ctx context.Context) {
	if h.memoryWake == nil {
		return
	}
	go func() {
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		h.ProcessMemoryOutbox(ctx)
		_ = h.Store.CleanupMemoryOAuthStates(ctx)
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				h.ProcessMemoryOutbox(ctx)
			case <-h.memoryWake:
				h.ProcessMemoryOutbox(ctx)
			}
		}
	}()
}
