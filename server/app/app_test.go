package app

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"testing/fstest"

	"github.com/emergent-company/emergent.feedback/server/github"
	"github.com/emergent-company/emergent.feedback/server/store"
	"github.com/labstack/echo/v4"
)

func TestOriginAllowed(t *testing.T) {
	cases := []struct {
		name      string
		origin    string
		allowlist string
		want      bool
	}{
		{"wildcard allows any", "https://a.example.com", "*", true},
		{"empty allowlist denies", "https://a.example.com", "", false},
		{"exact match", "https://a.example.com", "https://a.example.com,https://b.example.com", true},
		{"later entry matches", "https://b.example.com", "https://a.example.com,https://b.example.com", true},
		{"not in list", "https://evil.example.com", "https://a.example.com,https://b.example.com", false},
		{"whitespace trimmed", "https://b.example.com", "  https://a.example.com , https://b.example.com  ", true},
		{"substring is not match", "https://a.example.com.evil.com", "https://a.example.com", false},
		{"trailing slash matters", "https://a.example.com/", "https://a.example.com", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := originAllowed(c.origin, c.allowlist); got != c.want {
				t.Fatalf("originAllowed(%q, %q) = %v, want %v", c.origin, c.allowlist, got, c.want)
			}
		})
	}
}

func TestEnvFloatOr(t *testing.T) {
	t.Run("default when unset", func(t *testing.T) {
		t.Setenv("TEST_ENV_FLOAT", "")
		if got := envFloatOr("TEST_ENV_FLOAT", 10); got != 10 {
			t.Fatalf("got %v, want 10", got)
		}
	})
	t.Run("parses valid", func(t *testing.T) {
		t.Setenv("TEST_ENV_FLOAT", "2.5")
		if got := envFloatOr("TEST_ENV_FLOAT", 10); got != 2.5 {
			t.Fatalf("got %v, want 2.5", got)
		}
	})
	t.Run("falls back on invalid", func(t *testing.T) {
		t.Setenv("TEST_ENV_FLOAT", "abc")
		if got := envFloatOr("TEST_ENV_FLOAT", 10); got != 10 {
			t.Fatalf("got %v, want 10", got)
		}
	})
}

func TestBuildRouterDefaultsStaticFS(t *testing.T) {
	s, err := store.OpenSQLite(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatalf("store.OpenSQLite: %v", err)
	}
	defer func() { _ = s.Close() }()

	// StaticFS and EnvelopeSchema are intentionally left nil to exercise the defaults.
	e, err := BuildRouter(Options{
		Store:          s,
		GitHub:         &github.AppConfig{},
		JWTSecret:      "test-secret",
		AllowedOrigins: "*",
		MCPAPIKey:      "",
	})
	if err != nil {
		t.Fatalf("BuildRouter: %v", err)
	}

	for _, path := range []string{"/emergent-feedback.js", "/schema/envelope.v1.json"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Errorf("GET %s status = %d, want 200", path, rec.Code)
		}
	}
}

func setRequiredEnv(t *testing.T, dbPath string) {
	t.Helper()
	t.Setenv("JWT_SECRET", "test-secret")
	t.Setenv("GH_APP_CLIENT_ID", "client-id")
	t.Setenv("GH_APP_CLIENT_SECRET", "client-secret")
	t.Setenv("GH_REDIRECT_URI", "https://example.test/callback")
	t.Setenv("GH_APP_ID", "")
	t.Setenv("GH_INSTALLATION_ID", "")
	t.Setenv("GH_APP_PRIVATE_KEY", "")
	t.Setenv("GH_APP_PRIVATE_KEY_PATH", "")
	t.Setenv("DB_PATH", dbPath)
	t.Setenv("DATABASE_URL", "")
}

func TestOptionsFromEnv(t *testing.T) {
	t.Run("missing required var", func(t *testing.T) {
		t.Setenv("JWT_SECRET", "test-secret")
		t.Setenv("GH_APP_CLIENT_ID", "") // missing
		t.Setenv("GH_APP_CLIENT_SECRET", "s")
		t.Setenv("GH_REDIRECT_URI", "https://example.test/cb")
		t.Setenv("DATABASE_URL", "")
		_, cleanup, err := OptionsFromEnv()
		if err == nil {
			t.Fatal("expected error for missing GH_APP_CLIENT_ID, got nil")
		}
		if cleanup == nil {
			t.Fatal("cleanup is nil on error path")
		}
	})

	t.Run("defaults", func(t *testing.T) {
		dbPath := filepath.Join(t.TempDir(), "fb.db")
		setRequiredEnv(t, dbPath)
		opts, cleanup, err := OptionsFromEnv()
		if err != nil {
			t.Fatalf("OptionsFromEnv: %v", err)
		}
		if opts.Port != "8080" {
			t.Fatalf("Port = %q, want 8080", opts.Port)
		}
		if opts.AllowedOrigins != "*" {
			t.Fatalf("AllowedOrigins = %q, want *", opts.AllowedOrigins)
		}
		if opts.Store == nil {
			t.Fatal("Store is nil")
		}
		cleanup() // must not panic
	})

	t.Run("overrides", func(t *testing.T) {
		dbPath := filepath.Join(t.TempDir(), "fb.db")
		setRequiredEnv(t, dbPath)
		t.Setenv("PORT", "9090")
		t.Setenv("ALLOWED_ORIGINS", "https://a.example.com")
		opts, cleanup, err := OptionsFromEnv()
		if err != nil {
			t.Fatalf("OptionsFromEnv: %v", err)
		}
		if opts.Port != "9090" {
			t.Fatalf("Port = %q, want 9090", opts.Port)
		}
		if opts.AllowedOrigins != "https://a.example.com" {
			t.Fatalf("AllowedOrigins = %q, want https://a.example.com", opts.AllowedOrigins)
		}
		cleanup()
	})
}

func TestBuildRouterExtendHook(t *testing.T) {
	s, err := store.OpenSQLite(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	defer func() { _ = s.Close() }()

	const sentinel = "ext-ok"
	e, err := BuildRouter(Options{
		Store:          s,
		GitHub:         &github.AppConfig{},
		JWTSecret:      "test-secret",
		AllowedOrigins: "*",
		MCPAPIKey:      "",
		StaticFS:       fstest.MapFS{},
		EnvelopeSchema: []byte(`{"$id":"https://example.test/schema"}`),
		Extend: func(e2 *echo.Echo, s2 *store.Store) error {
			e2.GET("/__ext", func(c echo.Context) error {
				return c.String(http.StatusOK, sentinel)
			})
			return nil
		},
	})
	if err != nil {
		t.Fatalf("BuildRouter: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/__ext", nil)
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /__ext status = %d, want 200", rec.Code)
	}
	if rec.Body.String() != sentinel {
		t.Fatalf("GET /__ext body = %q, want %q", rec.Body.String(), sentinel)
	}
}

func TestBuildRouterRegistersAllRoutes(t *testing.T) {
	s, err := store.OpenSQLite(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	defer func() { _ = s.Close() }()

	e, err := BuildRouter(Options{
		Store:          s,
		GitHub:         &github.AppConfig{},
		JWTSecret:      "test-secret",
		AllowedOrigins: "*",
		MCPAPIKey:      "",
		StaticFS:       fstest.MapFS{},
		EnvelopeSchema: []byte("{}"),
	})
	if err != nil {
		t.Fatalf("BuildRouter: %v", err)
	}

	registered := map[string]bool{}
	pathAny := map[string]bool{}
	for _, r := range e.Routes() {
		registered[r.Method+" "+r.Path] = true
		pathAny[r.Path] = true
	}

	expected := []string{
		// Public
		"GET /panel",
		"GET /panel/keys",
		"GET /panel/reports",
		"GET /",
		"GET /emergent-feedback.js",
		"GET /emergent-feedback-replay.js",
		"GET /static/*",
		"GET /auth/github",
		"GET /auth/callback",
		"GET /health",
		"GET /schema/envelope.v1.json",
		"GET /feedback",
		"GET /issues",
		// Authenticated
		"GET /me",
		"GET /feedback/list",
		"GET /feedback/verify-pending",
		"GET /feedback/status",
		"GET /feedback/:id",
		"GET /feedback/:id/verify",
		"GET /feedback/:id/replay",
		"DELETE /feedback/:id",
		"POST /feedback/:id/applied",
		"POST /feedback/:id/resolve",
		"POST /feedback/:id/verify-result",
		"GET /api/keys",
		"POST /api/keys",
		"DELETE /api/keys/:id",
		"GET /api/repos",
		"GET /api/reports",
		"GET /api/reports/:id",
		// Rate-limited writes
		"POST /feedback",
		"POST /issue/export",
		"POST /sourcemaps",
	}

	for _, want := range expected {
		if !registered[want] {
			t.Errorf("missing route %q", want)
		}
	}

	// MCP is registered via e.Any — any method is acceptable.
	if !pathAny["/mcp"] {
		t.Errorf("missing MCP route /mcp")
	}
}
