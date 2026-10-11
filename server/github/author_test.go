package github

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

// testAppConfig builds an AppConfig with a valid in-test PKCS1 RSA private key
// and the given installation ID.
func testAppConfig(installationID string) *AppConfig {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		panic(err)
	}
	der := x509.MarshalPKCS1PrivateKey(key)
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: der})
	return &AppConfig{AppID: "1", PrivateKeyPEM: string(pemBytes), InstallationID: installationID}
}

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

func TestInstallationTokenForRepoResolvesRepoInstallation(t *testing.T) {
	ResetInstallationTokenCacheForTesting()
	defer ResetInstallationTokenCacheForTesting()

	cfg := testAppConfig("42")

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/repos/owner/repo/installation":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":71}`))
		case r.Method == http.MethodPost && r.URL.Path == "/app/installations/71/access_tokens":
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"token":"inst-71","expires_at":"2099-01-01T00:00:00Z"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	SetBaseURLForTesting(srv.URL)
	defer SetBaseURLForTesting("https://api.github.com")

	got, err := cfg.InstallationTokenForRepo(context.Background(), "owner/repo")
	if err != nil {
		t.Fatalf("InstallationTokenForRepo: %v", err)
	}
	if got != "inst-71" {
		t.Fatalf("got %q, want %q", got, "inst-71")
	}
}

func TestInstallationTokenForRepoNotInstalled(t *testing.T) {
	ResetInstallationTokenCacheForTesting()
	defer ResetInstallationTokenCacheForTesting()

	cfg := testAppConfig("42")

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/repos/owner/repo/installation" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"message":"Not Found"}`))
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()
	SetBaseURLForTesting(srv.URL)
	defer SetBaseURLForTesting("https://api.github.com")

	_, err := cfg.InstallationTokenForRepo(context.Background(), "owner/repo")
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusNotFound {
		t.Fatalf("expected *APIError with Status 404, got %v", err)
	}
}

func TestInstallationTokenCachePerInstallation(t *testing.T) {
	ResetInstallationTokenCacheForTesting()
	defer ResetInstallationTokenCacheForTesting()

	cfg := testAppConfig("42")

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/repos/owner/one/installation":
			_, _ = w.Write([]byte(`{"id":11}`))
		case r.Method == http.MethodPost && r.URL.Path == "/app/installations/11/access_tokens":
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"token":"inst-11","expires_at":"2099-01-01T00:00:00Z"}`))
		case r.Method == http.MethodGet && r.URL.Path == "/repos/owner/two/installation":
			_, _ = w.Write([]byte(`{"id":22}`))
		case r.Method == http.MethodPost && r.URL.Path == "/app/installations/22/access_tokens":
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"token":"inst-22","expires_at":"2099-01-01T00:00:00Z"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	SetBaseURLForTesting(srv.URL)
	defer SetBaseURLForTesting("https://api.github.com")

	one, err := cfg.InstallationTokenForRepo(context.Background(), "owner/one")
	if err != nil {
		t.Fatalf("owner/one: %v", err)
	}
	two, err := cfg.InstallationTokenForRepo(context.Background(), "owner/two")
	if err != nil {
		t.Fatalf("owner/two: %v", err)
	}
	if one != "inst-11" {
		t.Fatalf("owner/one = %q, want inst-11", one)
	}
	if two != "inst-22" {
		t.Fatalf("owner/two = %q, want inst-22", two)
	}

	// Re-fetch both (should be served from the per-ID cache) and confirm they
	// still differ, proving the cache is not a single global.
	one2, err := cfg.InstallationTokenForRepo(context.Background(), "owner/one")
	if err != nil {
		t.Fatalf("owner/one (cached): %v", err)
	}
	if one2 != one {
		t.Fatalf("owner/one cache changed: %q -> %q", one, one2)
	}
	two2, err := cfg.InstallationTokenForRepo(context.Background(), "owner/two")
	if err != nil {
		t.Fatalf("owner/two (cached): %v", err)
	}
	if two2 != two {
		t.Fatalf("owner/two cache changed: %q -> %q", two, two2)
	}
}
