package handler

import (
	"context"
	"net/http"

	"github.com/emergent-company/emergent.feedback/server/github"
	"github.com/emergent-company/emergent.feedback/server/memory"
	"github.com/emergent-company/emergent.feedback/server/store"
)

// Handler holds the shared dependencies for all HTTP handlers.
type Handler struct {
	Store     *store.Store
	GHConfig  *github.AppConfig
	JWTSecret string
	// PublicBaseURL is the externally reachable feedback origin, used to build
	// deep links back to a report. Optional; derived from the request when empty.
	PublicBaseURL string
	// MemoryHTTP is the client used for Memory server-to-server calls. The app
	// injects an SSRF-guarded client; tests that use httptest servers opt in to
	// a private-address client.
	MemoryHTTP *http.Client

	memoryWake chan struct{}
}

// New creates a new Handler with the given dependencies.
func New(s *store.Store, ghCfg *github.AppConfig, jwtSecret string) *Handler {
	return &Handler{
		Store:      s,
		GHConfig:   ghCfg,
		JWTSecret:  jwtSecret,
		MemoryHTTP: memory.SafeHTTPClient(false),
		memoryWake: make(chan struct{}, 1),
	}
}

// githubBotToken resolves the server-side token for GitHub calls not tied to a
// reporter (App installation, then bot PAT). Errors when only user mode is available.
func (h *Handler) githubBotToken(ctx context.Context) (string, error) {
	return h.GHConfig.IssueAuthorToken(ctx, "")
}

// tokenForGitHubAction picks the token for a GitHub call tied to feedback owned
// by login: the reporter's own token in user mode, otherwise the bot credential.
func (h *Handler) tokenForGitHubAction(ctx context.Context, login string) (string, error) {
	if h.GHConfig.UseUserToken() {
		return h.userTokenFor(ctx, login)
	}
	return h.githubBotToken(ctx)
}
