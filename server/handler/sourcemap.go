package handler

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"path/filepath"
	"strings"

	sm "github.com/go-sourcemap/sourcemap"
	"github.com/labstack/echo/v4"
)

// maxSourcemapPayload bounds the total POST /sourcemaps body (~20MB).
const maxSourcemapPayload = 20 * 1024 * 1024

// HandleUploadSourcemaps handles POST /sourcemaps: upsert source maps keyed by
// (repo, version, path). Repo is validated against the caller's scope on a
// best-effort basis (never blocks the request on GitHub).
func (h *Handler) HandleUploadSourcemaps(c echo.Context) error {
	body, err := io.ReadAll(c.Request().Body)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request body")
	}
	if len(body) > maxSourcemapPayload {
		return echo.NewHTTPError(http.StatusRequestEntityTooLarge, "sourcemap payload too large")
	}

	var req struct {
		Repo    string            `json:"repo"`
		Version string            `json:"version"`
		Maps    map[string]string `json:"maps"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request body")
	}
	if req.Repo == "" || !repoNameRe.MatchString(req.Repo) {
		return echo.NewHTTPError(http.StatusBadRequest, "repo is required (owner/name)")
	}
	if len(req.Maps) == 0 {
		return echo.NewHTTPError(http.StatusBadRequest, "maps is required")
	}

	// Best-effort scope validation against the user's repos.
	if names, err := h.userRepos(c); err == nil {
		if !repoInScope(req.Repo, names) {
			return echo.NewHTTPError(http.StatusForbidden, "repo not in scope")
		}
	}

	ctx := c.Request().Context()
	stored := 0
	for path, content := range req.Maps {
		if err := h.Store.UpsertSourcemap(ctx, req.Repo, req.Version, path, []byte(content)); err != nil {
			return echo.NewHTTPError(http.StatusInternalServerError, "failed to store sourcemap")
		}
		stored++
	}
	return c.JSON(http.StatusOK, map[string]any{"stored": stored})
}

// unmapContextConsole unmaps console stack frames using stored source maps,
// returning an updated context JSON string (unchanged when nothing matches or
// any lookup fails).
func (h *Handler) unmapContextConsole(ctx context.Context, repo, contextJSON string) string {
	if repo == "" || contextJSON == "" || contextJSON == "{}" {
		return contextJSON
	}
	m := parseContext(contextJSON)
	if m == nil {
		return contextJSON
	}
	console, ok := m["console"].([]any)
	if !ok || len(console) == 0 {
		return contextJSON
	}

	version := asString(m["appVersion"])
	changed := false
	for i, raw := range console {
		entry, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		stack, ok := entry["stack"].([]any)
		if !ok || len(stack) == 0 {
			continue
		}
		unmapped, did := h.unmapStack(ctx, repo, version, stack)
		if did {
			entry["unmapped_stack"] = unmapped
			console[i] = entry
			changed = true
		}
	}
	if !changed {
		return contextJSON
	}
	m["console"] = console
	b, err := json.Marshal(m)
	if err != nil {
		return contextJSON
	}
	return string(b)
}

// unmapStack maps generated frames to original sources. Returns the mapped
// frames and true if at least one frame was mapped.
func (h *Handler) unmapStack(ctx context.Context, repo, version string, stack []any) ([]any, bool) {
	var out []any
	anyMapped := false
	for _, raw := range stack {
		frame, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		path := framePath(frame)
		base := filepath.Base(path)
		if base == "" || base == "." {
			out = append(out, frame)
			continue
		}

		content, err := h.lookupSourcemap(ctx, repo, version, base)
		if err != nil {
			out = append(out, frame)
			continue
		}
		consumer, err := sm.Parse(base, content)
		if err != nil {
			out = append(out, frame)
			continue
		}

		genLine := frameInt(frame, "line", 1)
		genCol := frameInt(frame, "column", 0)
		src, name, line, col, ok := consumer.Source(genLine, genCol)
		if !ok || src == "" {
			out = append(out, frame)
			continue
		}
		out = append(out, map[string]any{
			"file":     src,
			"line":     line,
			"column":   col,
			"function": name,
		})
		anyMapped = true
	}
	return out, anyMapped
}

// lookupSourcemap tries the frame basename and common .map suffixes.
func (h *Handler) lookupSourcemap(ctx context.Context, repo, version, base string) ([]byte, error) {
	candidates := []string{base}
	if !strings.HasSuffix(base, ".map") {
		candidates = append(candidates, base+".map")
	}
	var lastErr error
	for _, c := range candidates {
		content, err := h.Store.GetSourcemap(ctx, repo, version, c)
		if err == nil {
			return content, nil
		}
		lastErr = err
	}
	return nil, lastErr
}

func framePath(frame map[string]any) string {
	for _, k := range []string{"path", "file", "url", "fileName"} {
		if v := asString(frame[k]); v != "" {
			return v
		}
	}
	return ""
}

func frameInt(frame map[string]any, key string, def int) int {
	switch v := frame[key].(type) {
	case float64:
		return int(v)
	case int:
		return v
	case int64:
		return int(v)
	}
	return def
}
