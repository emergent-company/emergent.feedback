package github

import (
	"context"
	"testing"
)

func TestIssueTokenSource(t *testing.T) {
	fullApp := func() *AppConfig {
		return &AppConfig{AppID: "1", PrivateKeyPEM: "pem", InstallationID: "42"}
	}

	cases := []struct {
		name       string
		cfg        *AppConfig
		wantSource string
		wantUser   bool
		wantApp    bool
		wantPAT    bool
	}{
		{
			name:       "explicit user mode",
			cfg:        &AppConfig{AuthorMode: "user"},
			wantSource: "user",
			wantUser:   true,
		},
		{
			name:       "default mode with no credentials",
			cfg:        &AppConfig{},
			wantSource: "user",
			wantUser:   true,
		},
		{
			name:       "pat only",
			cfg:        &AppConfig{BotToken: "ghp_bot"},
			wantSource: "pat",
			wantPAT:    true,
		},
		{
			name:       "full app",
			cfg:        fullApp(),
			wantSource: "app",
			wantApp:    true,
		},
		{
			name:       "app wins over pat",
			cfg:        &AppConfig{AppID: "1", PrivateKeyPEM: "pem", InstallationID: "42", BotToken: "ghp_bot"},
			wantSource: "app",
			wantApp:    true,
			wantPAT:    true,
		},
		{
			name:       "explicit user mode beats app",
			cfg:        &AppConfig{AuthorMode: "user", AppID: "1", PrivateKeyPEM: "pem", InstallationID: "42"},
			wantSource: "user",
			wantUser:   true,
			wantApp:    true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.cfg.issueTokenSource(); got != tc.wantSource {
				t.Fatalf("issueTokenSource() = %q, want %q", got, tc.wantSource)
			}
			if got := tc.cfg.UseUserToken(); got != tc.wantUser {
				t.Fatalf("UseUserToken() = %v, want %v", got, tc.wantUser)
			}
			if got := tc.cfg.HasApp(); got != tc.wantApp {
				t.Fatalf("HasApp() = %v, want %v", got, tc.wantApp)
			}
			if got := tc.cfg.HasBotToken(); got != tc.wantPAT {
				t.Fatalf("HasBotToken() = %v, want %v", got, tc.wantPAT)
			}
		})
	}
}

func TestIssueAuthorToken(t *testing.T) {
	ctx := context.Background()

	t.Run("user source with empty token errors", func(t *testing.T) {
		cfg := &AppConfig{}
		if _, err := cfg.IssueAuthorToken(ctx, ""); err == nil {
			t.Fatal("expected error for user source with empty token")
		}
	})

	t.Run("user source returns reporter token", func(t *testing.T) {
		cfg := &AppConfig{}
		got, err := cfg.IssueAuthorToken(ctx, "user-token")
		if err != nil {
			t.Fatalf("IssueAuthorToken: %v", err)
		}
		if got != "user-token" {
			t.Fatalf("got %q, want %q", got, "user-token")
		}
	})

	t.Run("pat source returns bot token", func(t *testing.T) {
		cfg := &AppConfig{BotToken: "  ghp_bot  "}
		got, err := cfg.IssueAuthorToken(ctx, "")
		if err != nil {
			t.Fatalf("IssueAuthorToken: %v", err)
		}
		if got != "ghp_bot" {
			t.Fatalf("got %q, want %q (trimmed)", got, "ghp_bot")
		}
	})
}
