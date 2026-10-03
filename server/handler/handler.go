package handler

import (
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
