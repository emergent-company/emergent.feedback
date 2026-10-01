package main

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/emergent-company/emergent.feedback/server/github"
	authmw "github.com/emergent-company/emergent.feedback/server/middleware"
	"github.com/emergent-company/emergent.feedback/server/store"
)

// encryptTokenForTest mirrors handler.encryptToken (AES-GCM under a key derived
// from the JWT secret) so the e2e test can seed a stored GitHub token without
// going through the OAuth callback (which hits github.com).
func encryptTokenForTest(plain, jwtSecret string) []byte {
	sum := sha256.Sum256([]byte("emergent-feedback:token:" + jwtSecret))
	block, err := aes.NewCipher(sum[:])
	if err != nil {
		panic(err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		panic(err)
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		panic(err)
	}
	return gcm.Seal(nonce, nonce, []byte(plain), nil)
}

func TestAPIEndToEnd(t *testing.T) {
	// ── Setup ──────────────────────────────────────────────────────────────────
	s, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	defer func() { _ = s.Close() }()

	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("rsa.GenerateKey: %v", err)
	}
	der := x509.MarshalPKCS1PrivateKey(key)
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: der})
	ghCfg := &github.AppConfig{
		AppID:          "1",
		ClientID:       "c",
		ClientSecret:   "s",
		RedirectURI:    "https://example.test/auth/callback",
		PrivateKeyPEM:  string(pemBytes),
		InstallationID: "1",
	}

	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/app/installations/1/access_tokens":
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"token":"install-token","expires_at":"2099-01-01T00:00:00Z"}`))
		case r.Method == http.MethodPost && r.URL.Path == "/repos/owner/repo/issues":
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"html_url":"https://github.com/owner/repo/issues/1","number":1}`))
		case r.Method == http.MethodGet && r.URL.Path == "/user/repos":
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`[{"full_name":"owner/repo","name":"repo","private":false}]`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer mock.Close()
	github.SetBaseURLForTesting(mock.URL)

	const jwtSecret = "test-secret"
	e := buildRouter(s, ghCfg, jwtSecret, "*", "")

	jwt, err := authmw.IssueToken(jwtSecret, "alice", "")
	if err != nil {
		t.Fatalf("IssueToken: %v", err)
	}
	authHdr := "Bearer " + jwt

	// Seed a stored GitHub token for "alice" so GET /api/repos succeeds.
	if err := s.UpsertUserToken(context.Background(), "alice", encryptTokenForTest("user-token", jwtSecret)); err != nil {
		t.Fatalf("UpsertUserToken: %v", err)
	}

	do := func(method, target, body string, headers map[string]string) *httptest.ResponseRecorder {
		var req *http.Request
		if body != "" {
			req = httptest.NewRequest(method, target, strings.NewReader(body))
		} else {
			req = httptest.NewRequest(method, target, nil)
		}
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)
		return rec
	}

	jsonHdr := func() map[string]string {
		return map[string]string{"Content-Type": "application/json", "Authorization": authHdr}
	}

	var (
		feedbackID int64
		apiKeyID   int64
		apiKey     string
	)

	t.Run("01 health", func(t *testing.T) {
		rec := do(http.MethodGet, "/health", "", nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		var body map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if body["ok"] != true {
			t.Fatalf("ok = %v, want true", body["ok"])
		}
	})

	t.Run("02 panel", func(t *testing.T) {
		rec := do(http.MethodGet, "/panel", "", nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "text/html") {
			t.Fatalf("content-type = %q, want text/html", ct)
		}
	})

	t.Run("03 emergent-feedback.js", func(t *testing.T) {
		rec := do(http.MethodGet, "/emergent-feedback.js", "", nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
	})

	t.Run("04 static css", func(t *testing.T) {
		rec := do(http.MethodGet, "/static/css/app.css", "", nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
	})

	t.Run("05 auth github redirect", func(t *testing.T) {
		rec := do(http.MethodGet, "/auth/github", "", nil)
		if rec.Code != http.StatusTemporaryRedirect {
			t.Fatalf("status = %d, want 307", rec.Code)
		}
		if loc := rec.Header().Get("Location"); !strings.Contains(loc, "github.com") {
			t.Fatalf("Location = %q, want github.com", loc)
		}
	})

	t.Run("06 me no auth", func(t *testing.T) {
		rec := do(http.MethodGet, "/me", "", nil)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401", rec.Code)
		}
	})

	t.Run("07 me with auth", func(t *testing.T) {
		rec := do(http.MethodGet, "/me", "", map[string]string{"Authorization": authHdr})
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		var body map[string]string
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if body["login"] != "alice" {
			t.Fatalf("login = %q, want alice", body["login"])
		}
	})

	t.Run("08 create feedback", func(t *testing.T) {
		body := `{"url":"https://app.example.com/dashboard","selector":"button.foo","comment":"hello world","context":{"page":"dashboard"},"repo":"owner/repo","label":"feedback"}`
		rec := do(http.MethodPost, "/feedback", body, jsonHdr())
		if rec.Code != http.StatusCreated {
			t.Fatalf("status = %d, want 201: %s", rec.Code, rec.Body.String())
		}
		var out struct {
			ID int64 `json:"id"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if out.ID == 0 {
			t.Fatal("expected non-zero id")
		}
		feedbackID = out.ID
	})

	t.Run("09 feedback list", func(t *testing.T) {
		rec := do(http.MethodGet, "/feedback/list?url="+url.QueryEscape("https://app.example.com/dashboard"), "", map[string]string{"Authorization": authHdr})
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		var items []struct {
			ID int64 `json:"id"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &items); err != nil {
			t.Fatalf("decode: %v", err)
		}
		found := false
		for _, it := range items {
			if it.ID == feedbackID {
				found = true
			}
		}
		if !found {
			t.Fatalf("feedback %d not found in list: %s", feedbackID, rec.Body.String())
		}
	})

	t.Run("10 get feedback", func(t *testing.T) {
		rec := do(http.MethodGet, "/feedback/"+int64Str(feedbackID), "", map[string]string{"Authorization": authHdr})
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
	})

	t.Run("11 export issue", func(t *testing.T) {
		body := `{"ids":[` + int64Str(feedbackID) + `],"repo":"owner/repo","labels":["feedback"]}`
		rec := do(http.MethodPost, "/issue/export", body, jsonHdr())
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
		}
		// The feedback item should now be resolved with an issue_url set.
		rec2 := do(http.MethodGet, "/feedback/"+int64Str(feedbackID), "", map[string]string{"Authorization": authHdr})
		if rec2.Code != http.StatusOK {
			t.Fatalf("get feedback status = %d, want 200", rec2.Code)
		}
		var f struct {
			Status   string `json:"status"`
			IssueURL string `json:"issue_url"`
		}
		if err := json.Unmarshal(rec2.Body.Bytes(), &f); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if f.Status != "exported" {
			t.Fatalf("status = %q, want exported", f.Status)
		}
		if f.IssueURL != "https://github.com/owner/repo/issues/1" {
			t.Fatalf("issue_url = %q, want mock issue url", f.IssueURL)
		}
	})

	t.Run("12 create api key", func(t *testing.T) {
		rec := do(http.MethodPost, "/api/keys", `{"repos":["owner/repo"]}`, jsonHdr())
		if rec.Code != http.StatusCreated {
			t.Fatalf("status = %d, want 201: %s", rec.Code, rec.Body.String())
		}
		var out struct {
			ID  int64  `json:"id"`
			Key string `json:"key"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if !strings.HasPrefix(out.Key, "fo_") {
			t.Fatalf("key %q missing fo_ prefix", out.Key)
		}
		apiKeyID = out.ID
		apiKey = out.Key
	})

	t.Run("13 list api keys", func(t *testing.T) {
		rec := do(http.MethodGet, "/api/keys", "", map[string]string{"Authorization": authHdr})
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		var keys []struct {
			ID int64 `json:"id"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &keys); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if len(keys) != 1 {
			t.Fatalf("len(keys) = %d, want 1", len(keys))
		}
	})

	t.Run("15 list repos", func(t *testing.T) {
		rec := do(http.MethodGet, "/api/repos", "", map[string]string{"Authorization": authHdr})
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
		}
		var repos []struct {
			FullName string `json:"full_name"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &repos); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if len(repos) != 1 || repos[0].FullName != "owner/repo" {
			t.Fatalf("repos = %v, want [{full_name:owner/repo}]", repos)
		}
	})

	t.Run("16 mcp initialize no auth", func(t *testing.T) {
		rec := do(http.MethodPost, "/mcp", `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`, map[string]string{"Content-Type": "application/json"})
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401", rec.Code)
		}
	})

	t.Run("17 mcp initialize with key", func(t *testing.T) {
		initBody := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test-client","version":"1.0"}}}`
		rec := do(http.MethodPost, "/mcp", initBody, map[string]string{
			"Content-Type":  "application/json",
			"Accept":        "application/json, text/event-stream",
			"Authorization": "Bearer " + apiKey,
		})
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
		}
		var resp struct {
			Result struct {
				ServerInfo struct {
					Name string `json:"name"`
				} `json:"serverInfo"`
			} `json:"result"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode mcp response: %v (body=%s)", err, rec.Body.String())
		}
		if resp.Result.ServerInfo.Name != "emergent-feedback" {
			t.Fatalf("serverInfo.name = %q, want emergent-feedback", resp.Result.ServerInfo.Name)
		}
	})

	t.Run("14 revoke api key", func(t *testing.T) {
		rec := do(http.MethodDelete, "/api/keys/"+int64Str(apiKeyID), "", map[string]string{"Authorization": authHdr})
		if rec.Code != http.StatusNoContent {
			t.Fatalf("status = %d, want 204", rec.Code)
		}
		rec2 := do(http.MethodGet, "/api/keys", "", map[string]string{"Authorization": authHdr})
		if rec2.Code != http.StatusOK {
			t.Fatalf("list status = %d, want 200", rec2.Code)
		}
		var keys []struct {
			ID      int64 `json:"id"`
			Revoked bool  `json:"revoked"`
		}
		if err := json.Unmarshal(rec2.Body.Bytes(), &keys); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if len(keys) != 1 {
			t.Fatalf("len(keys) = %d, want 1", len(keys))
		}
		if !keys[0].Revoked {
			t.Fatalf("key %d should be revoked, got revoked=%v", keys[0].ID, keys[0].Revoked)
		}
	})
}

func int64Str(n int64) string {
	return strconv.FormatInt(n, 10)
}

func TestLandingPage(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	defer func() { _ = s.Close() }()

	e := buildRouter(s, &github.AppConfig{}, "test-secret", "*", "")

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("GET / status = %d, want 200", rec.Code)
	}
	body := rec.Body.String()
	for _, want := range []string{"emergent.feedback", "Hold Alt+Shift", "/emergent-feedback.js", "Self-host"} {
		if !strings.Contains(body, want) {
			t.Errorf("landing page missing %q", want)
		}
	}
}
