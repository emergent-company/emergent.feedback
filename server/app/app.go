package app

import (
	"context"
	"crypto/subtle"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"strconv"
	"strings"
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

// Version and Commit are injected at build time via -ldflags.
var (
	Version = "dev"
	Commit  = "unknown"
)

// Options configures BuildRouter.
type Options struct {
	Store          *store.Store
	GitHub         *github.AppConfig
	JWTSecret      string
	AllowedOrigins string
	MCPAPIKey      string
	// StaticFS serves the embedded client bundles. Required.
	StaticFS fs.FS
	// EnvelopeSchema is the feedback envelope JSON Schema served at /schema/envelope.v1.json. Required.
	EnvelopeSchema []byte
	// Extend mounts extra routes after the core routes are registered. Middleware
	// added inside Extend applies only to routes registered after it.
	Extend func(e *echo.Echo, s *store.Store) error
}

// BuildRouter assembles the Echo router with all middleware and routes.
func BuildRouter(opts Options) (*echo.Echo, error) {
	if opts.StaticFS == nil {
		return nil, errors.New("app: StaticFS is required")
	}
	if opts.EnvelopeSchema == nil {
		return nil, errors.New("app: EnvelopeSchema is required")
	}
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
			if !originAllowed(origin, opts.AllowedOrigins) {
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
	staticFS := opts.StaticFS
	e.GET("/emergent-feedback.js", echo.WrapHandler(http.FileServer(http.FS(staticFS))))
	e.GET("/emergent-feedback-replay.js", echo.WrapHandler(http.FileServer(http.FS(staticFS))))

	// ── go-daisy static assets (CSS/JS) ───────────────────────────────────────
	e.GET("/static/*", echo.WrapHandler(staticfs.Handler("/static/")))

	// ── Routes ────────────────────────────────────────────────────────────────
	h := handler.New(opts.Store, opts.GitHub, opts.JWTSecret)

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
		return c.Blob(http.StatusOK, "application/json", opts.EnvelopeSchema)
	})

	// Feedback — public read endpoints (counts + public issue refs only, no PII)
	e.GET("/feedback", h.HandleListFeedback)
	e.GET("/issues", h.HandleListIssues)

	// Authenticated routes
	auth := e.Group("", authmw.RequireAuth(opts.JWTSecret))
	auth.GET("/me", h.HandleMe)
	auth.GET("/feedback/list", h.HandleListFeedbackByURL)
	auth.GET("/feedback/verify-pending", h.HandleVerifyPending)
	auth.GET("/feedback/status", h.HandleFeedbackStatus)
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
	auth.POST("/sourcemaps", h.HandleUploadSourcemaps, feedbackLimiter)

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
		if opts.MCPAPIKey != "" && subtle.ConstantTimeCompare([]byte(token), []byte(opts.MCPAPIKey)) == 1 {
			return &mcpauth.TokenInfo{Scopes: []string{"*"}, Expiration: time.Now().Add(time.Hour), UserID: "mcp-bootstrap"}, nil
		}
		repos, err := h.VerifyAPIKey(ctx, token)
		if err != nil || len(repos) == 0 {
			return nil, mcpauth.ErrInvalidToken
		}
		return &mcpauth.TokenInfo{
			Scopes:     repos,
			Expiration: time.Now().Add(time.Hour),
			UserID:     "api-key:" + handler.HashAPIKey(token)[:8],
		}, nil
	}
	authed := mcpauth.RequireBearerToken(verify, nil)(streamable)
	e.Any("/mcp", echo.WrapHandler(authed))

	if opts.Extend != nil {
		if err := opts.Extend(e, opts.Store); err != nil {
			return nil, err
		}
	}
	return e, nil
}

// originAllowed reports whether the request Origin matches the ALLOWED_ORIGINS
// allowlist. "*" allows any origin; an empty list allows none.
func originAllowed(origin, allowlist string) bool {
	for _, allowed := range strings.Split(allowlist, ",") {
		allowed = strings.TrimSpace(allowed)
		if allowed == "*" {
			return true
		}
		if allowed == origin {
			return true
		}
	}
	return false
}

// envFloatOr reads a float environment variable, falling back to def when the
// variable is empty or not parseable as a float.
func envFloatOr(key string, def float64) float64 {
	if v := os.Getenv(key); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return f
		}
	}
	return def
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
