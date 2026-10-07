package github

import (
	"context"
	"errors"
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

func TestListUserReposAuthError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()

	prev := apiBase
	SetBaseURLForTesting(srv.URL)
	defer SetBaseURLForTesting(prev)

	_, err := ListUserRepos(context.Background(), "tok")
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("err = %v, want *APIError", err)
	}
	if apiErr.Status != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", apiErr.Status)
	}
}

func TestListUserReposPagination(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Query().Get("page") == "2" {
			_, _ = io.WriteString(w, `[{"full_name":"b/repo2","name":"repo2"}]`)
			return
		}
		w.Header().Set("Link",
			`<http://`+r.Host+`/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member&page=2>; rel="next"`)
		_, _ = io.WriteString(w, `[{"full_name":"a/repo1","name":"repo1"}]`)
	}))
	defer srv.Close()

	prev := apiBase
	SetBaseURLForTesting(srv.URL)
	defer SetBaseURLForTesting(prev)

	repos, err := ListUserRepos(context.Background(), "tok")
	if err != nil {
		t.Fatalf("ListUserRepos: %v", err)
	}
	if len(repos) != 2 {
		t.Fatalf("got %d repos, want 2", len(repos))
	}
	if repos[0].FullName != "a/repo1" || repos[1].FullName != "b/repo2" {
		t.Fatalf("unexpected repos %+v", repos)
	}
}

func TestRepoAccessible(t *testing.T) {
	cases := []struct {
		name    string
		status  int
		want    bool
		wantAPI bool
		wantErr bool
	}{
		{"200", http.StatusOK, true, false, false},
		{"404", http.StatusNotFound, false, false, false},
		{"401", http.StatusUnauthorized, false, true, false},
		{"403", http.StatusForbidden, false, true, false},
		{"500", http.StatusInternalServerError, false, false, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/repos/org/repo" {
					t.Errorf("unexpected path %q", r.URL.Path)
				}
				w.WriteHeader(tc.status)
			}))
			defer srv.Close()

			prev := apiBase
			SetBaseURLForTesting(srv.URL)
			defer SetBaseURLForTesting(prev)

			ok, err := RepoAccessible(context.Background(), "tok", "org/repo")
			if ok != tc.want {
				t.Fatalf("ok = %v, want %v", ok, tc.want)
			}
			switch {
			case tc.wantAPI:
				var apiErr *APIError
				if !errors.As(err, &apiErr) {
					t.Fatalf("err = %v, want *APIError", err)
				}
				if apiErr.Status != tc.status {
					t.Fatalf("status = %d, want %d", apiErr.Status, tc.status)
				}
			case tc.wantErr:
				if err == nil {
					t.Fatal("expected error")
				}
			default:
				if err != nil {
					t.Fatalf("err = %v, want nil", err)
				}
			}
		})
	}
}

func TestRepoAccessibleInvalidRepo(t *testing.T) {
	if _, err := RepoAccessible(context.Background(), "tok", "invalid"); err == nil {
		t.Fatal("expected error for invalid repo")
	}
}

func TestListUserInstallations(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/user/installations" {
			t.Errorf("unexpected path %q", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"installations":[{"id":1,"app_slug":"my-app","repository_selection":"selected","html_url":"https://github.com/settings/installations/1","account":{"login":"acme","type":"Organization"}}]}`)
	}))
	defer srv.Close()

	prev := apiBase
	SetBaseURLForTesting(srv.URL)
	defer SetBaseURLForTesting(prev)

	installs, err := ListUserInstallations(context.Background(), "tok")
	if err != nil {
		t.Fatalf("ListUserInstallations: %v", err)
	}
	if len(installs) != 1 {
		t.Fatalf("got %d installations, want 1", len(installs))
	}
	if installs[0].AppSlug != "my-app" || installs[0].Account.Login != "acme" || installs[0].HTMLURL != "https://github.com/settings/installations/1" {
		t.Fatalf("unexpected installation %+v", installs[0])
	}
}

func TestInstallationRepositories(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/user/installations/7/repositories" {
			t.Errorf("unexpected path %q", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"repositories":[{"full_name":"acme/repo","name":"repo","private":true}]}`)
	}))
	defer srv.Close()

	prev := apiBase
	SetBaseURLForTesting(srv.URL)
	defer SetBaseURLForTesting(prev)

	repos, err := InstallationRepositories(context.Background(), "tok", 7)
	if err != nil {
		t.Fatalf("InstallationRepositories: %v", err)
	}
	if len(repos) != 1 || repos[0].FullName != "acme/repo" {
		t.Fatalf("unexpected repos %+v", repos)
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

func TestCreateIssueNon201ReturnsAPIError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnprocessableEntity)
		_, _ = io.WriteString(w, `{"message":"Validation Failed","errors":[{"resource":"Issue","field":"labels"}]}`)
	}))
	defer srv.Close()

	prev := apiBase
	SetBaseURLForTesting(srv.URL)
	defer SetBaseURLForTesting(prev)

	_, err := CreateIssue(context.Background(), "tok", CreateIssueParams{
		Repo:   "owner/repo",
		Title:  "t",
		Body:   "b",
		Labels: []string{"feedback"},
	})
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("err = %v, want *APIError", err)
	}
	if apiErr.Status != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422", apiErr.Status)
	}
	if apiErr.Message != "Validation Failed" {
		t.Fatalf("message = %q, want Validation Failed", apiErr.Message)
	}
}
