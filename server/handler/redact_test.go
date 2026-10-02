package handler

import (
	"strings"
	"testing"

	"github.com/emergent-company/emergent.feedback/server/store"
)

func TestRedactSecrets(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "jwt",
			in:   "my token is eyJhbGciOiJIUzI1NiJ9.abc.def please",
			want: "my token is [redacted] please",
		},
		{
			name: "github token",
			in:   "use ghp_AbCdEfGhIjKlMnOpQrSt",
			want: "use [redacted]",
		},
		{
			name: "openai token",
			in:   "key sk-abcdefgh12345678 leaked",
			want: "key [redacted] leaked",
		},
		{
			name: "slack token",
			in:   "xoxb-12345678-abcdefgh-ijklmnop here",
			want: "[redacted] here",
		},
		{
			name: "sensitive url param",
			in:   "see https://app.example.com/path?token=secretvalue&other=1 for details",
			want: "see https://app.example.com/path?other=1&token=[redacted] for details",
		},
		{
			name: "api key assignment",
			in:   "the api_key=abcdef123456 is wrong",
			want: "the api_key=[redacted] is wrong",
		},
		{
			name: "authorization header",
			in:   "Authorization: Bearer ghp_AbCdEfGhIjKlMnOpQrSt",
			want: "Authorization: Bearer [redacted]",
		},
		{
			name: "normal prose untouched",
			in:   "the button contrast is bad and needs fixing",
			want: "the button contrast is bad and needs fixing",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := redactSecrets(c.in); got != c.want {
				t.Fatalf("redactSecrets(%q) = %q, want %q", c.in, got, c.want)
			}
		})
	}
}

func TestBuildIssueContentRedactsComment(t *testing.T) {
	items := []store.Feedback{{
		ID:          1,
		URL:         "https://app.example.com/",
		Selector:    "button",
		Comment:     "broken: token=ghp_AbCdEfGhIjKlMnOpQrSt and eyJhbGciOiJIUzI1NiJ9.abc.def",
		ContextJSON: "{}",
		GitHubUser:  "alice",
	}}
	_, body := buildIssueContent(items, "")
	if strings.Contains(body, "ghp_AbCdEfGhIjKlMnOpQrSt") || strings.Contains(body, "eyJhbGciOiJIUzI1NiJ9") {
		t.Fatalf("comment secret leaked into issue body:\n%s", body)
	}
	if !strings.Contains(body, "[redacted]") {
		t.Fatalf("expected redacted marker in body:\n%s", body)
	}
}

func TestTitlePromptRedactsComment(t *testing.T) {
	p := titlePrompt(nil, store.Feedback{Comment: "token ghp_AbCdEfGhIjKlMnOpQrSt broke"})
	if strings.Contains(p, "ghp_AbCdEfGhIjKlMnOpQrSt") {
		t.Fatalf("comment secret leaked into LLM prompt: %q", p)
	}
	if !strings.Contains(p, "[redacted]") {
		t.Fatalf("expected redacted marker in prompt: %q", p)
	}
}
