package handler

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"sort"
	"time"

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

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "feedback_get",
		Description: "Return the full feedback envelope (schema, target, intent, provenance, trust order) for a feedback item; requires API-key authentication and repo scope.",
	}, h.toolFeedbackGet)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "feedback_list",
		Description: "List exported feedback items within the key's repo scope, sorted by source confidence (exact first); optional filters for repo, status, type, and since.",
	}, h.toolFeedbackList)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "feedback_mark_applied",
		Description: "Record that a fix was applied to a feedback item; requires API-key authentication and repo scope.",
	}, h.toolMarkApplied)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "feedback_mark_resolved",
		Description: "Record that a feedback item is resolved; requires API-key authentication and repo scope.",
	}, h.toolMarkResolved)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "feedback_verify",
		Description: "Return the verification contract and last result for a feedback item; requires API-key authentication and repo scope.",
	}, h.toolFeedbackVerify)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "feedback_watch",
		Description: "Long-poll for lifecycle events (applied/verified/resolved/open) since a sequence number; requires API-key authentication and repo scope.",
	}, h.toolFeedbackWatch)

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

// toolFeedbackGet returns the full envelope for a single feedback item.
// The output is a dynamic map (Out = any) so the SDK skips schema generation.
func (h *Handler) toolFeedbackGet(ctx context.Context, _ *mcp.CallToolRequest, in feedbackIDInput) (*mcp.CallToolResult, any, error) {
	f, err := h.scopedFeedback(ctx, in.FeedbackID)
	if err != nil {
		return nil, nil, err
	}
	return nil, BuildEnvelope(f), nil
}

type feedbackListInput struct {
	Repo   string `json:"repo,omitempty" jsonschema:"optional repo filter"`
	Status string `json:"status,omitempty" jsonschema:"optional status filter (open|applied|resolved|verified)"`
	Type   string `json:"type,omitempty" jsonschema:"optional type filter (bug|enhancement|question|task)"`
	Since  string `json:"since,omitempty" jsonschema:"optional RFC3339 timestamp"`
}

type feedbackListItem struct {
	ID               int64  `json:"id"`
	Summary          string `json:"summary"`
	Type             string `json:"type"`
	Status           string `json:"status"`
	SourceConfidence string `json:"source_confidence"`
	IssueURL         string `json:"issue_url"`
}

// toolFeedbackList lists exported feedback for the key's repo scope via a
// lightweight store query (no screenshot/snapshot blobs), then sorts by source
// confidence descending (exact first).
func (h *Handler) toolFeedbackList(ctx context.Context, _ *mcp.CallToolRequest, in feedbackListInput) (*mcp.CallToolResult, []feedbackListItem, error) {
	ti := auth.TokenInfoFromContext(ctx)
	if ti == nil {
		return nil, nil, fmt.Errorf("unauthenticated")
	}

	var repos []string
	if in.Repo != "" {
		if !repoInScope(in.Repo, ti.Scopes) {
			return nil, nil, fmt.Errorf("repo %s not in key scope", in.Repo)
		}
		repos = []string{in.Repo}
	} else {
		repos = ti.Scopes
	}

	items, err := h.Store.ListExportedLite(ctx, repos)
	if err != nil {
		return nil, nil, err
	}

	var since time.Time
	if in.Since != "" {
		since, err = time.Parse(time.RFC3339, in.Since)
		if err != nil {
			return nil, nil, fmt.Errorf("invalid since: %v", err)
		}
	}

	out := make([]feedbackListItem, 0, len(items))
	for _, it := range items {
		f := store.Feedback{Status: it.Status, IssueURL: it.IssueURL, Label: it.Label, Comment: it.Comment}
		status := deriveStatus(f)
		if in.Status != "" && status != in.Status {
			continue
		}
		if !since.IsZero() && it.CreatedAt.Before(since) {
			continue
		}
		c := parseContext(it.ContextJSON)
		typ := deriveType(c, f)
		if in.Type != "" && typ != in.Type {
			continue
		}
		out = append(out, feedbackListItem{
			ID:               it.ID,
			Summary:          deriveSummary(c, f),
			Type:             typ,
			Status:           status,
			SourceConfidence: sourceConfidence(c),
			IssueURL:         it.IssueURL,
		})
	}

	sort.SliceStable(out, func(i, j int) bool {
		return confidenceRank(out[i].SourceConfidence) > confidenceRank(out[j].SourceConfidence)
	})

	return nil, out, nil
}

type markInput struct {
	FeedbackID int64  `json:"feedback_id" jsonschema:"the feedback row id"`
	Summary    string `json:"summary,omitempty" jsonschema:"optional summary to record"`
}

type markOutput struct {
	ID     int64  `json:"id"`
	Status string `json:"status"`
}

func (h *Handler) toolMarkApplied(ctx context.Context, _ *mcp.CallToolRequest, in markInput) (*mcp.CallToolResult, markOutput, error) {
	if _, err := h.scopedFeedback(ctx, in.FeedbackID); err != nil {
		return nil, markOutput{}, err
	}
	if err := h.Store.SetStatus(ctx, in.FeedbackID, store.StatusApplied, "", in.Summary); err != nil {
		return nil, markOutput{}, err
	}
	return nil, markOutput{ID: in.FeedbackID, Status: string(store.StatusApplied)}, nil
}

func (h *Handler) toolMarkResolved(ctx context.Context, _ *mcp.CallToolRequest, in markInput) (*mcp.CallToolResult, markOutput, error) {
	if _, err := h.scopedFeedback(ctx, in.FeedbackID); err != nil {
		return nil, markOutput{}, err
	}
	if err := h.Store.SetStatus(ctx, in.FeedbackID, store.StatusResolved, "", in.Summary); err != nil {
		return nil, markOutput{}, err
	}
	return nil, markOutput{ID: in.FeedbackID, Status: string(store.StatusResolved)}, nil
}

type feedbackVerifyOutput struct {
	Status     string `json:"status"`
	Contract   any    `json:"contract"`
	LastResult string `json:"last_result"`
	LastDetail string `json:"last_detail"`
}

func (h *Handler) toolFeedbackVerify(ctx context.Context, _ *mcp.CallToolRequest, in feedbackIDInput) (*mcp.CallToolResult, feedbackVerifyOutput, error) {
	f, err := h.scopedFeedback(ctx, in.FeedbackID)
	if err != nil {
		return nil, feedbackVerifyOutput{}, err
	}

	c := parseContext(f.ContextJSON)
	var contract any
	if v, ok := c["verification"].(map[string]any); ok {
		contract = v["contract"]
	}
	out := feedbackVerifyOutput{
		Status:     string(f.Status),
		Contract:   contract,
		LastResult: f.VerificationResult,
		LastDetail: f.VerificationDetail,
	}

	if isHumanContract(contract) {
		instruction := "This feedback's verification contract is `human`: ask the reporter to confirm the fix, then call feedback_mark_resolved (or POST /feedback/:id/verify-result with result=green)."
		res := &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: instruction}}}
		return res, out, nil
	}
	return nil, out, nil
}

func isHumanContract(contract any) bool {
	m, ok := contract.(map[string]any)
	if !ok {
		return false
	}
	return asString(m["kind"]) == "human"
}

type feedbackWatchInput struct {
	SinceSeq    int64 `json:"since_seq,omitempty" jsonschema:"resume from this event sequence (0 = from the beginning)"`
	WaitSeconds int   `json:"wait_seconds,omitempty" jsonschema:"max seconds to wait for events (capped at 25)"`
}

type feedbackEventOutput struct {
	Seq        int64  `json:"seq"`
	FeedbackID int64  `json:"feedback_id"`
	Type       string `json:"type"`
	Actor      string `json:"actor"`
	Detail     string `json:"detail"`
	CreatedAt  string `json:"created_at"`
}

type feedbackWatchOutput struct {
	Events  []feedbackEventOutput `json:"events"`
	NextSeq int64                 `json:"next_seq"`
}

func (h *Handler) toolFeedbackWatch(ctx context.Context, _ *mcp.CallToolRequest, in feedbackWatchInput) (*mcp.CallToolResult, feedbackWatchOutput, error) {
	ti := auth.TokenInfoFromContext(ctx)
	if ti == nil {
		return nil, feedbackWatchOutput{}, fmt.Errorf("unauthenticated")
	}

	wait := in.WaitSeconds
	if wait < 0 {
		wait = 0
	}
	if wait > 25 {
		wait = 25
	}
	since := in.SinceSeq
	deadline := time.Now().Add(time.Duration(wait) * time.Second)

	for {
		var events []store.FeedbackEvent
		var err error
		if repoInScope("*", ti.Scopes) {
			events, err = h.Store.ListEventsSince(ctx, since, 200)
		} else {
			events, err = h.Store.ListEventsSinceForRepos(ctx, since, 200, ti.Scopes)
		}
		if err != nil {
			return nil, feedbackWatchOutput{}, err
		}
		if len(events) > 0 {
			return nil, watchOutput(events), nil
		}
		if time.Now().After(deadline) {
			return nil, feedbackWatchOutput{Events: []feedbackEventOutput{}, NextSeq: since}, nil
		}
		select {
		case <-ctx.Done():
			return nil, feedbackWatchOutput{}, ctx.Err()
		case <-time.After(400 * time.Millisecond):
		}
	}
}

func watchOutput(events []store.FeedbackEvent) feedbackWatchOutput {
	out := feedbackWatchOutput{Events: make([]feedbackEventOutput, 0, len(events))}
	for _, e := range events {
		out.Events = append(out.Events, feedbackEventOutput{
			Seq:        e.Seq,
			FeedbackID: e.FeedbackID,
			Type:       e.Type,
			Actor:      e.Actor,
			Detail:     e.Detail,
			CreatedAt:  e.CreatedAt.UTC().Format(time.RFC3339),
		})
		out.NextSeq = e.Seq
	}
	return out
}
