package handler

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"regexp"
	"strconv"

	"github.com/emergent-company/emergent.feedback/server/middleware"
	"github.com/emergent-company/emergent.feedback/server/store"
	"github.com/labstack/echo/v4"
)

var repoNameRe = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)

// HashAPIKey returns the sha256 hex digest of a plaintext API key.
func HashAPIKey(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// GenerateAPIKey returns a new random plaintext API key.
func GenerateAPIKey() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return "fo_" + hex.EncodeToString(b), nil
}

// VerifyAPIKey hashes the token and returns its repo scope (empty on failure).
func (h *Handler) VerifyAPIKey(ctx context.Context, token string) ([]string, error) {
	return h.Store.LookupAPIKeyScopes(ctx, HashAPIKey(token))
}

type createAPIKeyRequest struct {
	Repos []string `json:"repos"`
}

// HandleCreateAPIKey handles POST /api/keys.
func (h *Handler) HandleCreateAPIKey(c echo.Context) error {
	var req createAPIKeyRequest
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request body")
	}
	if len(req.Repos) == 0 {
		return echo.NewHTTPError(http.StatusBadRequest, "repos is required")
	}
	for _, r := range req.Repos {
		if !repoNameRe.MatchString(r) {
			return echo.NewHTTPError(http.StatusBadRequest, "invalid repo: "+r)
		}
	}
	plain, err := GenerateAPIKey()
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to generate key")
	}
	id, err := h.Store.CreateAPIKey(c.Request().Context(), middleware.GetLogin(c), HashAPIKey(plain), req.Repos)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to create key")
	}
	return c.JSON(http.StatusCreated, map[string]any{
		"id":    id,
		"key":   plain,
		"repos": req.Repos,
	})
}

// HandleListAPIKeys handles GET /api/keys.
func (h *Handler) HandleListAPIKeys(c echo.Context) error {
	keys, err := h.Store.ListAPIKeys(c.Request().Context(), middleware.GetLogin(c))
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to list keys")
	}
	type item struct {
		ID        int64    `json:"id"`
		Repos     []string `json:"repos"`
		CreatedAt string   `json:"created_at"`
		Revoked   bool     `json:"revoked"`
	}
	out := make([]item, 0, len(keys))
	for _, k := range keys {
		out = append(out, item{
			ID:        k.ID,
			Repos:     k.Repos,
			CreatedAt: k.CreatedAt.Format("2006-01-02T15:04:05Z"),
			Revoked:   k.RevokedAt != nil,
		})
	}
	return c.JSON(http.StatusOK, out)
}

// HandleRevokeAPIKey handles DELETE /api/keys/:id.
func (h *Handler) HandleRevokeAPIKey(c echo.Context) error {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid key id")
	}
	if err := h.Store.RevokeAPIKey(c.Request().Context(), id, middleware.GetLogin(c)); err != nil {
		if errors.Is(err, store.ErrKeyNotFound) {
			return echo.NewHTTPError(http.StatusNotFound, "key not found")
		}
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to revoke key")
	}
	return c.NoContent(http.StatusNoContent)
}
