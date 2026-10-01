package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"time"

	"github.com/emergent-company/emergent.feedback/server/store"
)

// notifyReporter posts a lifecycle event to the optional FEEDBACK_NOTIFY_WEBHOOK.
// Best-effort: any error/timeout is swallowed; 2s cap.
func (h *Handler) notifyReporter(event, status string, f store.Feedback) {
	url := os.Getenv("FEEDBACK_NOTIFY_WEBHOOK")
	if url == "" {
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	payload := map[string]any{
		"event":     event,
		"id":        f.ID,
		"status":    status,
		"selector":  f.Selector,
		"page_url":  f.URL,
		"issue_url": f.IssueURL,
	}
	body, _ := json.Marshal(payload)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return
	}
	defer func() { _ = resp.Body.Close() }()
}

// fireNotify launches notifyReporter asynchronously (fire-and-forget).
func (h *Handler) fireNotify(event, status string, f store.Feedback) {
	go h.notifyReporter(event, status, f)
}
