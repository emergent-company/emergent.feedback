// snapshot.ts — full-page DOM snapshot capture with PII redaction.

import { SENSITIVE_ATTR, TOKEN_VALUE, sanitizeURL, redactText } from "./redact";

const MAX_BYTES = 2_000_000; // skip if redacted HTML exceeds this

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
    const redacted = redactText(html);
    if (redacted.length > MAX_BYTES) return undefined;
    return redacted;
  } catch {
    return undefined;
  }
}
