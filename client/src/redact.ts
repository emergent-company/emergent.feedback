// redact.ts — single source of truth for PII redaction.
//
// Shared by snapshot.ts, index.ts (gatherContext/gatherAttributes), and
// console.ts. Rules are identical to the historical copies in snapshot.ts so
// what gets redacted does not change — only the definitions move here.

/** Attribute-name signal that an attribute holds a secret and must be dropped. */
export const SENSITIVE_ATTR =
  /(token|secret|password|passwd|pwd|credential|api[_-]?key|apikey|authorization|jwt|csrf|cookie|sessionid)/i;

/** Value shapes that look like a live token/secret (JWT, GitHub, OpenAI, Slack, long random). */
export const TOKEN_VALUE =
  /(eyJ[a-zA-Z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|sk-[A-Za-z0-9]{8,}|xox[bp]-[A-Za-z0-9-]{8,}|[A-Za-z0-9_-]{40,})/;

/** URL query-parameter names whose values must be scrubbed. */
export function isSensitiveURLParam(key: string): boolean {
  return /(token|key|secret|sig|signature|auth|credential|password|session|jwt|csrf)/i.test(key);
}

/**
 * Sanitize a URL by replacing sensitive query-param values with `[redacted]`.
 * Returns the input unchanged when nothing changed, or `[redacted]` when the
 * string is not a parseable URL (so a broken URL never leaks through).
 */
export function sanitizeURL(raw: string): string {
  try {
    const u = new URL(raw, document.baseURI);
    let changed = false;
    for (const key of Array.from(u.searchParams.keys())) {
      if (isSensitiveURLParam(key)) {
        u.searchParams.set(key, "[redacted]");
        changed = true;
      }
    }
    return changed ? u.href : raw;
  } catch {
    return "[redacted]";
  }
}

const TOKEN_VALUE_GLOBAL = new RegExp(TOKEN_VALUE.source, "g");

/** Replace token-shaped substrings in free text with `[redacted]`. */
export function redactText(s: string): string {
  return s.replace(TOKEN_VALUE_GLOBAL, "[redacted]");
}

/** A single attribute name/value pair (agnostic to DOM structure). */
export interface AttrKV {
  name: string;
  value: string;
}

/**
 * Apply the shared redaction pass to a set of attributes, returning the kept
 * list (order preserved). Rules:
 *   - `src`/`href`/`action` values are URL-sanitized, then dropped if a token
 *     survives sanitization.
 *   - attributes whose NAME matches SENSITIVE_ATTR are dropped.
 *   - attributes whose VALUE matches TOKEN_VALUE are dropped.
 *
 * `srcset` is intentionally NOT handled here — it is a structural removal
 * specific to snapshot.ts, not a secret-redaction rule.
 */
export function redactAttributes(attrs: Iterable<AttrKV>): AttrKV[] {
  const out: AttrKV[] = [];
  for (const { name, value } of attrs) {
    if (name === "src" || name === "href" || name === "action") {
      const sanitized = sanitizeURL(value);
      if (TOKEN_VALUE.test(sanitized)) continue; // token survived → drop
      out.push({ name, value: sanitized });
      continue;
    }
    if (SENSITIVE_ATTR.test(name) || TOKEN_VALUE.test(value)) continue;
    out.push({ name, value });
  }
  return out;
}
