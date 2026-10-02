package handler

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

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

func redactedFixture(t *testing.T) store.Feedback {
	t.Helper()
	ctx := map[string]any{
		"url": "https://app.example.com/confirm?token=eyJhbGciOiJIUzI1NiJ9.abc.def",
		"intent": map[string]any{
			"kind":     "bug",
			"action":   "change",
			"expected": "text passes contrast",
			"actual":   "text color: sk-abcdefghijklmnop",
			"scope":    map[string]any{"breadth": "element", "targets": []any{"[data-x='sk-abcdefghijklmnop']"}},
		},
	}
	ctxJSON, err := json.Marshal(ctx)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return store.Feedback{
		ID:          1,
		URL:         "https://app.example.com/confirm?token=eyJhbGciOiJIUzI1NiJ9.abc.def",
		Selector:    "button",
		Comment:     "broken",
		ContextJSON: string(ctxJSON),
		GitHubUser:  "alice",
		CreatedAt:   time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC),
	}
}

func TestEnvelopeRedactsURLAndIntent(t *testing.T) {
	f := redactedFixture(t)

	full := BuildEnvelope(f)
	concise := BuildConciseEnvelope(f)

	// Full envelope: environment.url is URL-param-scrubbed.
	envn := getMap(full, "environment")
	if !strings.Contains(strVal(envn["url"]), "token=[redacted]") {
		t.Fatalf("environment.url not scrubbed: %v", envn["url"])
	}

	for name, env := range map[string]map[string]any{"full": full, "concise": concise} {
		b, _ := json.Marshal(env)
		s := string(b)
		if strings.Contains(s, "eyJhbGci") {
			t.Fatalf("%s envelope leaked URL token: %s", name, s)
		}
		if strings.Contains(s, "sk-abcdefghijklmnop") {
			t.Fatalf("%s envelope leaked sk- key: %s", name, s)
		}
		intent := getMap(env, "intent")
		if !strings.Contains(strVal(intent["actual"]), "[redacted]") {
			t.Fatalf("%s intent.actual not redacted: %v", name, intent)
		}
	}
}

func TestBuildIssueContentRedactsURLAndIntent(t *testing.T) {
	f := redactedFixture(t)
	_, body := buildIssueContent([]store.Feedback{f}, "")

	if strings.Contains(body, "eyJhbGci") {
		t.Fatalf("URL token leaked into issue body:\n%s", body)
	}
	if strings.Contains(body, "sk-abcdefghijklmnop") {
		t.Fatalf("intent secret leaked into issue body:\n%s", body)
	}
	if !strings.Contains(body, "token=[redacted]") {
		t.Fatalf("URL param not scrubbed in issue body:\n%s", body)
	}
}
