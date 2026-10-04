package main

import (
	"embed"
	"fmt"
	"io/fs"
	"net/http"
	"os"

	"github.com/emergent-company/emergent.feedback/server/app"
	"github.com/emergent-company/emergent.feedback/server/github"
	"github.com/emergent-company/emergent.feedback/server/store"
)

//go:embed static/emergent-feedback.js static/emergent-feedback-replay.js
var staticFiles embed.FS

//go:embed schema/envelope.v1.json
var envelopeSchemaJSON []byte

func main() {
	// ── Configuration from environment variables ──────────────────────────────
	port := envOr("PORT", "8080")
	dbPath := envOr("DB_PATH", "/data/feedback-overlay.db")
	jwtSecret := mustEnv("JWT_SECRET")
	ghAppID := envOr("GH_APP_ID", "")
	ghClientID := mustEnv("GH_APP_CLIENT_ID")
	ghClientSecret := mustEnv("GH_APP_CLIENT_SECRET")
	ghRedirectURI := mustEnv("GH_REDIRECT_URI")
	ghInstallID := envOr("GH_INSTALLATION_ID", "")
	ghBotToken := envOr("GH_BOT_TOKEN", "")
	issueAuthorMode := envOr("ISSUE_AUTHOR_MODE", "bot")

	// Private key: prefer file path, fall back to inline PEM env var. Optional —
	// issue filing can fall back to a bot token or each reporter's own token.
	var ghPrivateKey string
	if keyPath := os.Getenv("GH_APP_PRIVATE_KEY_PATH"); keyPath != "" {
		data, err := os.ReadFile(keyPath)
		if err != nil {
			fmt.Fprintf(os.Stderr, "fatal: read GH_APP_PRIVATE_KEY_PATH: %v\n", err)
			os.Exit(1)
		}
		ghPrivateKey = string(data)
	} else {
		ghPrivateKey = os.Getenv("GH_APP_PRIVATE_KEY")
	}

	// Validate ISSUE_AUTHOR_MODE. Empty means "bot".
	switch issueAuthorMode {
	case "", "bot":
		issueAuthorMode = "bot"
	case "user":
		// ok
	default:
		fmt.Fprintf(os.Stderr, "fatal: ISSUE_AUTHOR_MODE must be one of \"bot\" or \"user\" (got %q)\n", issueAuthorMode)
		os.Exit(1)
	}

	// Warn when "bot" mode has no bot credential, so issues fall back to each
	// reporter's own GitHub token.
	if issueAuthorMode == "bot" && ghBotToken == "" && (ghAppID == "" || ghPrivateKey == "" || ghInstallID == "") {
		fmt.Fprintln(os.Stderr, "warning: no GitHub App or GH_BOT_TOKEN configured; issues will be authored by each reporter's own GitHub token")
	}

	allowedOrigins := envOr("ALLOWED_ORIGINS", "*")

	// ── Store (SQLite by default, Postgres when DATABASE_URL is set) ─────────
	var s *store.Store
	var err error
	if dsn := os.Getenv("DATABASE_URL"); dsn != "" {
		s, err = store.OpenPostgres(dsn)
	} else {
		s, err = store.OpenSQLite(dbPath)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "fatal: open store: %v\n", err)
		os.Exit(1)
	}
	defer func() { _ = s.Close() }()

	// ── GitHub App config ─────────────────────────────────────────────────────
	ghCfg := &github.AppConfig{
		AppID:          ghAppID,
		ClientID:       ghClientID,
		ClientSecret:   ghClientSecret,
		RedirectURI:    ghRedirectURI,
		PrivateKeyPEM:  ghPrivateKey,
		InstallationID: ghInstallID,
		BotToken:       ghBotToken,
		AuthorMode:     issueAuthorMode,
	}

	staticFS, err := fs.Sub(staticFiles, "static")
	if err != nil {
		fmt.Fprintf(os.Stderr, "fatal: static fs: %v\n", err)
		os.Exit(1)
	}
	e, err := app.BuildRouter(app.Options{
		Store:          s,
		GitHub:         ghCfg,
		JWTSecret:      jwtSecret,
		AllowedOrigins: allowedOrigins,
		MCPAPIKey:      os.Getenv("MCP_API_KEY"),
		StaticFS:       staticFS,
		EnvelopeSchema: envelopeSchemaJSON,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "fatal: build router: %v\n", err)
		os.Exit(1)
	}

	// ── Start ─────────────────────────────────────────────────────────────────
	fmt.Printf("emergent-feedback %s (%s) listening on :%s\n", app.Version, app.Commit, port)
	if err := e.Start(":" + port); err != nil && err != http.ErrServerClosed {
		fmt.Fprintf(os.Stderr, "fatal: %v\n", err)
		os.Exit(1)
	}
}

// envOr reads a string environment variable, falling back to def when empty.
func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func mustEnv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		fmt.Fprintf(os.Stderr, "fatal: environment variable %s is required\n", key)
		os.Exit(1)
	}
	return v
}
