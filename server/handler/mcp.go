package handler

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"

	"github.com/emergent-company/emergent.feedback/server/store"
	"github.com/modelcontextprotocol/go-sdk/auth"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// MCPServer builds the MCP server with all feedback tools registered.
func (h *Handler) MCPServer() *mcp.Server {
	srv := mcp.NewServer(&mcp.Implementation{Name: "emergent-feedback", Version: "1.0.0"}, nil)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "feedback_get_snapshot",
		Description: "Return the redacted full-page DOM snapshot for a feedback item; requires API-key authentication and repo scope.",
	}, h.toolGetSnapshot)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "feedback_get_screenshot",
		Description: "Return the element screenshot (base64 PNG) for a feedback item; requires API-key authentication and repo scope.",
	}, h.toolGetScreenshot)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "feedback_get_context",
		Description: "Return the captured context JSON for a feedback item; requires API-key authentication and repo scope.",
	}, h.toolGetContext)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "feedback_list_for_issue",
		Description: "Resolve a GitHub issue number to the feedback items it was exported from.",
	}, h.toolListForIssue)

	return srv
}

// scopedFeedback loads a feedback item and verifies it is exported and within
// the caller's API-key repo scope.
func (h *Handler) scopedFeedback(ctx context.Context, id int64) (store.Feedback, error) {
	f, err := h.Store.Get(ctx, id)
	if err != nil {
		return store.Feedback{}, fmt.Errorf("feedback %d not found", id)
	}
	if f.IssueURL == "" {
		return store.Feedback{}, fmt.Errorf("feedback %d not exported", id)
	}
	ti := auth.TokenInfoFromContext(ctx)
	if ti == nil {
		return store.Feedback{}, fmt.Errorf("unauthenticated")
	}
	if !repoInScope(f.Repo, ti.Scopes) {
		return store.Feedback{}, fmt.Errorf("repo %s not in key scope", f.Repo)
	}
	return f, nil
}

// repoInScope reports whether a repo is covered by a key's scope.
func repoInScope(repo string, scopes []string) bool {
	for _, s := range scopes {
		if s == repo || s == "*" {
			return true
		}
	}
	return false
}

// feedbackIDInput is the input for feedback-scoped tools.
type feedbackIDInput struct {
	FeedbackID int64 `json:"feedback_id" jsonschema:"the feedback row id"`
}

type snapshotOutput struct {
	HTML string `json:"html"`
}

func (h *Handler) toolGetSnapshot(ctx context.Context, _ *mcp.CallToolRequest, in feedbackIDInput) (*mcp.CallToolResult, snapshotOutput, error) {
	f, err := h.scopedFeedback(ctx, in.FeedbackID)
	if err != nil {
		return nil, snapshotOutput{}, err
	}
	if len(f.Snapshot) == 0 {
		return nil, snapshotOutput{}, fmt.Errorf("no snapshot for feedback %d", in.FeedbackID)
	}
	data, err := decodeSnapshot(f.Snapshot)
	if err != nil {
		return nil, snapshotOutput{}, err
	}
	return nil, snapshotOutput{HTML: string(data)}, nil
}

type screenshotOutput struct {
	Image     string `json:"image_base64"`
	MediaType string `json:"media_type"`
}

func (h *Handler) toolGetScreenshot(ctx context.Context, _ *mcp.CallToolRequest, in feedbackIDInput) (*mcp.CallToolResult, screenshotOutput, error) {
	f, err := h.scopedFeedback(ctx, in.FeedbackID)
	if err != nil {
		return nil, screenshotOutput{}, err
	}
	if len(f.Screenshot) == 0 {
		return nil, screenshotOutput{}, fmt.Errorf("no screenshot for feedback %d", in.FeedbackID)
	}
	return nil, screenshotOutput{
		Image:     base64.StdEncoding.EncodeToString(f.Screenshot),
		MediaType: "image/png",
	}, nil
}

type contextOutput struct {
	Context map[string]any `json:"context"`
}

func (h *Handler) toolGetContext(ctx context.Context, _ *mcp.CallToolRequest, in feedbackIDInput) (*mcp.CallToolResult, contextOutput, error) {
	f, err := h.scopedFeedback(ctx, in.FeedbackID)
	if err != nil {
		return nil, contextOutput{}, err
	}
	var m map[string]any
	if f.ContextJSON != "" && f.ContextJSON != "{}" {
		if err := json.Unmarshal([]byte(f.ContextJSON), &m); err != nil {
			return nil, contextOutput{}, fmt.Errorf("corrupt context for feedback %d", in.FeedbackID)
		}
	}
	return nil, contextOutput{Context: m}, nil
}

type issueInput struct {
	IssueNumber int64 `json:"issue_number" jsonschema:"the GitHub issue number"`
}

type feedbackRef struct {
	ID            int64  `json:"id"`
	Selector      string `json:"selector"`
	URL           string `json:"url"`
	Comment       string `json:"comment"`
	HasScreenshot bool   `json:"has_screenshot"`
	HasSnapshot   bool   `json:"has_snapshot"`
}

type listForIssueOutput struct {
	IssueNumber int64         `json:"issue_number"`
	Feedback    []feedbackRef `json:"feedback"`
}

func (h *Handler) toolListForIssue(ctx context.Context, _ *mcp.CallToolRequest, in issueInput) (*mcp.CallToolResult, listForIssueOutput, error) {
	ti := auth.TokenInfoFromContext(ctx)
	if ti == nil {
		return nil, listForIssueOutput{}, fmt.Errorf("unauthenticated")
	}
	gi, err := h.Store.GetGitHubIssueByNumber(ctx, in.IssueNumber)
	if err != nil {
		return nil, listForIssueOutput{}, err
	}
	if !repoInScope(gi.Repo, ti.Scopes) {
		return nil, listForIssueOutput{}, fmt.Errorf("repo %s not in key scope", gi.Repo)
	}
	var ids []int64
	if gi.FeedbackIDs != "" {
		_ = json.Unmarshal([]byte(gi.FeedbackIDs), &ids)
	}
	out := listForIssueOutput{IssueNumber: in.IssueNumber}
	for _, id := range ids {
		f, err := h.Store.Get(ctx, id)
		if err != nil {
			continue
		}
		out.Feedback = append(out.Feedback, feedbackRef{
			ID:            f.ID,
			Selector:      f.Selector,
			URL:           f.URL,
			Comment:       f.Comment,
			HasScreenshot: len(f.Screenshot) > 0,
			HasSnapshot:   len(f.Snapshot) > 0,
		})
	}
	return nil, out, nil
}
