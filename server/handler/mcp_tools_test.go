package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/emergent-company/emergent.feedback/server/github"
	"github.com/emergent-company/emergent.feedback/server/store"
	mcpauth "github.com/modelcontextprotocol/go-sdk/auth"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// newHandlerStore builds a Handler backed by a temp-store.
func newHandlerStore(t *testing.T) (*Handler, *store.Store) {
	t.Helper()
	s, err := store.OpenSQLite(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return New(s, &github.AppConfig{}, "secret"), s
}

// withMCPAuth wraps h in the bearer-token middleware so a TokenInfo lands in the
// request context (there is no public context setter for auth.TokenInfo).
func withMCPAuth(t *testing.T, scopes []string, userID string, h http.HandlerFunc) {
	t.Helper()
	verifier := func(_ context.Context, _ string, _ *http.Request) (*mcpauth.TokenInfo, error) {
		return &mcpauth.TokenInfo{Scopes: scopes, UserID: userID}, nil
	}
	mw := mcpauth.RequireBearerToken(verifier, &mcpauth.RequireBearerTokenOptions{AllowMissingExpiration: true})
	req := httptest.NewRequest(http.MethodPost, "/", nil)
	req.Header.Set("Authorization", "Bearer test")
	rec := httptest.NewRecorder()
	mw(h).ServeHTTP(rec, req)
}

func callFeedbackList(t *testing.T, h *Handler, scopes []string, in feedbackListInput) (feedbackListOutput, error) {
	t.Helper()
	var out feedbackListOutput
	var callErr error
	withMCPAuth(t, scopes, "test-key", func(w http.ResponseWriter, r *http.Request) {
		_, out, callErr = h.toolFeedbackList(r.Context(), nil, in)
	})
	return out, callErr
}

func callMarkApplied(t *testing.T, h *Handler, scopes []string, in markInput) (markOutput, error) {
	t.Helper()
	var out markOutput
	var callErr error
	withMCPAuth(t, scopes, "test-key", func(w http.ResponseWriter, r *http.Request) {
		_, out, callErr = h.toolMarkApplied(r.Context(), nil, in)
	})
	return out, callErr
}

func TestActorFromTokenInfo(t *testing.T) {
	if got := actorFromTokenInfo(nil); got != "mcp" {
		t.Fatalf("nil actor = %q, want mcp", got)
	}
	if got := actorFromTokenInfo(&mcpauth.TokenInfo{}); got != "mcp" {
		t.Fatalf("empty actor = %q, want mcp", got)
	}
	if got := actorFromTokenInfo(&mcpauth.TokenInfo{UserID: "api-key:abcd1234"}); got != "api-key:abcd1234" {
		t.Fatalf("userid actor = %q, want api-key:abcd1234", got)
	}
}

func TestFeedbackListAllStatusesByDefault(t *testing.T) {
	h, s := newHandlerStore(t)
	ctx := context.Background()

	openF, err := s.Create(ctx, store.CreateParams{URL: "https://app.example.com/", Selector: "button", Comment: "open", GitHubUser: "alice", Repo: "org/repo"})
	if err != nil {
		t.Fatalf("Create open: %v", err)
	}
	appliedF, err := s.Create(ctx, store.CreateParams{URL: "https://app.example.com/", Selector: "button", Comment: "applied", GitHubUser: "alice", Repo: "org/repo"})
	if err != nil {
		t.Fatalf("Create applied: %v", err)
	}
	if err := s.SetStatus(ctx, appliedF.ID, store.StatusApplied, "alice", ""); err != nil {
		t.Fatalf("SetStatus applied: %v", err)
	}
	exportedF, err := s.Create(ctx, store.CreateParams{URL: "https://app.example.com/", Selector: "button", Comment: "exported", GitHubUser: "alice", Repo: "org/repo"})
	if err != nil {
		t.Fatalf("Create exported: %v", err)
	}
	if err := s.MarkExported(ctx, []int64{exportedF.ID}, "https://github.com/org/repo/issues/1"); err != nil {
		t.Fatalf("MarkExported: %v", err)
	}

	out, err := callFeedbackList(t, h, []string{"org/repo"}, feedbackListInput{})
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Feedback) != 3 {
		t.Fatalf("items = %d, want 3: %v", len(out.Feedback), out)
	}
	ids := map[int64]bool{}
	for _, it := range out.Feedback {
		ids[it.ID] = true
	}
	for _, want := range []int64{openF.ID, appliedF.ID, exportedF.ID} {
		if !ids[want] {
			t.Fatalf("id %d missing from %v", want, out)
		}
	}
}

func TestFeedbackListStatusFilter(t *testing.T) {
	h, s := newHandlerStore(t)
	ctx := context.Background()

	if _, err := s.Create(ctx, store.CreateParams{URL: "https://app.example.com/", Selector: "button", Comment: "open", GitHubUser: "alice", Repo: "org/repo"}); err != nil {
		t.Fatalf("Create open: %v", err)
	}
	appliedF, err := s.Create(ctx, store.CreateParams{URL: "https://app.example.com/", Selector: "button", Comment: "applied", GitHubUser: "alice", Repo: "org/repo"})
	if err != nil {
		t.Fatalf("Create applied: %v", err)
	}
	if err := s.SetStatus(ctx, appliedF.ID, store.StatusApplied, "alice", ""); err != nil {
		t.Fatalf("SetStatus applied: %v", err)
	}

	out, err := callFeedbackList(t, h, []string{"org/repo"}, feedbackListInput{Status: "applied"})
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Feedback) != 1 || out.Feedback[0].ID != appliedF.ID {
		t.Fatalf("status filter items = %v, want only applied id %d", out.Feedback, appliedF.ID)
	}
}

func TestFeedbackListSinceIncludesUnparseableTimestamp(t *testing.T) {
	h, s := newHandlerStore(t)
	ctx := context.Background()

	f, err := s.Create(ctx, store.CreateParams{URL: "https://app.example.com/", Selector: "button", Comment: "broken", GitHubUser: "alice", Repo: "org/repo"})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if _, err := s.DB().ExecContext(ctx, `UPDATE feedback SET created_at = 'not-a-time' WHERE id = ?`, f.ID); err != nil {
		t.Fatalf("corrupt created_at: %v", err)
	}

	out, err := callFeedbackList(t, h, []string{"org/repo"}, feedbackListInput{Since: time.Now().Add(time.Hour).Format(time.RFC3339)})
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Feedback) != 1 || out.Feedback[0].ID != f.ID {
		t.Fatalf("unparseable-timestamp item dropped by since filter: %v", out.Feedback)
	}
}

func TestFeedbackListSinceDropsOldItems(t *testing.T) {
	h, s := newHandlerStore(t)
	ctx := context.Background()

	if _, err := s.Create(ctx, store.CreateParams{URL: "https://app.example.com/", Selector: "button", Comment: "broken", GitHubUser: "alice", Repo: "org/repo"}); err != nil {
		t.Fatalf("Create: %v", err)
	}

	out, err := callFeedbackList(t, h, []string{"org/repo"}, feedbackListInput{Since: time.Now().Add(time.Hour).Format(time.RFC3339)})
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Feedback) != 0 {
		t.Fatalf("expected 0 items for far-future since, got %d", len(out.Feedback))
	}
}

func callToolGetContext(t *testing.T, h *Handler, scopes []string, in feedbackIDInput) (contextOutput, error) {
	t.Helper()
	var out contextOutput
	var callErr error
	withMCPAuth(t, scopes, "test-key", func(w http.ResponseWriter, r *http.Request) {
		_, out, callErr = h.toolGetContext(r.Context(), nil, in)
	})
	return out, callErr
}

func TestToolGetContextRedactsSecrets(t *testing.T) {
	h, s := newHandlerStore(t)
	ctx := context.Background()

	ctxJSON := `{"url":"https://app.example.com/confirm?token=eyJhbGciOiJIUzI1NiJ9.abc.def","intent":{"expected":"text color: sk-abcdefghijklmnop"}}`
	f, err := s.Create(ctx, store.CreateParams{
		URL:         "https://app.example.com/confirm?token=eyJhbGciOiJIUzI1NiJ9.abc.def",
		Selector:    "button",
		Comment:     "broken",
		ContextJSON: ctxJSON,
		GitHubUser:  "alice",
		Repo:        "org/repo",
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	out, err := callToolGetContext(t, h, []string{"org/repo"}, feedbackIDInput{FeedbackID: f.ID})
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(out.Context)
	got := string(b)
	if strings.Contains(got, "eyJhbGci") {
		t.Fatalf("url token leaked into feedback_get_context: %s", got)
	}
	if strings.Contains(got, "sk-abcdefghijklmnop") {
		t.Fatalf("intent secret leaked into feedback_get_context: %s", got)
	}
	if !strings.Contains(got, "[redacted]") {
		t.Fatalf("expected redacted marker in feedback_get_context: %s", got)
	}
}

func TestMCPMarkAppliedRecordsActor(t *testing.T) {
	h, s := newHandlerStore(t)
	ctx := context.Background()

	f, err := s.Create(ctx, store.CreateParams{URL: "https://app.example.com/", Selector: "button", Comment: "broken", GitHubUser: "alice", Repo: "org/repo"})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	if _, err := callMarkApplied(t, h, []string{"org/repo"}, markInput{FeedbackID: f.ID}); err != nil {
		t.Fatalf("mark applied: %v", err)
	}

	events, err := s.ListEventsSince(ctx, 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	var actor string
	for _, e := range events {
		if e.Type == "applied" {
			actor = e.Actor
		}
	}
	if actor != "test-key" {
		t.Fatalf("applied event actor = %q, want test-key", actor)
	}
}

// TestMCPServerOutputSchemasAreObjects guards a client-side requirement: MCP
// clients such as OpenCode reject a tools/list result whose outputSchema is not
// an object. Every advertised tool must declare either no schema or an object
// schema (see feedbackListOutput).
func TestMCPServerOutputSchemasAreObjects(t *testing.T) {
	h, _ := newHandlerStore(t)
	ctx := context.Background()

	cts, sts := mcp.NewInMemoryTransports()
	ss, err := h.MCPServer().Connect(ctx, sts, nil)
	if err != nil {
		t.Fatalf("server connect: %v", err)
	}
	defer ss.Close()

	cs, err := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "1.0.0"}, nil).Connect(ctx, cts, nil)
	if err != nil {
		t.Fatalf("client connect: %v", err)
	}
	defer cs.Close()

	res, err := cs.ListTools(ctx, nil)
	if err != nil {
		t.Fatalf("list tools: %v", err)
	}
	if len(res.Tools) == 0 {
		t.Fatal("no tools advertised")
	}
	for _, tool := range res.Tools {
		if tool.OutputSchema == nil {
			continue
		}
		raw, err := json.Marshal(tool.OutputSchema)
		if err != nil {
			t.Fatalf("%s: marshal output schema: %v", tool.Name, err)
		}
		var schema struct {
			Type any `json:"type"`
		}
		if err := json.Unmarshal(raw, &schema); err != nil {
			t.Fatalf("%s: parse output schema: %v", tool.Name, err)
		}
		if schema.Type != "object" {
			t.Errorf("%s: outputSchema.type = %v, want \"object\"", tool.Name, schema.Type)
		}
	}
}
