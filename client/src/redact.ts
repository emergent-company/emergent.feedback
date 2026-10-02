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

// ── Content-shape PII (free text) ───────────────────────────────────────────
//
// `redactText` only catches token-shaped strings. `redactPII` additionally
// catches content that *looks* like PII regardless of the field it landed in
// (an email typed into a generic text field, a phone number in a button label,
// an SSN in a console message). Names are deliberately NOT detected — matching
// human names reliably is impossible without heavy false positives.
//
// WHERE TO USE: user-captured free text only — session-history input/select
// values and click labels, plus console messages/stack_text. Do NOT blanket-
// apply to issue bodies or docs, where a stray email/phone is often legitimate
// content that would get mangled.

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
// Phone candidates: optional `+country`, optional `(area)` or area, then two
// digit groups separated by space/dot/hyphen/parens. The `≥8 digits` and
// `has-a-separator` checks run in the replace callback (below) so a bare digit
// run (IDs, amounts, and the 40-char tokens already eaten by `redactText`)
// never matches.
const PHONE_RE =
  /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\d{2,4}[\s.-]?)\d{3,4}[\s.-]?\d{3,4}/g;

function phoneDigits(s: string): number {
  let n = 0;
  for (const ch of s) if (ch >= "0" && ch <= "9") n++;
  return n;
}

/**
 * Redact free text: token shapes (via `redactText`) plus content-shaped PII —
 * email addresses, SSNs, and phone numbers. Names are intentionally NOT
 * detected. Pure and DOM-free.
 */
export function redactPII(text: string): string {
  let out = redactText(text);
  out = out.replace(EMAIL_RE, "[redacted]");
  out = out.replace(SSN_RE, "[redacted]");
  out = out.replace(PHONE_RE, (m) => (phoneDigits(m) >= 8 && /[()+\s.-]/.test(m) ? "[redacted]" : m));
  return out;
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

/**
 * Serialize an element to redacted HTML without mutating the live page.
 * Mirrors snapshot.ts's redaction pass exactly on a clone:
 *   - `src`/`href`/`action` URLs are sanitized (sensitive query params → `[redacted]`)
 *   - `srcset` is removed
 *   - attributes matching SENSITIVE_ATTR or whose value matches TOKEN_VALUE are dropped
 *   - token-shaped substrings in the serialized output are replaced with `[redacted]`
 * Returns "" on any error so callers never ship unredacted HTML.
 */
export function redactElementHTML(el: Element): string {
  try {
    const clone = el.cloneNode(true) as Element;

    const redactNode = (node: Element): void => {
      for (const attr of Array.from(node.attributes)) {
        const name = attr.name;
        const value = attr.value;
        if (name === "src" || name === "href" || name === "action") {
          node.setAttribute(name, sanitizeURL(value));
          continue;
        }
        if (name === "srcset") {
          node.removeAttribute(name);
          continue;
        }
        if (SENSITIVE_ATTR.test(name) || TOKEN_VALUE.test(value)) {
          node.removeAttribute(name);
        }
      }
    };

    redactNode(clone);
    clone.querySelectorAll("*").forEach(redactNode);

    return redactText(clone.outerHTML);
  } catch {
    return "";
  }
}
