package github

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

func TestGetIssue(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/repos/org/repo/issues/42" {
			t.Errorf("unexpected path %q", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"state":"closed","number":42,"title":"x"}`)
	}))
	defer srv.Close()

	state, err := getIssue(context.Background(), srv.URL, "tok", "org/repo", 42)
	if err != nil {
		t.Fatalf("getIssue: %v", err)
	}
	if state != "closed" {
		t.Fatalf("state = %q, want closed", state)
	}
}

func TestGetIssueInvalidRepo(t *testing.T) {
	if _, err := getIssue(context.Background(), "http://example.com", "tok", "invalid", 1); err == nil {
		t.Fatal("expected error for invalid repo")
	}
}

func TestGetIssueNon200(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	if _, err := getIssue(context.Background(), srv.URL, "tok", "org/repo", 1); err == nil {
		t.Fatal("expected error for non-200")
	}
}

func TestAuthCodeURL(t *testing.T) {
	cfg := &AppConfig{
		ClientID:    "client-123",
		RedirectURI: "https://example.test/auth/callback",
	}
	u, err := url.Parse(cfg.AuthCodeURL("state-abc"))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	q := u.Query()
	if got := q.Get("scope"); got != "repo" {
		t.Errorf("scope = %q, want repo", got)
	}
	if got := q.Get("client_id"); got != "client-123" {
		t.Errorf("client_id = %q, want client-123", got)
	}
	if got := q.Get("redirect_uri"); got != "https://example.test/auth/callback" {
		t.Errorf("redirect_uri = %q, want https://example.test/auth/callback", got)
	}
	if got := q.Get("state"); got != "state-abc" {
		t.Errorf("state = %q, want state-abc", got)
	}
}
