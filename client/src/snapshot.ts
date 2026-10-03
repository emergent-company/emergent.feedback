// snapshot.ts — full-page DOM snapshot capture with PII redaction.

const MAX_BYTES = 2_000_000; // skip if redacted HTML exceeds this

const SENSITIVE_ATTR = /(token|secret|password|passwd|pwd|credential|api[_-]?key|apikey|authorization|jwt|csrf|cookie|sessionid)/i;
const TOKEN_VALUE = /(eyJ[a-zA-Z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|sk-[A-Za-z0-9]{8,}|xox[bp]-[A-Za-z0-9-]{8,}|[A-Za-z0-9_-]{40,})/;

function isSensitiveURLParam(key: string): boolean {
  return /(token|key|secret|sig|signature|auth|credential|password|session|jwt|csrf)/i.test(key);
}

function sanitizeURL(raw: string): string {
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

export function captureSnapshot(): string | undefined {
  try {
    const root = document.documentElement.cloneNode(true) as HTMLElement;

    // Remove heavy / risky subtrees entirely.
    root.querySelectorAll("script, style, noscript, link[rel='stylesheet'], iframe").forEach((n) => n.remove());

    // Clear typed text.
    root.querySelectorAll("textarea").forEach((n) => { n.textContent = ""; });
    root.querySelectorAll("[contenteditable]").forEach((n) => { n.textContent = ""; });
    root.querySelectorAll("input, select").forEach((el) => {
      el.removeAttribute("value");
      el.removeAttribute("checked");
      el.removeAttribute("selected");
    });

    // Strip sensitive attributes + sanitize URLs.
    root.querySelectorAll("*").forEach((el) => {
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name;
        const value = attr.value;
        if (name === "src" || name === "href" || name === "action") {
          el.setAttribute(name, sanitizeURL(value));
          continue;
        }
        if (name === "srcset") {
          el.removeAttribute(name);
          continue;
        }
        if (SENSITIVE_ATTR.test(name) || TOKEN_VALUE.test(value)) {
          el.removeAttribute(name);
        }
      }
    });

    // Remove the overlay's own injected DOM.
    root.querySelectorAll("[id^='__ef_']").forEach((n) => n.remove());

    const html = root.outerHTML;
    if (html.length > MAX_BYTES) return undefined;
    return html;
  } catch {
    return undefined;
  }
}
