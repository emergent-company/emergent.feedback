package main

import (
	"context"
	"crypto/subtle"
	"io/fs"
	"net/http"
	"time"

	"github.com/emergent-company/emergent.feedback/server/github"
	"github.com/emergent-company/emergent.feedback/server/handler"
	"github.com/emergent-company/emergent.feedback/server/landing"
	authmw "github.com/emergent-company/emergent.feedback/server/middleware"
	"github.com/emergent-company/emergent.feedback/server/panel"
	"github.com/emergent-company/emergent.feedback/server/store"
	"github.com/emergent-company/go-daisy/render"
	"github.com/emergent-company/go-daisy/staticfs"
	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	mcpauth "github.com/modelcontextprotocol/go-sdk/auth"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"golang.org/x/time/rate"
)

// buildRouter assembles the Echo router with all middleware and routes.
func buildRouter(s *store.Store, ghCfg *github.AppConfig, jwtSecret, allowedOrigins, mcpAPIKey string) *echo.Echo {
	e := echo.New()
	e.HideBanner = true
	e.Use(middleware.RequestLoggerWithConfig(middleware.RequestLoggerConfig{
		LogMethod:  true,
		LogURI:     true,
		LogStatus:  true,
		LogLatency: true,
		LogError:   true,
		LogValuesFunc: func(c echo.Context, v middleware.RequestLoggerValues) error {
			c.Logger().Infof("method=%s uri=%s status=%d latency=%s error=%v",
				v.Method, v.URI, v.Status, v.Latency, v.Error)
			return nil
		},
	}))
	e.Use(middleware.Recover())
	e.Use(middleware.BodyLimit(envOr("MAX_BODY_BYTES", "10MB")))

	e.Use(func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			origin := c.Request().Header.Get("Origin")
			if origin == "" {
				return next(c)
			}
			if !originAllowed(origin, allowedOrigins) {
				return next(c)
			}
			h := c.Response().Header()
			h.Set("Access-Control-Allow-Origin", origin)
			h.Set("Access-Control-Allow-Credentials", "true")
			h.Set("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS")
			h.Set("Access-Control-Allow-Headers", "Content-Type,Authorization")
			h.Set("Vary", "Origin")
			if c.Request().Method == http.MethodOptions {
				return c.NoContent(http.StatusNoContent)
			}
			return next(c)
		}
	})

	// ── Static: serve embedded emergent-feedback.js ────────────────────────────
	staticFS, _ := fs.Sub(staticFiles, "static")
	e.GET("/emergent-feedback.js", echo.WrapHandler(http.FileServer(http.FS(staticFS))))

	// ── go-daisy static assets (CSS/JS) ───────────────────────────────────────
	e.GET("/static/*", echo.WrapHandler(staticfs.Handler("/static/")))

	// ── Routes ────────────────────────────────────────────────────────────────
	h := handler.New(s, ghCfg, jwtSecret)

	// Panel (public; go-daisy Templ page)
	e.GET("/panel", func(c echo.Context) error {
		render.RenderPage(c.Response().Writer, c.Request(), panel.PanelPage())
		return nil
	})

	// Landing page (public; commercial one-pager)
	e.GET("/", func(c echo.Context) error {
		render.RenderPage(c.Response().Writer, c.Request(), landing.LandingPage())
		return nil
	})

	// Auth (public)
	e.GET("/auth/github", h.HandleGitHubLogin)
	e.GET("/auth/callback", h.HandleGitHubCallback)

	// Health (public)
	e.GET("/health", func(c echo.Context) error {
		return c.JSON(http.StatusOK, map[string]any{
			"ok":      true,
			"version": Version,
			"commit":  Commit,
		})
	})

	// Feedback envelope JSON Schema (public).
	e.GET("/schema/envelope.v1.json", func(c echo.Context) error {
		return c.Blob(http.StatusOK, "application/json", envelopeSchemaJSON)
	})

	// Feedback — public read endpoints (counts + public issue refs only, no PII)
	e.GET("/feedback", h.HandleListFeedback)
	e.GET("/issues", h.HandleListIssues)

	// Authenticated routes
	auth := e.Group("", authmw.RequireAuth(jwtSecret))
	auth.GET("/me", h.HandleMe)
	auth.GET("/feedback/list", h.HandleListFeedbackByURL)
	auth.GET("/feedback/verify-pending", h.HandleVerifyPending)
	auth.GET("/feedback/:id", h.HandleGetFeedback)
	auth.GET("/feedback/:id/verify", h.HandleGetVerify)
	auth.GET("/feedback/:id/replay", h.HandleGetReplay)
	auth.DELETE("/feedback/:id", h.HandleDeleteFeedback)
	auth.POST("/feedback/:id/applied", h.HandleMarkApplied)
	auth.POST("/feedback/:id/resolve", h.HandleResolve)
	auth.POST("/feedback/:id/verify-result", h.HandleVerifyResult)
	auth.GET("/api/keys", h.HandleListAPIKeys)
	auth.POST("/api/keys", h.HandleCreateAPIKey)
	auth.DELETE("/api/keys/:id", h.HandleRevokeAPIKey)
	auth.GET("/api/repos", h.HandleListRepos)
	auth.GET("/api/reports", h.HandleListReports)
	auth.GET("/api/reports/:id", h.HandleGetReport)

	// Write endpoints are rate-limited per client IP to protect the SQLite DB and
	// the upstream GitHub API from abuse. Export is stricter since it calls GitHub.
	feedbackLimiter := middleware.RateLimiter(middleware.NewRateLimiterMemoryStore(
		rate.Limit(envFloatOr("RATE_LIMIT_RPS", 10))))
	exportLimiter := middleware.RateLimiter(middleware.NewRateLimiterMemoryStore(
		rate.Limit(envFloatOr("EXPORT_RATE_LIMIT_RPS", 1))))

	auth.POST("/feedback", h.HandleCreateFeedback, feedbackLimiter)
	auth.POST("/issue/export", h.HandleExportIssue, exportLimiter)

	// ── MCP server (API-key auth: DB keys scoped to repos, plus MCP_API_KEY bootstrap) ──
	mcpSrv := h.MCPServer()
	streamable := mcp.NewStreamableHTTPHandler(
		func(_ *http.Request) *mcp.Server { return mcpSrv },
		&mcp.StreamableHTTPOptions{
			Stateless:                  true,
			JSONResponse:               true,
			DisableLocalhostProtection: true,
		},
	)
	verify := func(ctx context.Context, token string, _ *http.Request) (*mcpauth.TokenInfo, error) {
		if mcpAPIKey != "" && subtle.ConstantTimeCompare([]byte(token), []byte(mcpAPIKey)) == 1 {
			return &mcpauth.TokenInfo{Scopes: []string{"*"}, Expiration: time.Now().Add(time.Hour)}, nil
		}
		repos, err := h.VerifyAPIKey(ctx, token)
		if err != nil || len(repos) == 0 {
			return nil, mcpauth.ErrInvalidToken
		}
		return &mcpauth.TokenInfo{Scopes: repos, Expiration: time.Now().Add(time.Hour)}, nil
	}
	authed := mcpauth.RequireBearerToken(verify, nil)(streamable)
	e.Any("/mcp", echo.WrapHandler(authed))

	return e
}
