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

func TestRedactSecretsSensitiveParamSubstrings(t *testing.T) {
	// Suffixed/prefixed param names must be scrubbed, matching the client's
	// substring isSensitiveURLParam check (not an exact-key match).
	in := "see https://app.example.com/path?access_token=abc123&refresh_token=def456&other=1 for details"
	out := redactSecrets(in)
	for _, leak := range []string{"abc123", "def456"} {
		if strings.Contains(out, leak) {
			t.Fatalf("sensitive param value leaked: %s", out)
		}
	}
	for _, want := range []string{"access_token=[redacted]", "refresh_token=[redacted]"} {
		if !strings.Contains(out, want) {
			t.Fatalf("expected %q in: %s", want, out)
		}
	}
}

func TestRedactSecretsPreservesHexSHA(t *testing.T) {
	// A 40-char pure-hex commit SHA must survive redaction.
	sha := "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"
	if len(sha) != 40 {
		t.Fatalf("test fixture not 40 chars: %d", len(sha))
	}
	in := "commit " + sha + " fixes it"
	if got := redactSecrets(in); !strings.Contains(got, sha) {
		t.Fatalf("40-char hex SHA was redacted: %s", got)
	}
}

func TestRedactSecretsStillRedactsLongNonHex(t *testing.T) {
	// A 40-char string containing a non-hex char, and strings longer than 40,
	// must still be redacted.
	cases := []string{
		strings.Repeat("z", 40),                        // 40 chars, non-hex
		"a1b2c3d4e5f60718293a4b5c6d7e8f90123456789", // 41 hex chars
	}
	for _, in := range cases {
		if got := redactSecrets(in); !strings.Contains(got, "[redacted]") {
			t.Fatalf("expected redaction for %q, got %q", in, got)
		}
	}
}
