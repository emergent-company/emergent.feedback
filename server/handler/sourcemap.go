package handler

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strings"

	sm "github.com/go-sourcemap/sourcemap"
	"github.com/labstack/echo/v4"
)

// maxSourcemapPayload bounds the total POST /sourcemaps body (~20MB).
const maxSourcemapPayload = 20 * 1024 * 1024

// HandleUploadSourcemaps handles POST /sourcemaps: upsert source maps keyed by
// (repo, version, path). Repo is validated against the caller's scope and the
// upload fails closed (403) when the scope cannot be determined.
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

	// Fail closed: probe the caller's token against req.Repo directly. A missing
	// or expired token is 401, an out-of-scope repo is 403, upstream failures 502.
	allowed, err := h.callerCanAccessRepo(c, req.Repo)
	if err != nil {
		return h.repoAccessError(err)
	}
	if !allowed {
		return echo.NewHTTPError(http.StatusForbidden, "repo not in scope")
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
// any lookup fails). Entries that cannot be mapped have absolute filesystem
// paths shortened to the last 3 segments so build paths never leak.
func (h *Handler) unmapContextConsole(ctx context.Context, repo, contextJSON string) string {
	if repo == "" || contextJSON == "" || contextJSON == "{}" {
		return contextJSON
	}
	m := parseContext(contextJSON)
	if m == nil {
		return contextJSON
	}
	// Client nests console under repro.console; read nested first and fall back
	// to the legacy top-level console key (same lookup as buildRepro).
	console, ok := reproValue(m, "console").([]any)
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

		// Array-of-frames shape: [{path,line,column}].
		if stack, ok := entry["stack"].([]any); ok && len(stack) > 0 {
			unmapped, mapped, shortened := h.unmapStack(ctx, repo, version, stack)
			if mapped {
				entry["unmapped_stack"] = unmapped
				console[i] = entry
				changed = true
			} else if shortened {
				entry["stack"] = unmapped
				console[i] = entry
				changed = true
			}
		}

		// Entries that only carry a raw stack_text string: shorten any absolute
		// filesystem paths so they don't leak into the rendered issue body.
		if st, ok := entry["stack_text"].(string); ok && st != "" {
			if scrubbed := shortenStackText(st); scrubbed != st {
				entry["stack_text"] = scrubbed
				console[i] = entry
				changed = true
			}
		}
	}
	if !changed {
		return contextJSON
	}
	// Write the updated console array back to whichever container held it:
	// nested repro.console first, then legacy top-level console.
	if r, ok := m["repro"].(map[string]any); ok {
		if _, has := r["console"]; has {
			r["console"] = console
		} else {
			m["console"] = console
		}
	} else {
		m["console"] = console
	}
	b, err := json.Marshal(m)
	if err != nil {
		return contextJSON
	}
	return string(b)
}

// unmapStack maps generated frames to original sources. It returns the mapped
// frames plus two flags: `mapped` (at least one frame mapped) and `shortened`
// (at least one unmapped frame had its absolute path shortened).
func (h *Handler) unmapStack(ctx context.Context, repo, version string, stack []any) ([]any, bool, bool) {
	var out []any
	mapped, shortened := false, false
	for _, raw := range stack {
		frame, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		path := framePath(frame)
		base := frameBase(path)
		if base == "" || base == "." {
			f, did := shortenFrame(frame)
			shortened = shortened || did
			out = append(out, f)
			continue
		}

		content, err := h.lookupSourcemap(ctx, repo, version, base)
		if err != nil {
			f, did := shortenFrame(frame)
			shortened = shortened || did
			out = append(out, f)
			continue
		}
		consumer, err := sm.Parse(base, content)
		if err != nil {
			f, did := shortenFrame(frame)
			shortened = shortened || did
			out = append(out, f)
			continue
		}

		genLine := frameInt(frame, "line", 1)
		genCol := frameInt(frame, "column", 0)
		// V8 stack columns are 1-based; go-sourcemap's Consumer.Source expects a
		// 0-based generated column (lines are 1-based on both sides).
		if genCol > 0 {
			genCol--
		}
		src, name, line, col, ok := consumer.Source(genLine, genCol)
		if !ok || src == "" {
			f, did := shortenFrame(frame)
			shortened = shortened || did
			out = append(out, f)
			continue
		}
		out = append(out, map[string]any{
			"file":     shortenPath(src),
			"line":     line,
			"column":   col,
			"function": name,
		})
		mapped = true
	}
	return out, mapped, shortened
}

// lookupSourcemap probes the frame basename and common .map suffixes. It
// delegates the path contract to Store.GetSourcemap, which first tries an exact
// (repo, version, path) row and then falls back to a suffix match so CI uploads
// keyed by full asset path (e.g. dist/assets/bundle.js.map) still resolve a
// basename probe (bundle.js.map).
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

// frameBase derives the source-map lookup basename from a frame path. It first
// strips URL query/hash fragments and normalizes Windows backslashes so probe
// names match the real asset file (bundle.js, not bundle.js?v=abc or the whole
// C:\build\bundle.js path).
func frameBase(path string) string {
	if i := strings.IndexAny(path, "?#"); i >= 0 {
		path = path[:i]
	}
	path = strings.ReplaceAll(path, "\\", "/")
	if i := strings.LastIndexByte(path, '/'); i >= 0 {
		return path[i+1:]
	}
	return path
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

// shortenFrame returns a copy of frame with its absolute path shortened to the
// last 3 segments, plus whether any change was made.
func shortenFrame(frame map[string]any) (map[string]any, bool) {
	for _, k := range []string{"path", "file", "url", "fileName"} {
		v := asString(frame[k])
		if v == "" {
			continue
		}
		s := shortenPath(v)
		if s == v {
			return frame, false
		}
		cp := make(map[string]any, len(frame))
		for kk, vv := range frame {
			cp[kk] = vv
		}
		cp[k] = s
		return cp, true
	}
	return frame, false
}

// shortenPath shortens an absolute filesystem path to its last 3 segments.
// Relative paths, URLs, and virtual (webpack://) paths are returned unchanged.
func shortenPath(p string) string {
	s := strings.TrimPrefix(p, "file://")
	isAbs := strings.HasPrefix(s, "/") ||
		(len(s) >= 3 && s[1] == ':' && (s[2] == '/' || s[2] == '\\'))
	if !isAbs {
		return p
	}
	parts := strings.FieldsFunc(s, func(r rune) bool { return r == '/' || r == '\\' })
	if len(parts) <= 3 {
		return p
	}
	return strings.Join(parts[len(parts)-3:], "/")
}

// absPathTokenRe matches an absolute filesystem path token in free text
// (POSIX `/…` or Windows `C:\…`), so build paths never leak. The leading
// boundary (start, whitespace, or a stack-trace delimiter) prevents matching
// the path component of a URL, which follows a scheme/host instead.
var absPathTokenRe = regexp.MustCompile(`(^|[\s(\"'=,@:>])((?:file://)?(?:/[^\s"'()<>]+|[A-Za-z]:[\\/][^\s"'()<>]+))`)

// shortenStackText shortens absolute filesystem paths embedded in a raw stack
// trace string to their last 3 segments, leaving the rest of the text intact.
func shortenStackText(s string) string {
	matches := absPathTokenRe.FindAllStringSubmatchIndex(s, -1)
	if len(matches) == 0 {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	last := 0
	for _, m := range matches {
		fullStart, fullEnd := m[0], m[1]
		pathStart, pathEnd := m[4], m[5]
		b.WriteString(s[last:fullStart])
		b.WriteString(s[fullStart:pathStart])
		b.WriteString(shortenPath(s[pathStart:pathEnd]))
		last = fullEnd
	}
	b.WriteString(s[last:])
	return b.String()
}
