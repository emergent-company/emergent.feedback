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
	"testing"

	"github.com/emergent-company/emergent.feedback/server/github"
	"github.com/emergent-company/emergent.feedback/server/middleware"
	"github.com/emergent-company/emergent.feedback/server/store"
	"github.com/labstack/echo/v4"
)

func newLifecycleHandler(t *testing.T) (*Handler, *store.Store, *echo.Echo) {
	t.Helper()
	s, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	h := New(s, &github.AppConfig{}, "secret")

	e := echo.New()
	// Test auth: the login is taken from the X-Test-Login header.
	e.Use(func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			c.Set(middleware.UserLoginKey, c.Request().Header.Get("X-Test-Login"))
			return next(c)
		}
	})
	e.POST("/feedback/:id/applied", h.HandleMarkApplied)
	e.POST("/feedback/:id/resolve", h.HandleResolve)
	e.POST("/feedback/:id/verify-result", h.HandleVerifyResult)
	e.GET("/feedback/:id/verify", h.HandleGetVerify)
	e.GET("/feedback/verify-pending", h.HandleVerifyPending)
	return h, s, e
}

func TestLifecycleEndpoints(t *testing.T) {
	_, s, e := newLifecycleHandler(t)
	ctx := context.Background()

	f, err := s.Create(ctx, store.CreateParams{
		URL:         "https://app.example.com/dashboard",
		Selector:    "button.foo",
		Comment:     "broken",
		ContextJSON: `{"verification":{"contract":{"kind":"style_assertion","check":{"selector":"button.foo","prop":"color"}},"criteria":"readable"}}`,
		GitHubUser:  "alice",
		Repo:        "owner/repo",
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	do := func(method, path, body, login string) *httptest.ResponseRecorder {
		var req *http.Request
		if body != "" {
			req = httptest.NewRequest(method, path, strings.NewReader(body))
		} else {
			req = httptest.NewRequest(method, path, nil)
		}
		req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
		if login != "" {
			req.Header.Set("X-Test-Login", login)
		}
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)
		return rec
	}

	idStr := strconv.FormatInt(f.ID, 10)

	// applied
	rec := do(http.MethodPost, "/feedback/"+idStr+"/applied", `{"summary":"changed color"}`, "alice")
	if rec.Code != http.StatusOK {
		t.Fatalf("applied status = %d: %s", rec.Code, rec.Body.String())
	}

	// verify-result green
	rec = do(http.MethodPost, "/feedback/"+idStr+"/verify-result", `{"result":"green","detail":"passed"}`, "alice")
	if rec.Code != http.StatusOK {
		t.Fatalf("verify-result status = %d: %s", rec.Code, rec.Body.String())
	}

	// GET verify
	rec = do(http.MethodGet, "/feedback/"+idStr+"/verify", "", "alice")
	if rec.Code != http.StatusOK {
		t.Fatalf("verify status = %d: %s", rec.Code, rec.Body.String())
	}
	var v struct {
		Status     string         `json:"status"`
		LastResult string         `json:"last_result"`
		Contract   map[string]any `json:"contract"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &v); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if v.Status != "verified" {
		t.Fatalf("status = %q, want verified", v.Status)
	}
	if v.LastResult != "green" {
		t.Fatalf("last_result = %q, want green", v.LastResult)
	}
	if v.Contract["kind"] != "style_assertion" {
		t.Fatalf("contract = %v", v.Contract)
	}

	// resolve
	rec = do(http.MethodPost, "/feedback/"+idStr+"/resolve", `{"summary":"done"}`, "alice")
	if rec.Code != http.StatusOK {
		t.Fatalf("resolve status = %d: %s", rec.Code, rec.Body.String())
	}

	// invalid result rejected
	rec = do(http.MethodPost, "/feedback/"+idStr+"/verify-result", `{"result":"purple"}`, "alice")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid result status = %d, want 400", rec.Code)
	}
}

func TestLifecycleOwnership(t *testing.T) {
	_, s, e := newLifecycleHandler(t)
	ctx := context.Background()

	f, err := s.Create(ctx, store.CreateParams{
		URL:        "https://app.example.com/",
		Selector:   "button",
		Comment:    "x",
		GitHubUser: "alice",
		Repo:       "owner/repo",
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/feedback/"+strconv.FormatInt(f.ID, 10)+"/applied", strings.NewReader(`{}`))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	req.Header.Set("X-Test-Login", "bob")
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("ownership status = %d, want 403", rec.Code)
	}
}

func TestVerifyPending(t *testing.T) {
	_, s, e := newLifecycleHandler(t)
	ctx := context.Background()

	f, err := s.Create(ctx, store.CreateParams{
		URL:         "https://app.example.com/dashboard",
		Selector:    "button.foo",
		Comment:     "broken",
		ContextJSON: `{"verification":{"contract":{"kind":"style_assertion","check":{"selector":"button.foo","prop":"color"}}}}`,
		GitHubUser:  "alice",
		Repo:        "owner/repo",
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/feedback/verify-pending?url="+url.QueryEscape("https://app.example.com/dashboard"), nil)
	req.Header.Set("X-Test-Login", "alice")
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var items []struct {
		ID       int64          `json:"id"`
		Selector string         `json:"selector"`
		Contract map[string]any `json:"contract"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &items); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("items = %d, want 1", len(items))
	}
	if items[0].ID != f.ID || items[0].Selector != "button.foo" {
		t.Fatalf("item = %v", items[0])
	}
	if items[0].Contract["kind"] != "style_assertion" {
		t.Fatalf("contract = %v", items[0].Contract)
	}
}
