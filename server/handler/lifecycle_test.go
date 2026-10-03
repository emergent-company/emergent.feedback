package handler

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
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
	s, err := store.OpenSQLite(filepath.Join(t.TempDir(), "test.db"))
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
	e.POST("/feedback", h.HandleCreateFeedback)
	e.POST("/feedback/:id/applied", h.HandleMarkApplied)
	e.POST("/feedback/:id/resolve", h.HandleResolve)
	e.POST("/feedback/:id/verify-result", h.HandleVerifyResult)
	e.GET("/feedback/:id/verify", h.HandleGetVerify)
	e.GET("/feedback/:id/replay", h.HandleGetReplay)
	e.GET("/feedback/verify-pending", h.HandleVerifyPending)
	e.GET("/feedback/status", h.HandleFeedbackStatus)
	return h, s, e
}

func gzipBase64(t *testing.T, s string) string {
	t.Helper()
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	if _, err := gw.Write([]byte(s)); err != nil {
		t.Fatalf("gzip write: %v", err)
	}
	if err := gw.Close(); err != nil {
		t.Fatalf("gzip close: %v", err)
	}
	return base64.StdEncoding.EncodeToString(buf.Bytes())
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

func TestReplayCreateAndGet(t *testing.T) {
	_, s, e := newLifecycleHandler(t)
	ctx := context.Background()

	events := `[{"type":2,"data":{"x":1}},{"type":3,"data":{"y":2}}]`
	body := `{"url":"https://app.example.com/","selector":"button","comment":"broken","repo":"owner/repo","replay":"` + gzipBase64(t, events) + `"}`
	req := httptest.NewRequest(http.MethodPost, "/feedback", strings.NewReader(body))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	req.Header.Set("X-Test-Login", "alice")
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create status = %d: %s", rec.Code, rec.Body.String())
	}
	var out struct {
		ID int64 `json:"id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode create: %v", err)
	}

	// Stored blob is non-empty.
	f, err := s.Get(ctx, out.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(f.Replay) == 0 {
		t.Fatal("replay not stored")
	}

	// GET replay returns the decompressed events JSON.
	req2 := httptest.NewRequest(http.MethodGet, "/feedback/"+strconv.FormatInt(out.ID, 10)+"/replay", nil)
	req2.Header.Set("X-Test-Login", "alice")
	rec2 := httptest.NewRecorder()
	e.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusOK {
		t.Fatalf("get replay status = %d: %s", rec2.Code, rec2.Body.String())
	}
	var eventsOut []map[string]any
	if err := json.Unmarshal(rec2.Body.Bytes(), &eventsOut); err != nil {
		t.Fatalf("decode replay: %v", err)
	}
	if len(eventsOut) != 2 {
		t.Fatalf("events = %d, want 2", len(eventsOut))
	}
}

func TestReplayGetCorruptReturns500(t *testing.T) {
	_, _, e := newLifecycleHandler(t)

	// Build a valid gzip blob, then truncate its trailer so the header is valid
	// but the body is corrupt.
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	if _, err := gw.Write([]byte(`[{"type":2}]`)); err != nil {
		t.Fatalf("gzip write: %v", err)
	}
	if err := gw.Close(); err != nil {
		t.Fatalf("gzip close: %v", err)
	}
	corrupt := buf.Bytes()
	corrupt = corrupt[:len(corrupt)-8]

	body := `{"url":"https://app.example.com/","selector":"button","comment":"broken","repo":"owner/repo","replay":"` + base64.StdEncoding.EncodeToString(corrupt) + `"}`
	req := httptest.NewRequest(http.MethodPost, "/feedback", strings.NewReader(body))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	req.Header.Set("X-Test-Login", "alice")
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create status = %d: %s", rec.Code, rec.Body.String())
	}
	var out struct {
		ID int64 `json:"id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode create: %v", err)
	}

	req2 := httptest.NewRequest(http.MethodGet, "/feedback/"+strconv.FormatInt(out.ID, 10)+"/replay", nil)
	req2.Header.Set("X-Test-Login", "alice")
	rec2 := httptest.NewRecorder()
	e.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusInternalServerError {
		t.Fatalf("get corrupt replay status = %d, want 500: %s", rec2.Code, rec2.Body.String())
	}
}

func TestReplayRejectOversize(t *testing.T) {
	_, _, e := newLifecycleHandler(t)

	big := base64.StdEncoding.EncodeToString(make([]byte, maxReplayBytes+1))
	body := `{"url":"https://app.example.com/","selector":"button","comment":"broken","repo":"owner/repo","replay":"` + big + `"}`
	req := httptest.NewRequest(http.MethodPost, "/feedback", strings.NewReader(body))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	req.Header.Set("X-Test-Login", "alice")
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", rec.Code)
	}
}
