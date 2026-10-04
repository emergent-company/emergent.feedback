package handler

import (
	"context"

	"github.com/emergent-company/emergent.feedback/server/github"
	"github.com/emergent-company/emergent.feedback/server/store"
)

// Handler holds the shared dependencies for all HTTP handlers.
type Handler struct {
	Store     *store.Store
	GHConfig  *github.AppConfig
	JWTSecret string
}

// New creates a new Handler with the given dependencies.
func New(s *store.Store, ghCfg *github.AppConfig, jwtSecret string) *Handler {
	return &Handler{
		Store:     s,
		GHConfig:  ghCfg,
		JWTSecret: jwtSecret,
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
