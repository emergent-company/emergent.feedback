package github

import (
	"bytes"
	"context"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

var apiBase = "https://api.github.com"

// SetBaseURLForTesting overrides the GitHub API base URL (for tests).
func SetBaseURLForTesting(base string) { apiBase = base }

// httpClient is the shared HTTP client for all GitHub API calls.
// Timeout prevents a hung upstream from blocking a request forever.
var httpClient = &http.Client{Timeout: 30 * time.Second}

// AppConfig holds GitHub App credentials.
type AppConfig struct {
	AppID          string
	ClientID       string
	ClientSecret   string
	RedirectURI    string
	PrivateKeyPEM  string // RSA private key in PEM format
	InstallationID string // numeric installation ID on the target org/account
	BotToken       string // optional PAT used to create issues when no GitHub App is configured
	AuthorMode     string // "bot" (default) or "user"

	keyOnce sync.Once
	keyVal  *rsa.PrivateKey
	keyErr  error
}

// privateKey parses and caches the RSA private key from PEM.
func (c *AppConfig) privateKey() (*rsa.PrivateKey, error) {
	c.keyOnce.Do(func() {
		block, _ := pem.Decode([]byte(c.PrivateKeyPEM))
		if block == nil {
			c.keyErr = fmt.Errorf("github app: failed to decode PEM block")
			return
		}
		c.keyVal, c.keyErr = x509.ParsePKCS1PrivateKey(block.Bytes)
		if c.keyErr != nil {
			c.keyErr = fmt.Errorf("github app: parse private key: %w", c.keyErr)
		}
	})
	return c.keyVal, c.keyErr
}

// appJWT creates a short-lived JWT signed with the App's private key.
// GitHub requires this to authenticate as the App itself.
func (c *AppConfig) appJWT() (string, error) {
	key, err := c.privateKey()
	if err != nil {
		return "", err
	}
	now := time.Now()
	claims := jwt.RegisteredClaims{
		IssuedAt:  jwt.NewNumericDate(now.Add(-30 * time.Second)), // allow clock skew
		ExpiresAt: jwt.NewNumericDate(now.Add(9 * time.Minute)),
		Issuer:    c.AppID,
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	return tok.SignedString(key)
}

// installationToken caches a short-lived installation access token.
var (
	instTokenMu      sync.Mutex
	instTokenVal     string
	instTokenExpires time.Time
)

// InstallationToken returns a valid installation access token, refreshing if needed.
func (c *AppConfig) InstallationToken(ctx context.Context) (string, error) {
	instTokenMu.Lock()
	defer instTokenMu.Unlock()

	if instTokenVal != "" && time.Now().Before(instTokenExpires.Add(-2*time.Minute)) {
		return instTokenVal, nil
	}

	appTok, err := c.appJWT()
	if err != nil {
		return "", err
	}

	url := fmt.Sprintf("%s/app/installations/%s/access_tokens", apiBase, c.InstallationID)
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, url, nil)
	req.Header.Set("Authorization", "Bearer "+appTok)
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("github app: get installation token: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusCreated {
		var gh struct {
			Message string `json:"message"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&gh)
		return "", fmt.Errorf("github app: get installation token: status %d: %s", resp.StatusCode, gh.Message)
	}

	var result struct {
		Token     string    `json:"token"`
		ExpiresAt time.Time `json:"expires_at"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", fmt.Errorf("github app: decode installation token: %w", err)
	}

	instTokenVal = result.Token
	instTokenExpires = result.ExpiresAt
	return instTokenVal, nil
}

// HasApp reports whether a complete GitHub App bot is configured.
func (c *AppConfig) HasApp() bool {
	return c.AppID != "" && c.PrivateKeyPEM != "" && c.InstallationID != ""
}

// HasBotToken reports whether a bot PAT is configured.
func (c *AppConfig) HasBotToken() bool { return strings.TrimSpace(c.BotToken) != "" }

// issueTokenSource: "user" when AuthorMode=="user", else "app" if a full App is
// configured, else "pat" if a bot token is set, else "user".
func (c *AppConfig) issueTokenSource() string {
	if c.AuthorMode == "user" {
		return "user"
	}
	if c.HasApp() {
		return "app"
	}
	if c.HasBotToken() {
		return "pat"
	}
	return "user"
}

// UseUserToken reports whether the reporter's own token is required to author issues.
func (c *AppConfig) UseUserToken() bool { return c.issueTokenSource() == "user" }

// IssueAuthorToken returns the token to create issues with. userToken is the
// reporter's token, used in "user" mode (and as the final fallback).
func (c *AppConfig) IssueAuthorToken(ctx context.Context, userToken string) (string, error) {
	switch c.issueTokenSource() {
	case "app":
		return c.InstallationToken(ctx)
	case "pat":
		return strings.TrimSpace(c.BotToken), nil
	default:
		if userToken == "" {
			return "", fmt.Errorf("github: no issue author token available (configure a GitHub App, GH_BOT_TOKEN, or sign in with GitHub)")
		}
		return userToken, nil
	}
}

// AuthCodeURL builds the GitHub App OAuth authorization URL.
// GitHub Apps use a slightly different URL from OAuth Apps.
//
// The "repo" scope below applies only to OAuth App sign-in. GitHub Apps ignore
// the scope parameter — their user-token permissions come from the App's
// repository permissions. In ISSUE_AUTHOR_MODE=user with a GitHub App, that App
// must have its "Issues" repository permission set to Read & write.
func (c *AppConfig) AuthCodeURL(state string) string {
	v := url.Values{}
	v.Set("client_id", c.ClientID)
	v.Set("redirect_uri", c.RedirectURI)
	v.Set("scope", "repo")
	v.Set("state", state)
	return "https://github.com/login/oauth/authorize?" + v.Encode()
}

// ExchangeCode exchanges an authorization code for a user access token.
func (c *AppConfig) ExchangeCode(ctx context.Context, code string) (string, error) {
	body, _ := json.Marshal(map[string]string{
		"client_id":     c.ClientID,
		"client_secret": c.ClientSecret,
		"code":          code,
		"redirect_uri":  c.RedirectURI,
	})

	req, _ := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://github.com/login/oauth/access_token", bytes.NewReader(body))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")

	resp, err := httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("github app: exchange code: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	var result struct {
		AccessToken string `json:"access_token"`
		Error       string `json:"error"`
		ErrorDesc   string `json:"error_description"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", fmt.Errorf("github app: decode token response: %w", err)
	}
	if result.Error != "" {
		return "", fmt.Errorf("github app: exchange code: %s: %s", result.Error, result.ErrorDesc)
	}
	return result.AccessToken, nil
}

// User fetches the authenticated GitHub user's login and avatar.
type User struct {
	Login     string `json:"login"`
	AvatarURL string `json:"avatar_url"`
	Name      string `json:"name"`
}

// GetUser fetches the user profile for the given access token.
func GetUser(ctx context.Context, accessToken string) (User, error) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, apiBase+"/user", nil)
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := httpClient.Do(req)
	if err != nil {
		return User{}, fmt.Errorf("github: get user: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return User{}, fmt.Errorf("github: get user: status %d", resp.StatusCode)
	}
	var u User
	if err := json.NewDecoder(resp.Body).Decode(&u); err != nil {
		return User{}, fmt.Errorf("github: decode user: %w", err)
	}
	return u, nil
}

// Repo is a minimal GitHub repository.
type Repo struct {
	FullName string `json:"full_name"`
	Name     string `json:"name"`
	Private  bool   `json:"private"`
}

// ListUserRepos lists the repositories the access token's user can access.
func ListUserRepos(ctx context.Context, accessToken string) ([]Repo, error) {
	url := apiBase + "/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member"
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("github: list user repos: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("github: list user repos: status %d", resp.StatusCode)
	}
	var repos []Repo
	if err := json.NewDecoder(resp.Body).Decode(&repos); err != nil {
		return nil, fmt.Errorf("github: decode repos: %w", err)
	}
	return repos, nil
}

// CreateIssueParams holds the data for creating a GitHub issue.
type CreateIssueParams struct {
	Repo   string // "owner/repo"
	Title  string
	Body   string
	Labels []string
}

// CreateIssueResponse is the minimal response from the GitHub Issues API.
type CreateIssueResponse struct {
	HTMLURL string `json:"html_url"`
	Number  int    `json:"number"`
}

// CreateIssue creates a GitHub issue using the provided token.
func CreateIssue(ctx context.Context, accessToken string, p CreateIssueParams) (CreateIssueResponse, error) {
	parts := strings.SplitN(p.Repo, "/", 2)
	if len(parts) != 2 {
		return CreateIssueResponse{}, fmt.Errorf("github: invalid repo %q (want owner/repo)", p.Repo)
	}

	payload := map[string]any{
		"title":  p.Title,
		"body":   p.Body,
		"labels": p.Labels,
	}
	body, _ := json.Marshal(payload)

	url := fmt.Sprintf("%s/repos/%s/%s/issues", apiBase, parts[0], parts[1])
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("Content-Type", "application/json")

	resp, err := httpClient.Do(req)
	if err != nil {
		return CreateIssueResponse{}, fmt.Errorf("github: create issue: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusCreated {
		var gh struct {
			Message string `json:"message"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&gh)
		return CreateIssueResponse{}, fmt.Errorf("github: create issue: status %d: %s", resp.StatusCode, gh.Message)
	}
	var result CreateIssueResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return CreateIssueResponse{}, fmt.Errorf("github: decode issue response: %w", err)
	}
	return result, nil
}

// GetIssue fetches the current state ("open" or "closed") of a GitHub issue.
func GetIssue(ctx context.Context, accessToken, repo string, number int64) (string, error) {
	return getIssue(ctx, apiBase, accessToken, repo, number)
}

// CommentIssue adds a comment to an existing issue.
func CommentIssue(ctx context.Context, accessToken, repo string, number int64, body string) error {
	parts := strings.SplitN(repo, "/", 2)
	if len(parts) != 2 {
		return fmt.Errorf("github: invalid repo %q (want owner/repo)", repo)
	}
	payload := map[string]string{"body": body}
	b, _ := json.Marshal(payload)

	url := fmt.Sprintf("%s/repos/%s/%s/issues/%d/comments", apiBase, parts[0], parts[1], number)
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(b))
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("Content-Type", "application/json")

	resp, err := httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("github: comment issue: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusCreated {
		var gh struct {
			Message string `json:"message"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&gh)
		return fmt.Errorf("github: comment issue: status %d: %s", resp.StatusCode, gh.Message)
	}
	return nil
}

// UpdateIssueState patches an issue's state ("open" or "closed").
func UpdateIssueState(ctx context.Context, accessToken, repo string, number int64, state string) error {
	parts := strings.SplitN(repo, "/", 2)
	if len(parts) != 2 {
		return fmt.Errorf("github: invalid repo %q (want owner/repo)", repo)
	}
	payload := map[string]string{"state": state}
	b, _ := json.Marshal(payload)

	url := fmt.Sprintf("%s/repos/%s/%s/issues/%d", apiBase, parts[0], parts[1], number)
	req, _ := http.NewRequestWithContext(ctx, http.MethodPatch, url, bytes.NewReader(b))
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("Content-Type", "application/json")

	resp, err := httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("github: update issue state: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		var gh struct {
			Message string `json:"message"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&gh)
		return fmt.Errorf("github: update issue state: status %d: %s", resp.StatusCode, gh.Message)
	}
	return nil
}

func getIssue(ctx context.Context, base, accessToken, repo string, number int64) (string, error) {
	parts := strings.SplitN(repo, "/", 2)
	if len(parts) != 2 {
		return "", fmt.Errorf("github: invalid repo %q (want owner/repo)", repo)
	}
	url := fmt.Sprintf("%s/repos/%s/%s/issues/%d", base, parts[0], parts[1], number)
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("github: get issue: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("github: get issue: status %d", resp.StatusCode)
	}
	var result struct {
		State string `json:"state"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", fmt.Errorf("github: decode issue: %w", err)
	}
	return result.State, nil
}
