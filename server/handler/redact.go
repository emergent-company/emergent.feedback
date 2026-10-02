package handler

import (
	"net/url"
	"regexp"
)

// Server-side secret redaction. Mirrors the client's redact.ts rules so a user
// comment is scrubbed before it reaches the public GitHub issue body or any
// LLM prompt. The definitions intentionally match the client TOKEN_VALUE,
// SENSITIVE_ATTR, and isSensitiveURLParam shapes.

var (
	// tokenValueRe matches token-shaped values: JWTs (header.payload.signature),
	// GitHub/OpenAI/Slack tokens, and long random strings (same shape as the
	// client TOKEN_VALUE).
	tokenValueRe = regexp.MustCompile(`eyJ[a-zA-Z0-9_-]{8,}(?:\.[a-zA-Z0-9_-]+){0,2}|gh[pousr]_[A-Za-z0-9]{8,}|sk-[A-Za-z0-9]{8,}|xox[bp]-[A-Za-z0-9-]{8,}|[A-Za-z0-9_-]{40,}`)

	// urlRe matches http(s) URLs embedded in free text (same shape as the
	// client's URL sanitizer).
	urlRe = regexp.MustCompile(`https?://[^\s"'<>)]+`)

	// sensitiveParamRe names URL query params whose values must be scrubbed.
	sensitiveParamRe = regexp.MustCompile(`(?i)^(token|key|secret|sig|signature|auth|credential|password|session|jwt|csrf)$`)

	// sensitiveAssignmentRe matches a secret assignment in free text, e.g.
	// `api_key=...`, `password: "..."`. The value is replaced with [redacted]
	// while the key, delimiter, and quoting are kept. (Authorization headers are
	// intentionally excluded: their token is already redacted by tokenValueRe.)
	sensitiveAssignmentRe = regexp.MustCompile(`(?i)(\b(?:token|secret|password|passwd|pwd|credential|api[_-]?key|apikey|jwt|csrf|access[_-]?token|refresh[_-]?token|client[_-]?secret|session)\b\s*[=:]\s*["']?)[^\s"'&,;]+`)
)

// redactSecrets scrubs secrets from free text. It mirrors the client pipeline:
// sensitive URL query params are redacted, then token-shaped values and secret
// assignments are replaced with [redacted].
func redactSecrets(s string) string {
	if s == "" {
		return s
	}
	s = scrubURLParams(s)
	s = tokenValueRe.ReplaceAllString(s, "[redacted]")
	s = sensitiveAssignmentRe.ReplaceAllString(s, `${1}[redacted]`)
	return s
}

// scrubURLParams replaces sensitive query-param values in embedded URLs with
// [redacted]. Non-parseable URLs are left untouched.
func scrubURLParams(s string) string {
	return urlRe.ReplaceAllStringFunc(s, func(raw string) string {
		u, err := url.Parse(raw)
		if err != nil {
			return raw
		}
		changed := false
		q := u.Query()
		for k := range q {
			if sensitiveParamRe.MatchString(k) {
				q.Set(k, "[redacted]")
				changed = true
			}
		}
		if !changed {
			return raw
		}
		u.RawQuery = q.Encode()
		return u.String()
	})
}
