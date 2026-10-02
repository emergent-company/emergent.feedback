// test/redact.test.ts — unit tests for the shared PII-redaction module.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./setup";
import { FakeElement } from "./setup";
import {
  redactText,
  redactPII,
  sanitizeURL,
  isSensitiveURLParam,
  redactAttributes,
  redactElementHTML,
} from "../src/redact";

test("redactText redacts token shapes and leaves normal prose untouched", () => {
  // JWT (two dot-separated segments each match the `eyJ…` shape)
  const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0";
  const jwtOut = redactText(`Bearer ${jwt}`);
  assert.ok(!jwtOut.includes("eyJ"), "JWT header leaked");
  assert.ok(jwtOut.includes("[redacted]"));

  // GitHub personal access token
  assert.equal(redactText("ghp_1234567890abcdef"), "[redacted]");

  // OpenAI API key
  assert.equal(redactText("sk-abcdef123456789"), "[redacted]");

  // Slack bot token
  assert.equal(redactText("xoxb-1234567890-abcdef"), "[redacted]");

  // Long random alphanumeric (≥40 chars)
  assert.equal(redactText("0123456789012345678901234567890123456789"), "[redacted]");

  // Normal prose must pass through unchanged
  const prose = "clicked the submit button on the checkout page";
  assert.equal(redactText(prose), prose);
});

test("redactPII redacts emails", () => {
  assert.equal(redactPII("reach me at jane.doe@example.com please"), "reach me at [redacted] please");
  assert.equal(redactPII("user+tag@sub.domain.co"), "[redacted]");
  assert.equal(redactPII("contact admin@example.org or support@foo-bar.io"), "contact [redacted] or [redacted]");
});

test("redactPII redacts SSNs", () => {
  assert.equal(redactPII("SSN is 123-45-6789 ok"), "SSN is [redacted] ok");
  assert.equal(redactPII("123-45-6789"), "[redacted]");
});

test("redactPII redacts phone numbers with separators/parens/country code", () => {
  assert.equal(redactPII("call 415-555-2671 now"), "call [redacted] now");
  assert.equal(redactPII("call (415) 555-2671 now"), "call [redacted] now");
  assert.equal(redactPII("call +1 (415) 555-2671 now"), "call [redacted] now");
  assert.equal(redactPII("call +44 20 7946 0958 now"), "call [redacted] now");
  assert.equal(redactPII("call 555.267.8910 now"), "call [redacted] now");
  assert.equal(redactPII("call +14155552671 now"), "call [redacted] now");
});

test("redactPII leaves short numbers, timestamps, versions, and plain digit runs", () => {
  assert.equal(redactPII("order 1234 shipped"), "order 1234 shipped");
  assert.equal(redactPII("zip 56789"), "zip 56789");
  assert.equal(redactPII("date 2024-01-15 fixed"), "date 2024-01-15 fixed");
  assert.equal(redactPII("ts 2026-10-02T16:11:00"), "ts 2026-10-02T16:11:00");
  assert.equal(redactPII("time 10:30:45"), "time 10:30:45");
  assert.equal(redactPII("version 1.2.3"), "version 1.2.3");
  assert.equal(redactPII("id 12345678"), "id 12345678");
  assert.equal(redactPII("ISBN 978-0-596-52068-7"), "ISBN 978-0-596-52068-7");
  assert.equal(redactPII("plain prose nothing here"), "plain prose nothing here");
});

test("redactPII still redacts token shapes via redactText", () => {
  assert.equal(redactPII("sk-abcdef123456789"), "[redacted]");
  assert.equal(redactPII("0123456789012345678901234567890123456789"), "[redacted]");
});

test("sanitizeURL scrubs sensitive query params and preserves the rest", () => {
  const out = sanitizeURL("https://example.com/cb?access_token=abcdef&page=2");
  assert.ok(out.includes("access_token=%5Bredacted%5D"), out);
  assert.ok(!out.includes("abcdef"), "token value leaked");
  assert.ok(out.includes("page=2"), "non-sensitive param dropped");

  assert.equal(sanitizeURL("https://x.com/?token=secret123"), "https://x.com/?token=%5Bredacted%5D");
  assert.equal(sanitizeURL("https://x.com/?auth=abc123"), "https://x.com/?auth=%5Bredacted%5D");

  // No sensitive params → returned unchanged (same reference semantics).
  const plain = "https://x.com/?page=2&q=hello";
  assert.equal(sanitizeURL(plain), plain);

  // Malformed URL must never leak — collapse to [redacted].
  assert.equal(sanitizeURL("http://"), "[redacted]");
});

test("isSensitiveURLParam flags token/key/secret/auth-style names only", () => {
  for (const k of ["access_token", "api_key", "client_secret", "auth", "sig", "session_id", "jwt", "csrf"]) {
    assert.ok(isSensitiveURLParam(k), `expected sensitive: ${k}`);
  }
  assert.ok(!isSensitiveURLParam("page"));
  assert.ok(!isSensitiveURLParam("q"));
});

test("redactAttributes drops sensitive names and token-shaped values", () => {
  const out = redactAttributes([
    { name: "password", value: "x" },
    { name: "data-token", value: "abc" },
    { name: "data-x", value: "sk-abcdef123456789" },
    { name: "title", value: "hello" },
  ]);
  assert.deepEqual(out, [{ name: "title", value: "hello" }]);
});

test("redactAttributes sanitizes href/src/action values", () => {
  const out = redactAttributes([
    { name: "href", value: "https://x.com/?token=abc" },
    { name: "src", value: "https://x.com/img.png" },
    { name: "action", value: "https://x.com/submit?auth=z" },
  ]);
  assert.deepEqual(out, [
    { name: "href", value: "https://x.com/?token=%5Bredacted%5D" },
    { name: "src", value: "https://x.com/img.png" },
    { name: "action", value: "https://x.com/submit?auth=%5Bredacted%5D" },
  ]);
});

test("redactElementHTML removes srcset, sensitive attrs, and sanitizes URLs", () => {
  const el = new FakeElement(
    "form",
    { action: "https://x.com/submit?token=abc", srcset: "a.png 1x, b.png 2x" },
    [new FakeElement("input", { password: "hunter2" })],
  );
  const out = redactElementHTML(el as unknown as Element);
  assert.ok(!out.includes("token=abc"), "URL token leaked");
  assert.ok(out.includes("token=%5Bredacted%5D"), "URL not sanitized");
  assert.ok(!out.includes("srcset"), "srcset not removed");
  assert.ok(!out.includes("password"), "sensitive attr not removed");
  assert.ok(!out.includes("hunter2"), "sensitive value leaked");
});

test("redactElementHTML returns empty string on error", () => {
  assert.equal(redactElementHTML({} as unknown as Element), "");
});
