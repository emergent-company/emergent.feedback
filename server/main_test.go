package main

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/emergent-company/emergent.feedback/server/app"
	"github.com/emergent-company/emergent.feedback/server/github"
	authmw "github.com/emergent-company/emergent.feedback/server/middleware"
	"github.com/emergent-company/emergent.feedback/server/store"
	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	"golang.org/x/time/rate"
)

func TestRateLimitBlocksExcess(t *testing.T) {
	e := echo.New()
	e.GET("/limited", func(c echo.Context) error {
		return c.NoContent(http.StatusOK)
	}, middleware.RateLimiter(middleware.NewRateLimiterMemoryStore(rate.Limit(1))))

	var allowed, limited int
	for i := 0; i < 5; i++ {
		req := httptest.NewRequest(http.MethodGet, "/limited", nil)
		req.RemoteAddr = "203.0.113.7:1234"
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)
		switch rec.Code {
		case http.StatusOK:
			allowed++
		case http.StatusTooManyRequests:
			limited++
		}
	}
	if allowed < 1 {
		t.Fatalf("expected at least one allowed request, got %d", allowed)
	}
	if limited < 1 {
		t.Fatalf("expected at least one 429 response, got %d", limited)
	}
}

func TestSourcemapsRouteRateLimited(t *testing.T) {
	s, err := store.OpenSQLite(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	defer func() { _ = s.Close() }()

	t.Setenv("RATE_LIMIT_RPS", "1")
	e, err := app.BuildRouter(app.Options{
		Store:          s,
		GitHub:         &github.AppConfig{},
		JWTSecret:      "test-secret",
		AllowedOrigins: "*",
		MCPAPIKey:      "",
	})
	if err != nil {
		t.Fatalf("BuildRouter: %v", err)
	}

	jwt, err := authmw.IssueToken("test-secret", "alice", "")
	if err != nil {
		t.Fatalf("IssueToken: %v", err)
	}

	var allowed, limited int
	for i := 0; i < 5; i++ {
		req := httptest.NewRequest(http.MethodPost, "/sourcemaps", strings.NewReader(`{"repo":"owner/repo","version":"1","maps":{"a.js.map":"{}"}}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+jwt)
		req.RemoteAddr = "203.0.113.7:1234"
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)
		if rec.Code == http.StatusTooManyRequests {
			limited++
		} else {
			allowed++
		}
	}
	if limited < 1 {
		t.Fatalf("expected at least one 429 on /sourcemaps, got allowed=%d limited=%d", allowed, limited)
	}
}
