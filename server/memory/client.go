// Package memory is a small client for the emergent.memory graph API. It only
// implements the calls the feedback destination needs: project discovery,
// idempotent issue upserts, and property patches.
package memory

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// Client talks to one Memory project using a project-scoped emt_ token.
type Client struct {
	BaseURL string
	Token   string
	HTTP    *http.Client
}

// New returns a client with a sane default timeout.
func New(baseURL, token string) *Client {
	return NewWithHTTP(baseURL, token, nil)
}

// NewWithHTTP builds a client using httpClient when supplied. A nil client is
// still SSRF-guarded; callers that need loopback (tests) pass
// SafeHTTPClient(true). The handler passes its shared guarded client so
// user-supplied base URLs cannot reach private network addresses.
func NewWithHTTP(baseURL, token string, httpClient *http.Client) *Client {
	if httpClient == nil {
		httpClient = SafeHTTPClient(false)
	}
	return &Client{
		BaseURL: strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		Token:   strings.TrimSpace(token),
		HTTP:    httpClient,
	}
}

// APIError is a non-2xx response from Memory.
type APIError struct {
	Status  int
	Message string
	Body    string
}

func (e *APIError) Error() string {
	if e.Message != "" {
		return fmt.Sprintf("memory %d: %s", e.Status, e.Message)
	}
	return fmt.Sprintf("memory %d", e.Status)
}

// Project is the subset of GET /api/projects the feedback app needs.
type Project struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Object is the subset of a graph object response the feedback app needs.
type Object struct {
	ID          string `json:"id"`
	CanonicalID string `json:"canonical_id"`
	Type        string `json:"type"`
	Key         string `json:"key"`
}

// UpsertRequest is the body for PUT /api/graph/objects/upsert.
type UpsertRequest struct {
	Type       string         `json:"type"`
	Key        string         `json:"key"`
	Status     string         `json:"status,omitempty"`
	Properties map[string]any `json:"properties,omitempty"`
	Labels     []string       `json:"labels,omitempty"`
}

// ListProjects returns the projects the token can access. A project-scoped
// token normally returns exactly one.
func (c *Client) ListProjects(ctx context.Context) ([]Project, error) {
	var out []Project
	if err := c.do(ctx, http.MethodGet, "/api/projects", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// UpsertIssue creates or replaces an Issue object by (type, key).
func (c *Client) UpsertIssue(ctx context.Context, projectID string, req UpsertRequest) (Object, error) {
	var out Object
	if err := c.doProject(ctx, http.MethodPut, "/api/graph/objects/upsert", projectID, req, &out); err != nil {
		return Object{}, err
	}
	return out, nil
}

// PatchObject merges properties into an existing object. Unlike upsert, patch
// preserves properties written by other actors (e.g. the triage agent).
func (c *Client) PatchObject(ctx context.Context, projectID, objectID string, props map[string]any) (Object, error) {
	body := map[string]any{"properties": props}
	var out Object
	path := "/api/graph/objects/" + objectID
	if err := c.doProject(ctx, http.MethodPatch, path, projectID, body, &out); err != nil {
		return Object{}, err
	}
	return out, nil
}

// AskRequest is the body for POST /api/projects/:id/ask.
type AskRequest struct {
	Message string `json:"message"`
}

// AskStream starts one agent turn and returns the raw SSE body. The caller
// owns the reader and must close it.
//
// Unlike doWithHeaders this does not buffer or decode: the overlay forwards the
// tokens to the browser as they arrive. The shared HTTP client carries a 15s
// timeout for request/response calls, so streaming uses a copy with no overall
// deadline and the same guarded transport.
func (c *Client) AskStream(ctx context.Context, projectID, message string) (io.ReadCloser, error) {
	if projectID == "" {
		return nil, fmt.Errorf("memory: project id is required")
	}
	if c.BaseURL == "" {
		return nil, fmt.Errorf("memory: base url is required")
	}
	if c.Token == "" {
		return nil, fmt.Errorf("memory: token is required")
	}
	body, err := json.Marshal(AskRequest{Message: message})
	if err != nil {
		return nil, fmt.Errorf("memory: encode request: %w", err)
	}

	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		c.BaseURL+"/api/projects/"+url.PathEscape(projectID)+"/ask",
		bytes.NewReader(body),
	)
	if err != nil {
		return nil, fmt.Errorf("memory: build request: %w", err)
	}
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.Token)

	stream := *c.HTTP
	stream.Timeout = 0

	res, err := stream.Do(req)
	if err != nil {
		return nil, fmt.Errorf("memory: request failed: %w", err)
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(res.Body, 8<<10))
		_ = res.Body.Close()
		apiErr := &APIError{Status: res.StatusCode, Body: string(raw)}
		var parsed struct {
			Message string `json:"message"`
			Error   string `json:"error"`
		}
		if json.Unmarshal(raw, &parsed) == nil {
			if parsed.Message != "" {
				apiErr.Message = parsed.Message
			} else {
				apiErr.Message = parsed.Error
			}
		}
		return nil, apiErr
	}
	return res.Body, nil
}

func (c *Client) doProject(ctx context.Context, method, path, projectID string, body, out any) error {
	if projectID == "" {
		return fmt.Errorf("memory: project id is required")
	}
	return c.doWithHeaders(ctx, method, path, body, out, map[string]string{"X-Project-ID": projectID})
}

func (c *Client) do(ctx context.Context, method, path string, body, out any) error {
	return c.doWithHeaders(ctx, method, path, body, out, nil)
}

func (c *Client) doWithHeaders(ctx context.Context, method, path string, body, out any, headers map[string]string) error {
	if c.BaseURL == "" {
		return fmt.Errorf("memory: base url is required")
	}
	if c.Token == "" {
		return fmt.Errorf("memory: token is required")
	}

	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("memory: encode request: %w", err)
		}
		rdr = bytes.NewReader(b)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, rdr)
	if err != nil {
		return fmt.Errorf("memory: build request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.Token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}

	res, err := c.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("memory: request failed: %w", err)
	}
	defer func() { _ = res.Body.Close() }()

	raw, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		apiErr := &APIError{Status: res.StatusCode, Body: string(raw)}
		var parsed struct {
			Message string `json:"message"`
			Error   string `json:"error"`
		}
		if json.Unmarshal(raw, &parsed) == nil {
			if parsed.Message != "" {
				apiErr.Message = parsed.Message
			} else {
				apiErr.Message = parsed.Error
			}
		}
		return apiErr
	}
	if out != nil && len(raw) > 0 {
		if err := json.Unmarshal(raw, out); err != nil {
			return fmt.Errorf("memory: decode response: %w", err)
		}
	}
	return nil
}
