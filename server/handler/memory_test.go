package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/emergent-company/emergent.feedback/server/github"
	"github.com/emergent-company/emergent.feedback/server/memory"
	"github.com/emergent-company/emergent.feedback/server/middleware"
	"github.com/emergent-company/emergent.feedback/server/store"
	"github.com/labstack/echo/v4"
)

type fakeMemory struct {
	mu          sync.Mutex
	upserts     []map[string]any
	patches     []map[string]any
	patchIDs    []string
	lastForm    url.Values
	failUpserts int
	token       string
}

func (f *fakeMemory) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/projects", func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer emt_") {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"message":"bad token"}`))
			return
		}
		_, _ = w.Write([]byte(`[{"id":"p1","name":"Project One"}]`))
	})
	mux.HandleFunc("/api/graph/objects/upsert", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		if f.failUpserts > 0 {
			f.failUpserts--
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"message":"temporary"}`))
			return
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.upserts = append(f.upserts, body)
		key, _ := body["key"].(string)
		_, _ = w.Write([]byte(`{"id":"obj1","canonical_id":"canon1","type":"Issue","key":"` + key + `"}`))
	})
	mux.HandleFunc("/api/graph/objects/canon1", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.patches = append(f.patches, body)
		f.patchIDs = append(f.patchIDs, r.URL.Path)
		_, _ = w.Write([]byte(`{"id":"obj1","canonical_id":"canon1"}`))
	})
	mux.HandleFunc("/.well-known/oauth-authorization-server", func(w http.ResponseWriter, r *http.Request) {
		base := "http://" + r.Host
		_, _ = w.Write([]byte(`{"issuer":"` + base + `","authorization_endpoint":"` + base + `/oauth/authorize","token_endpoint":"` + base + `/api/oauth/token","registration_endpoint":"` + base + `/api/oauth/register","revocation_endpoint":"` + base + `/api/oauth/revoke"}`))
	})
	mux.HandleFunc("/api/oauth/register", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"client_id":"client-1"}`))
	})
	mux.HandleFunc("/api/oauth/token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		f.mu.Lock()
		f.lastForm = r.PostForm
		f.mu.Unlock()
		_, _ = w.Write([]byte(`{"access_token":"` + f.token + `","token_type":"Bearer","scope":"graph:read graph:write","project_id":"p1","project_name":"Project One"}`))
	})
	mux.HandleFunc("/api/oauth/revoke", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	return mux
}

func newMemoryTestHandler(t *testing.T, mem *fakeMemory) (*Handler, *store.Store, *echo.Echo) {
	t.Helper()
	s, err := store.OpenSQLite(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })

	enc, err := encryptToken("gho_test", "secret")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.UpsertUserToken(context.Background(), "alice", enc); err != nil {
		t.Fatal(err)
	}
	bobEnc, err := encryptToken("gho_bob", "secret")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.UpsertUserToken(context.Background(), "bob", bobEnc); err != nil {
		t.Fatal(err)
	}
	carolEnc, err := encryptToken("gho_carol", "secret")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.UpsertUserToken(context.Background(), "carol", carolEnc); err != nil {
		t.Fatal(err)
	}

	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		bob := strings.Contains(r.Header.Get("Authorization"), "gho_bob")
		carol := strings.Contains(r.Header.Get("Authorization"), "gho_carol")
		switch r.URL.Path {
		case "/repos/org/repo":
			if bob {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			_, _ = w.Write([]byte(`{"full_name":"org/repo","permissions":{"admin":` + strconv.FormatBool(!carol) + `}}`))
		case "/user/repos":
			if bob {
				_, _ = w.Write([]byte(`[]`))
				return
			}
			_, _ = w.Write([]byte(`[{"full_name":"org/repo","permissions":{"admin":` + strconv.FormatBool(!carol) + `}}]`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(gh.Close)
	github.SetBaseURLForTesting(gh.URL)
	t.Cleanup(func() { github.SetBaseURLForTesting("https://api.github.com") })

	h := New(s, &github.AppConfig{}, "secret")
	h.PublicBaseURL = "https://feedback.example.com"
	// The fake Memory server is an httptest listener on loopback.
	h.MemoryHTTP = memory.SafeHTTPClient(true)
	e := echo.New()
	e.Use(func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			c.Set(middleware.UserLoginKey, c.Request().Header.Get("X-Test-Login"))
			return next(c)
		}
	})
	e.GET("/api/memory/status", h.HandleMemoryStatus)
	e.GET("/api/memory/destinations", h.HandleListMemoryDestinations)
	e.POST("/api/memory/destinations", h.HandleCreateMemoryDestination)
	e.PATCH("/api/memory/destinations", h.HandleUpdateMemoryDestination)
	e.DELETE("/api/memory/destinations", h.HandleDeleteMemoryDestination)
	e.POST("/api/memory/destinations/test", h.HandleTestMemoryDestination)
	e.POST("/api/memory/sync", h.HandleSyncFeedbackToMemory)
	e.POST("/api/memory/oauth/start", h.HandleMemoryOAuthStart)
	e.GET("/oauth/memory/callback", h.HandleMemoryOAuthCallback)
	e.POST("/feedback", h.HandleCreateFeedback)
	e.DELETE("/feedback/:id", h.HandleDeleteFeedback)
	return h, s, e
}

func doJSON(t *testing.T, e *echo.Echo, method, path, login, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if login != "" {
		req.Header.Set("X-Test-Login", login)
	}
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	return rec
}

func connectMemory(t *testing.T, e *echo.Echo, base string) {
	t.Helper()
	rec := doJSON(t, e, http.MethodPost, "/api/memory/destinations", "alice", `{
		"repo":"org/repo","base_url":"`+base+`","project_id":"p1","token":"emt_test","mode":"auto"
	}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("connect = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestMemoryPasteConnectStatusAndDelete(t *testing.T) {
	mem := &fakeMemory{token: "emt_oauth"}
	srv := httptest.NewServer(mem.handler())
	defer srv.Close()
	_, s, e := newMemoryTestHandler(t, mem)

	connectMemory(t, e, srv.URL)
	d, err := s.GetMemoryDestination(context.Background(), "org/repo")
	if err != nil {
		t.Fatalf("destination: %v", err)
	}
	if d.Mode != "auto" || d.ProjectName != "Project One" || d.CreatedBy != "alice" {
		t.Fatalf("unexpected destination: %+v", d)
	}
	if len(d.TokenEncrypted) == 0 || string(d.TokenEncrypted) == "emt_test" {
		t.Fatal("token was not encrypted")
	}

	rec := doJSON(t, e, http.MethodGet, "/api/memory/status?repo=org/repo", "", "")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"connected":true`) || !strings.Contains(rec.Body.String(), `"mode":"auto"`) {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}

	rec = doJSON(t, e, http.MethodGet, "/api/memory/destinations", "alice", "")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"repo":"org/repo"`) || strings.Contains(rec.Body.String(), "emt_") {
		t.Fatalf("list leaked or failed: %d %s", rec.Code, rec.Body.String())
	}

	// Another user cannot see or delete it.
	rec = doJSON(t, e, http.MethodGet, "/api/memory/destinations", "bob", "")
	if rec.Code != http.StatusOK || strings.Contains(rec.Body.String(), "org/repo") {
		t.Fatalf("bob saw alice's destination: %s", rec.Body.String())
	}
	rec = doJSON(t, e, http.MethodDelete, "/api/memory/destinations?repo=org/repo", "bob", "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("bob delete = %d, want 404", rec.Code)
	}

	rec = doJSON(t, e, http.MethodDelete, "/api/memory/destinations?repo=org/repo", "alice", "")
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete = %d: %s", rec.Code, rec.Body.String())
	}
	if _, err := s.GetMemoryDestination(context.Background(), "org/repo"); err == nil {
		t.Fatal("destination still present")
	}
}

func TestMemoryModeUpdate(t *testing.T) {
	mem := &fakeMemory{}
	srv := httptest.NewServer(mem.handler())
	defer srv.Close()
	_, s, e := newMemoryTestHandler(t, mem)
	connectMemory(t, e, srv.URL)

	rec := doJSON(t, e, http.MethodPatch, "/api/memory/destinations", "alice", `{"repo":"org/repo","mode":"off"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("patch = %d: %s", rec.Code, rec.Body.String())
	}
	d, _ := s.GetMemoryDestination(context.Background(), "org/repo")
	if d.Mode != "off" {
		t.Fatalf("mode = %q", d.Mode)
	}
	rec = doJSON(t, e, http.MethodPatch, "/api/memory/destinations", "alice", `{"repo":"org/repo","mode":"nope"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("bad mode = %d", rec.Code)
	}
}

func TestMemoryDestinationManagementRequiresRepoAdmin(t *testing.T) {
	mem := &fakeMemory{}
	srv := httptest.NewServer(mem.handler())
	defer srv.Close()
	_, s, e := newMemoryTestHandler(t, mem)
	connectMemory(t, e, srv.URL)

	rec := doJSON(t, e, http.MethodGet, "/api/memory/destinations", "carol", "")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"repo":"org/repo"`) || !strings.Contains(rec.Body.String(), `"can_manage":false`) {
		t.Fatalf("carol list = %d %s", rec.Code, rec.Body.String())
	}
	rec = doJSON(t, e, http.MethodGet, "/api/memory/destinations", "alice", "")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"can_manage":true`) {
		t.Fatalf("alice list = %d %s", rec.Code, rec.Body.String())
	}

	for _, tc := range []struct {
		name, method, path, body string
	}{
		{"oauth", http.MethodPost, "/api/memory/oauth/start", `{"repo":"org/repo","base_url":"` + srv.URL + `"}`},
		{"paste", http.MethodPost, "/api/memory/destinations", `{"repo":"org/repo","base_url":"` + srv.URL + `","project_id":"p1","token":"emt_test"}`},
		{"mode", http.MethodPatch, "/api/memory/destinations", `{"repo":"org/repo","mode":"off"}`},
		{"test", http.MethodPost, "/api/memory/destinations/test", `{"repo":"org/repo"}`},
		{"delete", http.MethodDelete, "/api/memory/destinations?repo=org/repo", ""},
	} {
		rec := doJSON(t, e, tc.method, tc.path, "carol", tc.body)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("%s as collaborator = %d, want 403: %s", tc.name, rec.Code, rec.Body.String())
		}
	}

	d, err := s.GetMemoryDestination(context.Background(), "org/repo")
	if err != nil || d.Mode != "auto" {
		t.Fatalf("destination changed by non-admin: %+v err=%v", d, err)
	}
}

func TestMemoryDeleteFeedbackCleansLink(t *testing.T) {
	mem := &fakeMemory{}
	srv := httptest.NewServer(mem.handler())
	defer srv.Close()
	h, s, e := newMemoryTestHandler(t, mem)
	connectMemory(t, e, srv.URL)

	rec := doJSON(t, e, http.MethodPost, "/feedback", "alice", `{
		"url":"https://app.example.com/","selector":"div","comment":"broken",
		"repo":"org/repo","context":{}
	}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("feedback = %d: %s", rec.Code, rec.Body.String())
	}
	var created struct {
		ID int64 `json:"id"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &created)
	h.ProcessMemoryOutbox(context.Background())
	d, _ := s.GetMemoryDestination(context.Background(), "org/repo")
	if _, err := s.GetMemoryLink(context.Background(), created.ID, d.ID); err != nil {
		t.Fatalf("initial link: %v", err)
	}

	rec = doJSON(t, e, http.MethodDelete, "/feedback/"+strconv.FormatInt(created.ID, 10), "alice", "")
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete feedback = %d: %s", rec.Code, rec.Body.String())
	}
	h.ProcessMemoryOutbox(context.Background())

	if _, err := s.GetMemoryLink(context.Background(), created.ID, d.ID); err == nil {
		t.Fatal("orphaned Memory link still present after feedback delete")
	}
}

func TestMemoryFeedbackPushAndStatusPatch(t *testing.T) {
	mem := &fakeMemory{}
	srv := httptest.NewServer(mem.handler())
	defer srv.Close()
	h, s, e := newMemoryTestHandler(t, mem)
	connectMemory(t, e, srv.URL)

	feedbackBody := `{
		"url":"https://app.example.com/dashboard",
		"selector":"button.save",
		"comment":"The save button is invisible on mobile",
		"repo":"org/repo",
		"label":"feedback",
		"context":{
			"environmentName":"staging",
			"appVersion":"1.2.3",
			"branch":"main",
			"viewport":{"width":390,"height":844},
			"type":"bug"
		}
	}`
	rec := doJSON(t, e, http.MethodPost, "/feedback", "alice", feedbackBody)
	if rec.Code != http.StatusCreated {
		t.Fatalf("feedback = %d: %s", rec.Code, rec.Body.String())
	}
	var created struct {
		ID int64 `json:"id"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &created)
	if created.ID == 0 {
		t.Fatal("no feedback id")
	}

	h.ProcessMemoryOutbox(context.Background())
	if len(mem.upserts) != 1 {
		t.Fatalf("upserts = %d, want 1", len(mem.upserts))
	}
	up := mem.upserts[0]
	if up["type"] != "Issue" {
		t.Fatalf("type = %v", up["type"])
	}
	key, _ := up["key"].(string)
	if !strings.HasPrefix(key, "ef-org-repo-") {
		t.Fatalf("key = %q", key)
	}
	props, _ := up["properties"].(map[string]any)
	if props["environment"] != "staging" || props["app_version"] != "1.2.3" || props["branch"] != "main" {
		t.Fatalf("version/environment props = %+v", props)
	}
	if props["viewport"] != "390x844" {
		t.Fatalf("viewport = %v", props["viewport"])
	}
	if props["capture_status"] != "open" || props["category"] != "bug" {
		t.Fatalf("capture/category = %+v", props)
	}

	link, err := s.GetMemoryLink(context.Background(), created.ID, mustDestID(t, s))
	if err != nil || link.CanonicalID != "canon1" {
		t.Fatalf("link = %+v err=%v", link, err)
	}

	f, _ := s.Get(context.Background(), created.ID)
	if err := s.SetStatus(context.Background(), f.ID, store.StatusResolved, "alice", ""); err != nil {
		t.Fatal(err)
	}
	h.enqueueMemoryPatch(context.Background(), f, map[string]any{"capture_status": "resolved"})
	h.ProcessMemoryOutbox(context.Background())
	if len(mem.patches) != 1 {
		t.Fatalf("patches = %d, want 1", len(mem.patches))
	}
	patchProps, _ := mem.patches[0]["properties"].(map[string]any)
	if patchProps["capture_status"] != "resolved" {
		t.Fatalf("patch = %+v", mem.patches[0])
	}
	if mem.patchIDs[0] != "/api/graph/objects/canon1" {
		t.Fatalf("patch path = %q", mem.patchIDs[0])
	}
}

func mustDestID(t *testing.T, s *store.Store) int64 {
	t.Helper()
	d, err := s.GetMemoryDestination(context.Background(), "org/repo")
	if err != nil {
		t.Fatal(err)
	}
	return d.ID
}

func TestMemoryOutboxRetries(t *testing.T) {
	mem := &fakeMemory{failUpserts: 1}
	srv := httptest.NewServer(mem.handler())
	defer srv.Close()
	h, s, e := newMemoryTestHandler(t, mem)
	connectMemory(t, e, srv.URL)

	f, err := s.Create(context.Background(), store.CreateParams{
		URL: "https://app.example.com/", Selector: "div", Comment: "broken",
		ContextJSON: `{}`, GitHubUser: "alice", Repo: "org/repo",
	})
	if err != nil {
		t.Fatal(err)
	}
	d, _ := s.GetMemoryDestination(context.Background(), "org/repo")
	if _, err := h.enqueueMemoryForFeedback(context.Background(), f, d, true); err != nil {
		t.Fatal(err)
	}
	h.ProcessMemoryOutbox(context.Background()) // fails, reschedules
	items, err := s.ListDueMemoryOutbox(context.Background(), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 0 {
		t.Fatalf("failed item still due: %+v", items)
	}
	d, _ = s.GetMemoryDestination(context.Background(), "org/repo")
	if d.LastError == "" {
		t.Fatal("destination error not recorded")
	}
}

func TestMemoryOAuthConnectFlow(t *testing.T) {
	mem := &fakeMemory{token: "emt_oauth"}
	srv := httptest.NewServer(mem.handler())
	defer srv.Close()
	_, s, e := newMemoryTestHandler(t, mem)

	rec := doJSON(t, e, http.MethodPost, "/api/memory/oauth/start", "alice", `{"repo":"org/repo","base_url":"`+srv.URL+`"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("start = %d: %s", rec.Code, rec.Body.String())
	}
	var start struct {
		AuthorizeURL string `json:"authorize_url"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &start)
	u, err := url.Parse(start.AuthorizeURL)
	if err != nil || u.Query().Get("state") == "" || u.Query().Get("code_challenge") == "" {
		t.Fatalf("bad authorize url %q: %v", start.AuthorizeURL, err)
	}
	if u.Query().Get("client_id") != "client-1" {
		t.Fatalf("client_id = %q", u.Query().Get("client_id"))
	}
	state := u.Query().Get("state")

	rec = doJSON(t, e, http.MethodGet, "/oauth/memory/callback?code=abc&state="+url.QueryEscape(state), "", "")
	if rec.Code != http.StatusFound {
		t.Fatalf("callback = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Header().Get("Location"), "connected=org%2Frepo") {
		t.Fatalf("redirect = %q", rec.Header().Get("Location"))
	}
	d, err := s.GetMemoryDestination(context.Background(), "org/repo")
	if err != nil {
		t.Fatalf("destination: %v", err)
	}
	if d.ClientID != "client-1" || d.ProjectID != "p1" || d.CreatedBy != "alice" {
		t.Fatalf("destination = %+v", d)
	}
	if mem.lastForm.Get("code_verifier") == "" || mem.lastForm.Get("code") != "abc" {
		t.Fatalf("token form = %v", mem.lastForm)
	}

	// State is single-use.
	rec = doJSON(t, e, http.MethodGet, "/oauth/memory/callback?code=abc&state="+url.QueryEscape(state), "", "")
	if rec.Code != http.StatusFound || !strings.Contains(rec.Header().Get("Location"), "memory_error=") {
		t.Fatalf("replay callback = %d %q", rec.Code, rec.Header().Get("Location"))
	}
}

func TestMemoryEndpointRejectsNonHTTPMetadata(t *testing.T) {
	meta := memory.Metadata{AuthorizationEndpoint: "javascript:alert(1)"}
	if got := memoryEndpoint(meta, "authorize", "https://api.memory.example", "/oauth/authorize"); got != "https://api.memory.example/oauth/authorize" {
		t.Fatalf("authorize endpoint = %q", got)
	}
	meta.AuthorizationEndpoint = "https://app.memory.example/oauth/authorize"
	if got := memoryEndpoint(meta, "authorize", "https://api.memory.example", "/oauth/authorize"); got != meta.AuthorizationEndpoint {
		t.Fatalf("authorize endpoint = %q", got)
	}
}

func TestMemoryStatusUnknownRepo(t *testing.T) {
	mem := &fakeMemory{}
	srv := httptest.NewServer(mem.handler())
	defer srv.Close()
	_, _, e := newMemoryTestHandler(t, mem)
	rec := doJSON(t, e, http.MethodGet, "/api/memory/status?repo=org/repo", "", "")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"connected":false`) {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
}

// Ensure the outbox payload is valid JSON for a patch (guards against a
// future refactor accidentally storing a raw string).
func TestMemoryPatchPayloadIsJSON(t *testing.T) {
	mem := &fakeMemory{}
	srv := httptest.NewServer(mem.handler())
	defer srv.Close()
	h, s, e := newMemoryTestHandler(t, mem)
	connectMemory(t, e, srv.URL)
	f, _ := s.Create(context.Background(), store.CreateParams{
		URL: "https://app/", Selector: "x", Comment: "y", ContextJSON: `{}`, GitHubUser: "alice", Repo: "org/repo",
	})
	d, _ := s.GetMemoryDestination(context.Background(), "org/repo")
	if err := s.UpsertMemoryLink(context.Background(), store.MemoryLink{FeedbackID: f.ID, DestinationID: d.ID, ObjectKey: "ef-x", CanonicalID: "canon1"}); err != nil {
		t.Fatal(err)
	}
	h.enqueueMemoryPatch(context.Background(), f, map[string]any{"capture_status": "dismissed"})
	h.ProcessMemoryOutbox(context.Background())
	if len(mem.patches) != 1 {
		t.Fatalf("patches = %d", len(mem.patches))
	}
	if mem.patches[0]["properties"] == nil {
		t.Fatalf("patch body = %+v", mem.patches[0])
	}
}

func TestMemoryOutboxRetryPatchesAfterLink(t *testing.T) {
	mem := &fakeMemory{}
	srv := httptest.NewServer(mem.handler())
	defer srv.Close()
	h, s, e := newMemoryTestHandler(t, mem)
	connectMemory(t, e, srv.URL)

	f, err := s.Create(context.Background(), store.CreateParams{
		URL: "https://app.example.com/", Selector: "div", Comment: "broken",
		ContextJSON: `{"environmentName":"production"}`, GitHubUser: "alice", Repo: "org/repo",
	})
	if err != nil {
		t.Fatal(err)
	}
	d, _ := s.GetMemoryDestination(context.Background(), "org/repo")
	if _, err := h.enqueueMemoryForFeedback(context.Background(), f, d, true); err != nil {
		t.Fatal(err)
	}
	h.ProcessMemoryOutbox(context.Background())
	if len(mem.upserts) != 1 || len(mem.patches) != 0 {
		t.Fatalf("first sync: upserts=%d patches=%d", len(mem.upserts), len(mem.patches))
	}

	// A retried create must patch the capture-owned fields, not replace the
	// object and wipe the triage agent's classification.
	if _, err := h.enqueueMemoryForFeedback(context.Background(), f, d, true); err != nil {
		t.Fatal(err)
	}
	h.ProcessMemoryOutbox(context.Background())
	if len(mem.upserts) != 1 {
		t.Fatalf("retry upserted again: %d", len(mem.upserts))
	}
	if len(mem.patches) != 1 {
		t.Fatalf("retry patches = %d, want 1", len(mem.patches))
	}
	props, _ := mem.patches[0]["properties"].(map[string]any)
	if props["capture_status"] != "open" || props["environment"] != "production" {
		t.Fatalf("capture props = %+v", props)
	}
	for _, k := range []string{"severity", "category", "confidence", "triage_notes", "group_key"} {
		if _, ok := props[k]; ok {
			t.Fatalf("retry patch leaked triage-owned %q: %+v", k, props)
		}
	}
}
